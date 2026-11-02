/*!
 * dsh-memory-rules — end-to-end flow check.
 *
 * One session's whole life, through the real plugin, then judged by the
 * read-only doctor:
 *
 *   turn/end + idle  →  extraction stores facts (and skips the junk)
 *   agent/pre-step   →  the stored facts are recalled into the next turn
 *   memory_write     →  an explicit note lands in the store
 *   memory_reflect   →  three same-topic facts consolidate into a belief
 *   memory_export    →  the human-readable view is written
 *   doctor           →  the resulting store passes its own health check
 *
 * The point is that the last step is an independent program looking at the
 * artifacts the earlier steps produced; nothing here asserts against in-memory
 * state that the flow never wrote.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../lib/plugin.js'
import { openMemoryService } from '../lib/service.js'
import { renderDoctor, runDoctor } from '../tools/doctor.mjs'
import { tempDir } from './helpers.js'
const PKG_DIR = path.join(import.meta.dirname, '..')

/** The fake host from the step-4 check, kept identical so both see one contract. */
function fakeHost() {
  const toolRegistry = new Map()
  const promptContexts = []
  const listeners = []
  const logs = []
  const services = new Map()
  return {
    tools: {
      register(tool) {
        toolRegistry.set(tool.name, tool)
        return () => toolRegistry.delete(tool.name)
      }
    },
    systemPrompt: {
      context(entry) {
        promptContexts.push(entry)
        return () => {}
      }
    },
    on(name, handler, options) {
      listeners.push({ name, handler, options })
      return () => {}
    },
    provide(name, value) {
      services.set(name, value)
      return () => services.delete(name)
    },
    effect() {
      return () => {}
    },
    logger: { info: (m) => logs.push(`info: ${m}`), warn: (m) => logs.push(`warn: ${m}`), debug() {}, error: (m) => logs.push(`error: ${m}`) },
    toolRegistry,
    promptContexts,
    listeners,
    logs,
    services,
    emit(name, ...args) {
      for (const entry of listeners) if (entry.name === name) entry.handler(...args)
    },
    async waterfall(name, payload, terminal) {
      const chain = listeners.filter((entry) => entry.name === name).map((entry) => entry.handler)
      const dispatch = async (index, current) =>
        index >= chain.length ? terminal(current) : chain[index](current, () => dispatch(index + 1, current))
      return dispatch(0, payload)
    }
  }
}

/** One turn's derived history, as the harness would present it. */
function sessionWith(id, messages) {
  return { id, header: { cwd: 'C:\\ws' }, deriveMessages: () => messages }
}

const text = (value) => [{ type: 'text', text: value }]

