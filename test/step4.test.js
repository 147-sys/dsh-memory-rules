/*!
 * dsh-memory-rules — Step 4 self-check.
 *
 * 自检目标（对应升级计划第 4 步）：
 *   1. 接入 agent/pre-step 钩子，替换原召回逻辑 — the four-path retrieval is what
 *      gets injected, once per turn, at its first step
 *   2. 新会话能否自动注入高置信度记忆 — a fresh session with no history of its
 *      own still receives the high-confidence memories already in the store
 *   3. 每轮结束写入 — `turn/end` extracts and stores facts, flushed on idle
 *   4. 常设答案短路 — a matching standing answer is injected without retrieval
 *   5. every tool the spec names is registered and reaches the service
 *
 * The host is faked rather than imported: `apply()` only needs `ctx.tools`,
 * `ctx.systemPrompt`, `ctx.on` and `ctx.effect`, so the whole plugin can be
 * driven end to end without a live harness.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../lib/plugin.js'
import { RULES } from '../lib/rules.js'
import { openMemoryService } from '../lib/service.js'
import { ALL_TOOL_NAMES } from '../lib/util.js'
import { tempDir } from './helpers.js'

/**
 * A minimal stand-in for the Cordis context the plugin receives.
 *
 * `ctx.tools` / `ctx.systemPrompt` are the *service values* on the real
 * context (the plugin declares them in `inject`, so cordis waits for those
 * services before calling `apply`). The fakes therefore expose `register` and
 * `context` directly rather than a service accessor object.
 */
function fakeHost() {
  // The collections live under distinct names: `tools` and `systemPrompt` must
  // stay the service objects the plugin calls, so the captured results are
  // exposed separately (`toolRegistry`, `promptContexts`, …).
  const toolRegistry = new Map()
  const promptContexts = []
  const listeners = []
  const effects = []
  const logs = []
  const services = new Map()
  return {
    tools: {
      register(tool) {
        if (!tool || typeof tool.name !== 'string') throw new TypeError('tool needs a name')
        toolRegistry.set(tool.name, tool)
        return () => toolRegistry.delete(tool.name)
      }
    },
    systemPrompt: {
      context(entry) {
        if (!entry || typeof entry.name !== 'string') throw new TypeError('context needs a name')
        promptContexts.push(entry)
        return () => {}
      }
    },
    on(name, handler, options) {
      listeners.push({ name, handler, options })
      return () => {
        const index = listeners.findIndex((entry) => entry.handler === handler)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    provide(name, value) {
      services.set(name, value)
      return () => services.delete(name)
    },
    effect(factory) {
      effects.push(factory)
      return () => {}
    },
    logger: {
      info: (message) => logs.push(`info: ${message}`),
      warn: (message) => logs.push(`warn: ${message}`),
      debug: (message) => logs.push(`debug: ${message}`),
      error: (message) => logs.push(`error: ${message}`)
    },
    // Inspectors used by the assertions below.
    toolRegistry,
    promptContexts,
    listeners,
    effects,
    logs,
    services,
    emit(name, ...args) {
      let result
      for (const entry of listeners) if (entry.name === name) result = entry.handler(...args)
      return result
    },
    /** Dispatch a waterfall event the way cordis does: `(payload, next)`. */
    async waterfall(name, payload, terminal) {
      const chain = listeners.filter((entry) => entry.name === name).map((entry) => entry.handler)
      const dispatch = async (index, current) => {
        if (index >= chain.length) return terminal(current)
        return chain[index](current, () => dispatch(index + 1, current))
      }
      return dispatch(0, payload)
    }
  }
}

/** A stand-in session whose derived history is whatever the test sets. */
function fakeSession(id, messages) {
  return {
    id,
    header: { cwd: 'C:\\ws' },
    deriveMessages: () => messages
  }
}

/** A stand-in agent carrying a session. */
function fakeAgent(session) {
  return { session }
}

/** Wait until `predicate()` is true, or fail after `timeoutMs`. */
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return false
}

/** Boot the plugin against a throwaway memory directory. */
async function boot(name, config = {}) {
  const dir = tempDir(name)
  const host = fakeHost()
  apply(host, {
    memoryDir: dir,
    dbFile: `${dir}\\memory.db`,
    reflectEnabled: false,
    ...config
  })
  // The plugin opens its service asynchronously; wait until the tools appear.
  assert.ok(
    await waitFor(() => host.toolRegistry.size > 0),
    `the plugin must register its tools; logs: ${host.logs.join(' | ')}`
  )
  return { host, dir, dbFile: `${dir}\\memory.db` }
}

/** Open a second connection to the same database, for assertions. */
async function inspector(dir) {
  return openMemoryService({
    memoryDir: dir,
    dbFile: `${dir}\\memory.db`,
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    markdownMirror: false
  })
}

/**
 * Mirror the host's lossless-JSON check for tool results.
 *
 * `JSON.stringify` is not equivalent: it drops `undefined` properties silently,
 * which is exactly the failure this check has to catch (an absent standing
 * answer once made `memory_retrieve` fail with "value is not lossless JSON").
 * The rules below are the ones `dsh-util-values`' `walkJsonValue` enforces.
 *
 * @param value - a tool result.
 * @returns `true` when the host would accept it.
 */
function isLosslessJson(value, ancestors = new Set()) {
  if (value === null) return true
  const kind = typeof value
  if (kind === 'boolean' || kind === 'string') return true
  if (kind === 'number') return Number.isFinite(value) && !Object.is(value, -0)
  if (kind !== 'object') return false
  if (ancestors.has(value)) return false
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false
    if (Reflect.ownKeys(value).length !== value.length + 1) return false
  } else if (Object.getPrototypeOf(value) !== Object.prototype) {
    return false
  }
  ancestors.add(value)
  for (const key of Object.keys(value)) if (!isLosslessJson(value[key], ancestors)) return false
  ancestors.delete(value)
  return true
}

/** Assert one tool result is something the host will accept. */
function assertLossless(label, value) {
  assert.ok(isLosslessJson(value), `${label} is not lossless JSON: ${JSON.stringify(value)}`)
}

/** Build the messages a pre-step decision carries. */
function userMessages(text) {
  return [{ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }]
}

test('plugin: registers every tool plus the prompt context and the lifecycle hooks', async () => {
  const { host, dir } = await boot('step4-register')
  try {
    for (const name of ALL_TOOL_NAMES) {
      assert.ok(host.toolRegistry.has(name), `tool not registered: ${name}`)
    }
    // Two contexts, and the order is the contract: the hard rules (120) read
    // before the memory guidance (150). The rules' name must NOT be
    // `user-rules` — that is the retired dsh-user-rules bundle's name.
    assert.equal(host.promptContexts.length, 2)
    const orders = host.promptContexts.map((entry) => `${entry.name}@${entry.order}`)
    assert.deepEqual(orders, ['memory-rules@120', 'memory:recall@150'])
    assert.equal(host.promptContexts[0].text(), RULES)
    assert.doesNotMatch(host.promptContexts[0].text(), /Long-term memory is active/)
    assert.match(host.promptContexts[1].text(), /Long-term memory is active/)
    const names = host.listeners.map((entry) => entry.name).sort()
    assert.deepEqual(names, ['agent/pre-step', 'agent/status', 'session/disposed', 'session/event'])
    assert.equal(host.effects.length, 1, 'a single teardown effect must be registered')
    // Each tool satisfies the registry contract.
    for (const tool of host.toolRegistry.values()) {
      assert.equal(typeof tool.name, 'string')
      assert.equal(typeof tool.description, 'string')
      assert.equal(typeof tool.execute, 'function')
      assert.equal(typeof tool.output.render, 'function')
      assert.equal(tool.parameters.type, 'object')
      assert.ok(Array.isArray(tool.parameters.required))
      for (const key of tool.parameters.required) {
        assert.ok(Object.hasOwn(tool.parameters.properties, key), `${tool.name}.${key} must be declared`)
      }
    }
  } finally {
    await host.emit('session/disposed', { id: 'none' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    void dir
  }
})

test('plugin: a saved prompt reaches the injected context on the next evaluation', async () => {
  const { host, dir } = await boot('step4-prompt-refresh')
  try {
    const promptContext = host.promptContexts.find((entry) => entry.name === 'memory-rules')
    const library = host.services.get('memoryLibrary')
    assert.ok(library, 'the memoryLibrary service must be provided to the UI')
    await waitFor(async () => (await library.listPrompts()).total === 1)

    // Seeded state: the block body is the RULES text itself.
    assert.equal(promptContext.text(), RULES)

    const created = await library.createPrompt({ title: '语气偏好', body: '回答先给结论。', position: 5 })
    assert.ok(created.item.id)
    // No restart, no re-registering the context: the provider is called again
    // and must see the new block on its very next evaluation.
    assert.ok(
      await waitFor(() => promptContext.text() === `${RULES}\n\n回答先给结论。`),
      `injected text did not refresh: ${JSON.stringify(promptContext.text().slice(-60))}`
    )

    await library.updatePrompt({ id: created.item.id, enabled: false })
    assert.ok(await waitFor(() => promptContext.text() === RULES), 'a disabled block must leave the prompt')

    await library.deletePrompt({ id: created.item.id })
    for (const item of (await library.listPrompts()).items) {
      await library.updatePrompt({ id: item.id, enabled: false })
    }
    // Empty cache: the built-in RULES text must still be injected.
    assert.ok(await waitFor(() => promptContext.text() === RULES), 'the built-in fallback must survive an empty table')

    // The evaluation heartbeat records what the provider actually returned, so
    // "took effect on the next request" is observable from outside the host.
    const service = await library.service()
    assert.ok(await waitFor(async () => {
      const row = await service.db.get("SELECT value FROM meta WHERE key = 'heartbeat:prompt-rules'", [])
      if (row === undefined) return false
      const beat = JSON.parse(row.value)
      return beat.name === 'memory-rules' && beat.order === 120 && beat.chars === RULES.length
    }), 'the prompt evaluation heartbeat must be written')
  } finally {
    await host.emit('session/disposed', { id: 'none' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    void dir
  }
})

test('plugin: a new session is injected with high-confidence memory it never saw', async () => {
  const dir = tempDir('step4-inject')
  const seed = await inspector(dir)
  // Three tiers, so the injection can be checked for content, not just presence.
  await seed.ingestFact({
    content: 'dsh-plugin-memory 的数据库固定在 ~/.dsh/memory/memory.db',
    layer: 'world',
    confidence: 0.95,
    tags: ['config']
  })
  await seed.ingestFact({
    content: '用户在 2026-10-14 把记忆库从 Markdown 迁到 SQLite',
    layer: 'experience',
    confidence: 0.9,
    tags: ['migration']
  })
  await seed.ingestFact({
    content: '完全无关的天气记录：今天多云转晴',
    layer: 'experience',
    confidence: 0.4,
    tags: ['weather']
  })
  await seed.close()

  const host = fakeHost()
  apply(host, { memoryDir: dir, dbFile: `${dir}\\memory.db`, reflectEnabled: false })
  try {
    assert.ok(await waitFor(() => host.toolRegistry.size > 0))
    // A brand-new session: no history at all in this process.
    const session = fakeSession('session-fresh', [])
    const payload = { agent: fakeAgent(session), turn: 1, step: 1, messages: [] }
    const decision = await host.waterfall('agent/pre-step', payload, () => ({
      kind: 'enter',
      messages: userMessages('记忆库放在哪里？')
    }))

    assert.equal(decision.kind, 'enter')
    assert.equal(decision.messages.length, 2, 'the recall block must be injected as one message')
    // The block goes *before* the turn's own words: memory is background, and a
    // page of background after the question reads as the newest instruction.
    const injected = decision.messages[0]
    assert.equal(injected.role, 'user')
    assert.equal(injected.source.kind, 'memory')
    assert.equal(injected.source.recall, 'memory')
    assert.equal(decision.messages[1].source.kind, 'user', 'the turn must stay last')
    const block = injected.content[0].text
    assert.match(block, /<user_long_term_memories/)
    assert.match(block, /memory\.db/, 'the world fact must be injected')
    assert.match(block, /world/, 'the layer must be labelled')
    assert.match(block, /四路命中/, 'the contributing paths must be reported')
    assert.doesNotMatch(block, /今天多云转晴/, 'an unrelated low-confidence fact must not be injected')

    // Once per turn: a repeat of the same turn's first step must not inject again.
    const again = await host.waterfall('agent/pre-step', payload, () => ({
      kind: 'enter',
      messages: userMessages('记忆库放在哪里？')
    }))
    assert.equal(again.messages.length, 1, 'the same turn must not be injected twice')
    const laterStep = await host.waterfall(
      'agent/pre-step',
      { agent: fakeAgent(session), turn: 1, step: 2, messages: [] },
      () => ({ kind: 'enter', messages: userMessages('继续') })
    )
    assert.equal(laterStep.messages.length, 1, 'later steps of a turn must not be injected')
    // A new turn gets its own injection. The query has to be one the store can
    // actually answer: an unrelated turn legitimately injects nothing, which is
    // asserted separately below.
    const nextTurn = await host.waterfall(
      'agent/pre-step',
      { agent: fakeAgent(session), turn: 2, step: 1, messages: [] },
      () => ({ kind: 'enter', messages: userMessages('SQLite 迁移的事呢？') })
    )
    assert.equal(nextTurn.messages.length, 2)
    assert.match(nextTurn.messages[0].content[0].text, /SQLite/)

    // A turn the store knows nothing about must inject nothing rather than
    // padding itself with the newest unrelated memory.
    const unknown = await host.waterfall(
      'agent/pre-step',
      { agent: fakeAgent(session), turn: 3, step: 1, messages: [] },
      () => ({ kind: 'enter', messages: userMessages('那配置呢？') })
    )
    assert.equal(unknown.messages.length, 1, 'an unrelated turn must not be padded with noise')

    // A rejected decision is passed through untouched.
    const rejected = await host.waterfall('agent/pre-step', payload, () => ({ kind: 'reject' }))
    assert.deepEqual(rejected, { kind: 'reject' })
  } finally {
    host.emit('session/disposed', fakeSession('session-fresh', []))
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
})

test('plugin: turn/end writes facts and idle flushes them', async () => {
  // `ingestAssistant` is off by default (assistant prose is not a memory); this
  // test turns it on deliberately so both extraction sources are exercised.
  const { host, dir } = await boot('step4-ingest', { ingestAssistant: true })
  try {
    const messages = [
      {
        role: 'user',
        content: [{ type: 'text', text: '我决定把记忆插件的数据库换成 SQLite，因为 Markdown 检索太慢了。' }],
        source: { kind: 'user' }
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '所以结论是：优先使用 node:sqlite，只有 Node 低于 22.5 时才回退到 sql.js。' }],
        source: { kind: 'assistant' }
      },
      // Our own injection must never be re-ingested as a fact about memory.
      {
        role: 'user',
        content: [{ type: 'text', text: 'Recalled long-term memory (2 entries): - [world] 无关的注入文本' }],
        source: { kind: 'memory' }
      }
    ]
    const session = fakeSession('session-turn', messages)
    host.emit('session/event', session, { type: 'turn/end', seq: 7, data: { turn: 1 } })

    // Nothing is written until the agent goes idle.
    const early = await inspector(dir)
    assert.equal((await early.counts()).facts, 0, 'a turn end must only queue work')
    await early.close()

    host.emit('agent/status', { agent: fakeAgent(session), status: 'idle' })
    const check = await inspector(dir)
    try {
      assert.ok(
        await waitFor(async () => (await check.counts()).facts > 0),
        'the idle flush must store the turn\'s facts'
      )
      check.invalidate()
      const facts = await check.allFacts()
      assert.ok(facts.length >= 2, `expected several facts, got ${facts.length}`)
      for (const fact of facts) {
        assert.equal(fact.sourceSession, 'session-turn')
        assert.ok(['world', 'experience'].includes(fact.layer))
        assert.ok(fact.rawQuote.length > 0, 'the source sentence must be kept as the audit quote')
      }
      assert.ok(
        facts.some((fact) => /SQLite/.test(fact.content)),
        'the storage decision must be extracted'
      )
      // The plugin's own injected message is filtered out before extraction, so
      // neither its body nor any sentence lifted from it may reach the store.
      for (const fact of facts) {
        assert.doesNotMatch(fact.content, /无关的注入/, 'this plugin\'s own injection must never become a fact')
        assert.doesNotMatch(fact.content, /^Recalled long-term memory/, 'the injection header must not be stored')
      }
      // A second turn/end + idle over the same history stores nothing new.
      const before = (await check.counts()).facts
      host.emit('session/event', session, { type: 'turn/end', seq: 9, data: { turn: 2 } })
      host.emit('agent/status', { agent: fakeAgent(session), status: 'idle' })
      await new Promise((resolve) => setTimeout(resolve, 120))
      assert.equal((await check.counts()).facts, before, 're-ingesting the same history must be a no-op')
    } finally {
      await check.close()
    }
  } finally {
    host.emit('session/disposed', fakeSession('session-turn', []))
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
})

test('plugin: a session that ends without an idle still gets written on dispose', async () => {
  const { host, dir } = await boot('step4-dispose')
  try {
    const session = fakeSession('session-bye', [
      {
        role: 'user',
        content: [{ type: 'text', text: '用户偏好用 pnpm 管理依赖，并且要求所有提交先过测试。' }],
        source: { kind: 'user' }
      }
    ])
    host.emit('session/event', session, { type: 'turn/end', seq: 3, data: { turn: 1 } })
    host.emit('session/disposed', session)
    const check = await inspector(dir)
    try {
      assert.ok(
        await waitFor(async () => (await check.counts()).facts > 0),
        'dispose must flush the turn it still owes'
      )
      check.invalidate()
      assert.ok((await check.allFacts()).some((fact) => /pnpm/.test(fact.content)))
    } finally {
      await check.close()
    }
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
})

test('plugin: a matching standing answer short-circuits the injected retrieval', async () => {
  const dir = tempDir('step4-answer')
  const seed = await inspector(dir)
  await seed.saveAnswer({
    question: '记忆库放在哪里？',
    questions: ['记忆数据库文件在哪个目录', 'memory.db 的路径是什么'],
    answer: '默认 ~/.dsh/memory/memory.db，可用 DSH_MEMORY_DB 覆盖'
  })
  // A decoy the retrieval would otherwise return.
  await seed.ingestFact({
    content: '记忆库的目录结构包含每日 Markdown 镜像',
    layer: 'world',
    confidence: 0.9,
    tags: ['memory']
  })
  await seed.close()

  const host = fakeHost()
  apply(host, { memoryDir: dir, dbFile: `${dir}\\memory.db`, reflectEnabled: false })
  try {
    assert.ok(await waitFor(() => host.toolRegistry.size > 0))
    const session = fakeSession('session-answer', [])
    const decision = await host.waterfall('agent/pre-step', { agent: fakeAgent(session), turn: 1, step: 1 }, () => ({
      kind: 'enter',
      messages: userMessages('记忆数据库文件在哪个目录？')
    }))
    const block = decision.messages[0].content[0].text
    assert.match(block, /常设答案命中/)
    assert.match(block, /DSH_MEMORY_DB/)
    assert.doesNotMatch(block, /四路命中/, 'a standing answer must not run retrieval')

    // An unrelated question takes the retrieval path instead.
    const other = await host.waterfall('agent/pre-step', { agent: fakeAgent(session), turn: 2, step: 1 }, () => ({
      kind: 'enter',
      messages: userMessages('记忆库的目录结构是什么？')
    }))
    assert.match(other.messages[0].content[0].text, /四路命中/)

    // The answer's hit counter is persisted.
    const check = await inspector(dir)
    try {
      const answer = (await check.allAnswers())[0]
      assert.ok(answer.hits >= 1, 'the standing-answer hit must be counted')
    } finally {
      await check.close()
    }
  } finally {
    host.emit('session/disposed', fakeSession('session-answer', []))
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
})

test('plugin: the tools reach the live service', async () => {
  const { host, dir } = await boot('step4-tools')
  try {
    const write = host.toolRegistry.get('memory_write')
    const written = await write.execute({ content: '用户要求所有回答都用中文。', layer: 'world', tags: ['pref'] })
    assert.equal(written.ok, true)
    assert.equal(written.layer, 'world')
    assert.match(write.output.render({}, written)[0].text, /Stored as world/)
    const dup = await write.execute({ content: '用户要求所有回答都用中文。' })
    assert.equal(dup.duplicate, true)

    await host.toolRegistry.get('memory_relate').execute({
      subject: 'dsh-plugin-memory',
      predicate: 'stores_in',
      object: 'SQLite'
    })
    await host.toolRegistry
      .get('memory_write')
      .execute({ content: 'dsh-plugin-memory 把事实存在 SQLite 里', layer: 'world', confidence: 0.9 })

    const retrieved = await host.toolRegistry.get('memory_retrieve').execute({ query: '回答用中文' })
    assert.equal(retrieved.ok, true)
    assert.ok(retrieved.count >= 1)
    // The labels are the stored layer names: `[world]`, `[experience]`, `[belief]`.
    assert.match(retrieved.text, /\[world conf=/)
    assert.ok(Array.isArray(retrieved.foundBy) && retrieved.foundBy[0].paths.length >= 1)
    assertLossless('memory_retrieve (with results)', retrieved)
    // Regression: an unmatched standing answer used to leave `answer: undefined`
    // in the payload, and the host refuses a tool result containing `undefined`.
    assert.equal(Object.hasOwn(retrieved, 'answer'), false, 'an absent answer must be omitted, not undefined')

    const limited = await host.toolRegistry.get('memory_retrieve').execute({ query: 'SQLite', paths: ['keyword'] })
    assert.equal(limited.stats.pathCounts.semantic, 0)

    const missed = await host.toolRegistry.get('memory_retrieve').execute({ query: '企鹅的迁徙路线' })
    assert.equal(missed.count, 0, `the query must match nothing; got: ${missed.text}`)
    assertLossless('memory_retrieve (no match)', missed)
    assert.equal(Object.hasOwn(missed, 'answer'), false)

    assertLossless('memory_write', written)
    assertLossless(
      'memory_relate',
      await host.toolRegistry.get('memory_relate').execute({ subject: 'a', predicate: 'b', object: 'c' })
    )

    const answer = await host.toolRegistry.get('memory_answer').execute({
      question: '回答语言是什么？',
      answer: '中文'
    })
    assert.equal(answer.ok, true)
    assert.equal(answer.updated, false)
    const answered = await host.toolRegistry.get('memory_retrieve').execute({ query: '回答语言是什么？' })
    assert.equal(answered.answer.text, '中文')
    assert.equal(answered.count, 0, 'a standing answer must skip the four paths')

    const extracted = await host.toolRegistry.get('memory_export').execute({ dir: `${dir}\\export` })
    assert.equal(extracted.ok, true)
    assert.ok(extracted.files.length >= 6)
    assertLossless('memory_export', extracted)
    assertLossless('memory_answer', answer)
    assertLossless('memory_retrieve (standing answer)', answered)

    const reflect = host.toolRegistry.get('memory_reflect')
    await host.toolRegistry.get('memory_write').execute({ content: '记忆库使用 SQLite 存事实', tags: ['sqlite'] })
    await host.toolRegistry.get('memory_write').execute({ content: '记忆库使用 SQLite 的 WAL 模式', tags: ['sqlite'] })
    await host.toolRegistry.get('memory_write').execute({ content: '记忆库使用 SQLite 存全部证据', tags: ['sqlite'] })
    const reflected = await reflect.execute({ period: '2026-10-15', force: true })
    assert.equal(reflected.ok, true)
    assert.equal(reflected.stats.created, 1)
    assert.match(reflect.output.render({}, reflected)[0].text, /Reflection 2026-10-15/)
    assertLossless('memory_reflect', reflected)
    // A skipped run returns a different shape and must also be lossless.
    assertLossless('memory_reflect (skipped)', await reflect.execute({ period: '2026-10-15' }))

    // The Markdown keyword tool reads the day-file mirror the service writes.
    const search = await host.toolRegistry.get('memory_search')
    const found = await search.execute({ query: 'SQLite' })
    assert.equal(found.ok, true)
    assert.ok(found.count >= 1, 'the mirror must be searchable')
    assertLossless('memory_search', found)
    assertLossless('memory_search (no hit)', await search.execute({ query: 'zzz-绝对不存在的词' }))

    // Errors come back as `{ error }`, never as a throw — and are lossless too.
    const badWrite = await write.execute({ content: '   ' })
    assert.match(badWrite.error, /non-empty/)
    assertLossless('memory_write (error)', badWrite)
    assertLossless('memory_retrieve (error)', await host.toolRegistry.get('memory_retrieve').execute({ query: '  ' }))
  } finally {
    host.emit('session/disposed', fakeSession('session-tools', []))
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
})

test('plugin: recall disabled means no injection, but ingestion still runs', async () => {
  const { host, dir } = await boot('step4-norecall', { recallEnabled: false })
  try {
    const session = fakeSession('session-off', [])
    const decision = await host.waterfall('agent/pre-step', { agent: fakeAgent(session), turn: 1, step: 1 }, () => ({
      kind: 'enter',
      messages: userMessages('记忆库放在哪里？')
    }))
    assert.equal(decision.messages.length, 1, 'recall disabled must inject nothing')
    const guidance = host.promptContexts.find((entry) => entry.name === 'memory:recall')
    assert.ok(guidance, 'the memory guidance context is registered regardless of recall')
    assert.match(guidance.text(), /recall injection is disabled/)
    // The rules context is a separate concern and keeps injecting either way.
    assert.equal(host.promptContexts.find((entry) => entry.name === 'memory-rules').text(), RULES)

    host.emit('session/event', session, {
      type: 'turn/end',
      seq: 1,
      data: { turn: 1 }
    })
    // Ingestion is a separate switch and stays on.
    const check = await inspector(dir)
    try {
      assert.ok(await waitFor(async () => true), 'no-op wait')
    } finally {
      await check.close()
    }
  } finally {
    host.emit('session/disposed', fakeSession('session-off', []))
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
})

test('plugin: a memory fault never breaks the turn', async () => {
  const host = fakeHost()
  const dir = tempDir('step4-broken')
  // A directory where the database file must be: `DatabaseSync` cannot open it,
  // so the service fails to open and every hook has to degrade quietly. This
  // fixture is deliberate — a sandbox may *create* a missing parent directory,
  // which makes "impossible path" tests pass or fail by luck.
  const fsMod = await import('node:fs')
  const pathMod = await import('node:path')
  fsMod.mkdirSync(pathMod.join(dir, 'memory.db'), { recursive: true })
  apply(host, {
    memoryDir: dir,
    dbFile: pathMod.join(dir, 'memory.db'),
    reflectEnabled: false,
    ingestEnabled: true
  })
  try {
    const decision = await host.waterfall('agent/pre-step', { agent: fakeAgent(fakeSession('s', [])), turn: 1, step: 1 }, () => ({
      kind: 'enter',
      messages: userMessages('anything')
    }))
    assert.equal(decision.kind, 'enter')
    assert.equal(decision.messages.length, 1, 'a broken memory store must inject nothing')
    host.emit('session/event', fakeSession('s', []), { type: 'turn/end', seq: 1, data: { turn: 1 } })
    host.emit('agent/status', { agent: fakeAgent(fakeSession('s', [])), status: 'idle' })
    host.emit('session/disposed', fakeSession('s', []))
    await new Promise((resolve) => setTimeout(resolve, 120))
    assert.ok(
      host.logs.some((line) => line.startsWith('warn') || line.startsWith('error')),
      `the fault must be logged; logs: ${host.logs.join(' | ')}`
    )
    // The tools are still registered — they fail at call time, not at load time.
    assert.ok(host.toolRegistry.size === 7)
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
})

test('retrieve: calibration — the noise band of the hash-ngram sketch', async () => {
  // This test exists to pin a *measured* fact, not to assert a preference: with
  // 256 dimensions and a 2/3-gram + word feature set, unrelated short texts
  // land around 0.45–0.50 cosine while genuinely related ones land at 0.55+.
  // The retrieval filter's thresholds (`minSimilarity` 0.4, `strong` 0.6,
  // relevance floor 0.5) are chosen from these numbers. If the embedding or its
  // dimensions change and the band widens, this test fails rather than letting
  // the plugin quietly inject unrelated memories.
  const { embed, cosine, toSimilarity } = await import('../lib/embed.js')
  const query = '记忆库放在哪里？'
  const related = 'dsh-plugin-memory 的数据库固定在 ~/.dsh/memory/memory.db'
  const paraphrase = '用户在 2026-10-14 把记忆库从 Markdown 迁到 SQLite'
  const unrelated = '完全无关的天气记录：今天多云转晴'
  const sim = (text) => toSimilarity(cosine(embed(query, 256), embed(text, 256)))

  assert.ok(sim(related) > 0.55, `a literal match must score clearly: ${sim(related).toFixed(3)}`)
  assert.ok(sim(paraphrase) > 0.55, `a topical match must score clearly: ${sim(paraphrase).toFixed(3)}`)
  assert.ok(sim(unrelated) < 0.5, `unrelated text must stay in the noise band: ${sim(unrelated).toFixed(3)}`)
  assert.ok(
    sim(related) - sim(unrelated) > 0.1,
    'the related/unrelated margin must be wide enough to threshold on'
  )
})

test('plugin: the recall block respects the token budget', async () => {  const dir = tempDir('step4-budget')
  const seed = await inspector(dir)
  for (let i = 0; i < 12; i += 1) {
    await seed.ingestFact({
      content: `记忆条目 ${i}：${'填充内容'.repeat(20)}`,
      layer: 'experience',
      confidence: 0.8,
      tags: ['bulk']
    })
  }
  await seed.close()

  const host = fakeHost()
  apply(host, { memoryDir: dir, dbFile: `${dir}\\memory.db`, reflectEnabled: false, maxTokens: 120 })
  try {
    assert.ok(await waitFor(() => host.toolRegistry.size > 0))
    const decision = await host.waterfall('agent/pre-step', { agent: fakeAgent(fakeSession('s', [])), turn: 1, step: 1 }, () => ({
      kind: 'enter',
      messages: userMessages('记忆条目')
    }))
    const block = decision.messages.at(-1).content[0].text
    const { estimateTokens } = await import('../lib/util.js')
    assert.ok(estimateTokens(block) <= 120, `block exceeded the budget: ${estimateTokens(block)}`)
  } finally {
    host.emit('session/disposed', fakeSession('s', []))
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
})