/** Wait for a condition, or fail the test with the collected logs. */
async function waitFor(predicate, host, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

test('end-to-end: one session produces a healthy store', async () => {
  const dir = tempDir('e2e')
  const dbFile = path.join(dir, 'memory.db')
  const host = fakeHost()
  apply(host, { memoryDir: dir, dbFile, reflectEnabled: false, markdownMirror: true, ingestAssistant: false })

  assert.ok(
    await waitFor(() => host.toolRegistry.size > 0, host),
    `the plugin must register its tools; logs: ${host.logs.join(' | ')}`
  )

  // --- turn 1: a spoken user turn plus the harness's injected context --------
  const session = sessionWith('session-e2e', [
    { role: 'user', content: text('Current runtime context. This snapshot supersedes earlier snapshots. <available_skills>'), source: { kind: 'user' } },
    { role: 'user', content: text('用户决定把记忆库的数据库换成 SQLite，因为 Markdown 检索太慢了。'), source: { kind: 'user' } },
    { role: 'assistant', content: text('所以结论是：优先使用 node:sqlite。'), source: { kind: 'assistant' } },
    { role: 'user', content: text('记忆库使用 SQLite 存储全部证据。'), source: { kind: 'user' } },
    { role: 'user', content: text('记忆库使用 SQLite 的 WAL 模式提高并发。'), source: { kind: 'user' } },
    { role: 'user', content: text('记忆库使用 SQLite 的备份接口。'), source: { kind: 'user' } }
  ])
  host.emit('session/event', session, { type: 'turn/end', seq: 7, data: { turn: 1 } })
  host.emit('agent/status', { agent: { session }, status: 'idle' })

  const service = await openMemoryService({ memoryDir: dir, dbFile, logger: { info() {}, warn() {}, debug() {}, error() {} }, markdownMirror: false })
  assert.ok(
    await waitFor(async () => (await service.counts()).facts >= 4, host),
    `the idle flush must store the spoken turns; logs: ${host.logs.join(' | ')}`
  )

  // --- what the flow must NOT have stored -----------------------------------
  const stored = await service.allFacts({ includeSuperseded: true })
  for (const fact of stored) {
    assert.doesNotMatch(fact.content, /available_skills|Current runtime context/, 'injected context must not be stored')
    assert.doesNotMatch(fact.content, /^所以结论是/, 'assistant prose is off by default')
    assert.ok(fact.rawQuote !== null, 'every stored fact keeps its source sentence')
    assert.ok(Array.isArray(fact.embedding) && fact.embedding.length > 0, 'every stored fact is embedded')
  }
  // --- and what it must have stored -----------------------------------------
  assert.ok(stored.some((fact) => /SQLite/.test(fact.content)), 'the storage decision must be stored')
  const meta = Object.fromEntries((await service.allMeta()).map((row) => [row.key, row.value]))
  assert.ok(meta['heartbeat:turn-end'], 'the turn-end heartbeat must be recorded')
  assert.ok(meta['heartbeat:idle'], 'the idle heartbeat must be recorded')

  // --- turn 2: the stored memory is recalled --------------------------------
  const decision = await host.waterfall('agent/pre-step', { agent: { session }, turn: 2, step: 1 }, () => ({
    kind: 'enter',
    messages: [{ role: 'user', content: text('记忆库用什么数据库？'), source: { kind: 'user' } }]
  }))
  assert.equal(decision.messages.length, 2, 'turn 2 must receive a recall block')
  const block = decision.messages[0].content[0].text
  assert.match(block, /<user_long_term_memories/)
  assert.match(block, /SQLite/, 'the recall block must carry the stored fact')
  assert.match(block, /四路命中/, 'the block must report which paths contributed')

  // --- an explicit note, then consolidation ---------------------------------
  const written = await host.toolRegistry
    .get('memory_write')
    .execute({ content: 'dsh-memory-rules 的记忆库固定在 ~/.dsh/memory/memory.db', layer: 'world', tags: ['config'] })
  assert.equal(written.ok, true)

  const reflected = await host.toolRegistry.get('memory_reflect').execute({ period: '2026-10-15', force: true })
  assert.equal(reflected.ok, true)
  assert.ok(reflected.stats.created >= 1, `expected a belief, got ${JSON.stringify(reflected.stats)}`)
  const beliefs = await service.allBeliefs()
  assert.ok(beliefs.length >= 1)
  assert.ok(beliefs[0].evidenceCount >= 3, 'the belief must cite its evidence')

  // --- export ----------------------------------------------------------------
  const exported = await host.toolRegistry.get('memory_export').execute({ dir: path.join(dir, 'export') })
  assert.equal(exported.ok, true)
  for (const file of exported.files) assert.ok(fs.statSync(file).size > 0, `${file} must not be empty`)
  assert.match(fs.readFileSync(path.join(dir, 'export', 'facts.md'), 'utf8'), /世界事实 world/)

  // --- the independent verdict ----------------------------------------------
  // `runDoctor` is called in-process rather than spawned: a sandbox may forbid
  // a child process with piped stdio, and the doctor is designed to be imported
  // for exactly this reason. The `--against` file comparison is deliberately
  // left off here — it reads the *installed* tree, which a sandbox may deny, and
  // it is already covered by the manifest smoke test.
  const report = await runDoctor({ memoryDir: dir, pkgDir: PKG_DIR })
  const rendered = renderDoctor(report)
  assert.ok(report.sections.length >= 6, `the doctor must report every section:\n${rendered}`)
  assert.equal(report.counts.fail, 0, `the doctor reported failures:\n${rendered}`)
  // The flow must have exercised the paths the checks look for.
  const byName = new Map(report.sections.flatMap((section) => section.checks).map((entry) => [entry.name, entry]))
  assert.equal(byName.get('turn-end hook has fired').status, 'PASS', rendered)
  assert.equal(byName.get('idle flush has fired').status, 'PASS', rendered)
  assert.equal(byName.get('no extracted fact absorbed injected context').status, 'PASS', rendered)
  assert.equal(byName.get('no truncated fragment is live').status, 'PASS', rendered)
  assert.equal(byName.get('archived facts are not returned').status, 'PASS', rendered)
  assert.equal(byName.get('relative imports all resolve').status, 'PASS', rendered)

  await service.close()
  host.emit('session/disposed', sessionWith('session-e2e', []))
  await new Promise((resolve) => setTimeout(resolve, 60))
})
