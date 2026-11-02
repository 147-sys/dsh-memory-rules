/*!
 * dsh-memory-rules — Step 5 self-check.
 *
 * 自检目标（对应升级计划第 5 步）：
 *   1. 导出文件是否人类可读 — every export file parses as Markdown, has a
 *      heading, a count line and rows; tables are well-formed; the layer labels
 *      and the Chinese/English headers survive
 *   2. the export is *complete* — all four layers appear, evidence links point
 *      at facts that exist, and the counters agree with the database
 *   3. the export is *rebuildable* — writing it twice is idempotent, and it does
 *      not depend on state kept in memory
 *   4. a seeded end-to-end store produces every document from one call
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { buildExport, renderAnswersDoc, renderBeliefsDoc, renderFactsDoc, renderTimelineDoc } from '../lib/export.js'
import { tempService } from './helpers.js'

/** Split a Markdown table into header cells and body rows. */
function parseTable(lines, startIndex) {
  const header = lines[startIndex].split('|').slice(1, -1).map((cell) => cell.trim())
  const rows = []
  for (let i = startIndex + 2; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line.startsWith('|')) break
    rows.push(line.split('|').slice(1, -1).map((cell) => cell.trim()))
  }
  return { header, rows }
}

/** Every Markdown file must be a document a person can read. */
function assertReadable(file) {
  const text = fs.readFileSync(file, 'utf8')
  const name = path.basename(file)
  assert.ok(text.length > 0, `${name} is empty`)
  assert.match(text, /^# /m, `${name} needs a top-level heading`)
  assert.match(text, /导出时间 exported/, `${name} needs an export stamp (who/when)`)
  // No template or escaping debris may reach a reader.
  assert.doesNotMatch(text, /\$\{/, `${name} contains an unexpanded template`)
  assert.doesNotMatch(text, /\bundefined\b|\bNaN\b/, `${name} contains undefined/NaN`)
  assert.doesNotMatch(text, /\r/, `${name} must use LF endings`)
  assert.ok(text.endsWith('\n'), `${name} must end with a newline`)
  // Every table must be well formed: each block starts with a header row, its
  // separator, then rows of the same width.
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const startsTable = lines[i].startsWith('|') && !(lines[i - 1] ?? '').startsWith('|')
    if (!startsTable) continue
    // A layer summary is a two-cell table; a record table has more. Both need a
    // separator directly under the header.
    assert.match(lines[i + 1] ?? '', /^\|[\s|:-]*-+[\s|:-]*$/, `${name}: table at line ${i + 1} needs a separator row`)
    const width = lines[i].split('|').length
    for (let j = i; j < lines.length && lines[j].startsWith('|'); j += 1) {
      assert.equal(
        lines[j].split('|').length,
        width,
        `${name}: table row ${j + 1} has a different column count`
      )
    }
  }
  return text
}

/** Seed a store that exercises all four layers across several days. */
async function seedAll(service) {
  await service.ingestFact(
    {
      content: '记忆库使用 SQLite 存储全部证据',
      layer: 'world',
      confidence: 0.95,
      tags: ['config', 'sqlite'],
      relations: [{ subject: 'dsh-memory-rules', predicate: 'uses', object: 'SQLite' }],
      origin: 'manual'
    },
    { createdAt: '2026-10-12T09:00:00+08:00' }
  )
  await service.ingestFact(
    {
      content: '记忆库使用 SQLite 的 WAL 模式提高并发',
      layer: 'world',
      confidence: 0.75,
      tags: ['sqlite']
    },
    { createdAt: '2026-10-13T10:30:00+08:00' }
  )
  await service.ingestFact(
    {
      content: '记忆库使用 SQLite 的备份接口',
      layer: 'world',
      confidence: 0.8,
      tags: ['sqlite']
    },
    { createdAt: '2026-10-13T11:45:00+08:00' }
  )
  await service.ingestFact(
    {
      content: '用户在 2026-10-14 把记忆库从 Markdown 迁移到 SQLite',
      layer: 'experience',
      confidence: 0.9,
      tags: ['migration']
    },
    { createdAt: '2026-10-14T08:15:00+08:00' }
  )
  await service.saveAnswer({
    question: '记忆库放在哪里？',
    questions: ['memory.db 的路径是什么'],
    answer: '`~/.dsh/memory/memory.db`（可用 DSH_MEMORY_DB 覆盖）'
  })
  await service.addRelation({ subject: '用户', predicate: 'prefers', object: 'pnpm' })
  return service.runReflection({ periodKey: '2026-10-15', kind: 'manual', now: new Date('2026-10-16T10:00:00+08:00') })
}

test('export: one call writes every document, and each is human-readable', async () => {
  const { service, dir, cleanup } = await tempService('export', { markdownMirror: false })
  try {
    await seedAll(service)
    const target = path.join(dir, 'export')
    const result = await service.exportMarkdown({ dir: target, now: new Date('2026-10-16T12:00:00+08:00') })

    const names = result.files.map((file) => path.basename(file)).sort()
    assert.deepEqual(names, ['README.md', 'answers.md', 'beliefs.md', 'facts.md', 'relations.md', 'timeline.md'])
    for (const file of result.files) assert.ok(fs.existsSync(file), `${file} was not written`)
    for (const file of result.files) assertReadable(file)

    // --- facts.md ---------------------------------------------------------
    const facts = assertReadable(path.join(target, 'facts.md'))
    assert.match(facts, /世界事实 world/)
    assert.match(facts, /自身经历 experience/)
    // The fixture stores three world facts and one experience fact.
    assert.match(facts, /\| 世界事实 world \| 3 \|/)
    assert.match(facts, /\| 自身经历 experience \| 1 \|/)
    assert.match(facts, /## 世界事实 world（3）/, 'the layer section must carry its count')
    assert.match(facts, /## 自身经历 experience（1）/)
    assert.match(facts, /记忆库使用 SQLite 存储全部证据/, 'the stored statement must appear verbatim')
    assert.match(facts, /时间 created/, 'the audit columns must be present')
    assert.match(facts, /原文 raw quote/, 'the audit column must be present')
    assert.match(facts, /#sqlite/, 'tags must be rendered')
    // Every fact id must be traceable from the file.
    for (const fact of await service.allFacts()) {
      assert.match(facts, new RegExp(fact.id.slice(0, 14)), `fact ${fact.id} is not traceable in facts.md`)
    }
    const factTables = facts
      .split('\n')
      .map((line, index) => ({ line, index }))
      .filter((entry) => entry.line.startsWith('| id |'))
    assert.equal(factTables.length, 2, 'one table per layer')
    for (const table of factTables) {
      const { header, rows } = parseTable(facts.split('\n'), table.index)
      assert.equal(header.length, 7, `unexpected facts header: ${header.join(',')}`)
      assert.ok(rows.length > 0)
      for (const row of rows) assert.equal(row.length, header.length)
    }

    // --- beliefs.md -------------------------------------------------------
    const beliefs = assertReadable(path.join(target, 'beliefs.md'))
    assert.match(beliefs, /观察信念 beliefs/)
    const beliefRows = parseTable(beliefs.split('\n'), beliefs.split('\n').findIndex((l) => l.startsWith('| 主题 topic')))
    assert.ok(beliefRows.rows.length >= 1, 'the seeded consolidation must show up')
    assert.match(beliefs, /证据 \d+ 条/, 'each belief must state its evidence count')
    assert.match(beliefs, /原始事实一并保留/, 'the no-deletion guarantee must be stated')
    for (const row of beliefRows.rows) assert.equal(row.length, beliefRows.header.length)
    // Every cited evidence id must be a real fact id in the same export.
    const ids = new Set(
      (await service.allFacts()).map((fact) => fact.id)
    )
    for (const belief of await service.allBeliefs()) {
      for (const id of belief.evidenceIds) assert.ok(ids.has(id), `belief cites a missing fact: ${id}`)
      assert.match(beliefs, new RegExp(belief.id), 'the belief id must be rendered')
    }

    // --- answers.md -------------------------------------------------------
    const answers = assertReadable(path.join(target, 'answers.md'))
    assert.match(answers, /常设答案 answers/)
    assert.match(answers, /记忆库放在哪里？/)
    assert.match(answers, /memory\.db/)
    assert.match(answers, /不检索、不跑模型/, 'the shortcut semantics must be documented in the file')
    assert.match(answers, /其他问法 variants/, 'extra phrasings must be listed')

    // --- relations.md -----------------------------------------------------
    const relations = assertReadable(path.join(target, 'relations.md'))
    assert.match(relations, /关系图 relations/)
    assert.match(relations, /dsh-memory-rules/)
    assert.match(relations, /manual|手动声明/, 'a hand-declared edge must be labelled')
    const relationRows = parseTable(
      relations.split('\n'),
      relations.split('\n').findIndex((l) => l.startsWith('| 主语 subject'))
    )
    assert.equal(relationRows.rows.length, 2, 'one extracted edge + one manual edge')

    // --- timeline.md ------------------------------------------------------
    const timeline = assertReadable(path.join(target, 'timeline.md'))
    assert.match(timeline, /时间线 timeline/)
    const days = timeline.split('\n').filter((line) => /^## \d{4}-\d{2}-\d{2}$/.test(line))
    assert.ok(days.length >= 2, `expected several dated sections, got ${days.length}`)
    const sorted = [...days].sort().reverse()
    assert.deepEqual(days, sorted, 'timeline days must be newest-first')
    assert.match(timeline, /`\d{2}:\d{2}:\d{2}`/, 'each timeline line carries its clock time')

    // --- README.md --------------------------------------------------------
    const index = assertReadable(path.join(target, 'README.md'))
    assert.match(index, /本地记忆库 local memory/)
    assert.match(index, /node:sqlite/, 'the engine must be reported')
    assert.match(index, /facts（世界事实 \+ 自身经历） \| 4 \|/)
    assert.match(index, /beliefs（观察信念） \| 1 \|/)
    assert.match(index, /answers（常设答案） \| 1 \|/)
    assert.match(index, /relations（关系图） \| 2 \|/)
    // Only non-superseded facts count in the "active" breakdown, which is why
    // it is smaller than the per-layer counts in facts.md — the folded evidence
    // is still there, it is simply not active any more.
    assert.match(index, /世界事实 world \| 1 \|/)
    assert.match(index, /自身经历 experience \| 1 \|/)
    assert.match(index, /观察信念 belief \| 1 \|/)
    assert.match(index, /常设答案 answer \| 1 \|/)
    assert.match(index, /活跃条数/, 'the active-count column must be labelled')
    assert.match(index, /已并入的事实仍保留/, 'the difference must be explained in the file')
    for (const name of names) assert.match(index, new RegExp(`\`${name}\``), `${name} must be linked from the index`)

    // --- counters agree with the database ---------------------------------
    const counts = await service.counts()
    assert.equal(result.counts.facts, counts.facts)
    assert.equal(result.counts.beliefs, counts.beliefs)
    assert.equal(result.counts.answers, counts.answers)
    assert.equal(result.counts.relations, counts.relations)
  } finally {
    await cleanup()
  }
})

test('export: writing twice is idempotent and rebuildable from an empty export dir', async () => {
  const { service, dir, cleanup } = await tempService('export-twice', { markdownMirror: false })
  try {
    await seedAll(service)
    const target = path.join(dir, 'export')
    await service.exportMarkdown({ dir: target, now: new Date('2026-10-16T12:00:00+08:00') })
    const first = new Map(
      fs.readdirSync(target).map((name) => [name, fs.readFileSync(path.join(target, name), 'utf8')])
    )
    // A stale file must be overwritten, not appended to.
    fs.appendFileSync(path.join(target, 'facts.md'), 'STALE MARKER\n', 'utf8')
    await service.exportMarkdown({ dir: target, now: new Date('2026-10-16T12:00:00+08:00') })
    const second = new Map(
      fs.readdirSync(target).map((name) => [name, fs.readFileSync(path.join(target, name), 'utf8')])
    )
    assert.deepEqual([...second.keys()].sort(), [...first.keys()].sort())
    for (const [name, text] of second) {
      assert.doesNotMatch(text, /STALE MARKER/, `${name} was appended to instead of replaced`)
      assert.equal(text, first.get(name), `${name} is not deterministic across runs`)
    }
    // Exporting to a fresh directory works with no other state.
    const other = path.join(dir, 'export-2')
    const again = await service.exportMarkdown({ dir: other, now: new Date('2026-10-16T12:00:00+08:00') })
    assert.equal(again.files.length, 6)
    assert.equal(fs.readFileSync(path.join(other, 'facts.md'), 'utf8'), first.get('facts.md'))
  } finally {
    await cleanup()
  }
})

test('export: an empty store still produces readable documents', async () => {
  const { service, dir, cleanup } = await tempService('export-empty', { markdownMirror: false })
  try {
    const target = path.join(dir, 'export')
    const result = await service.exportMarkdown({ dir: target, now: new Date('2026-10-16T12:00:00+08:00') })
    assert.equal(result.files.length, 6)
    for (const file of result.files) assertReadable(file)
    const beliefs = fs.readFileSync(path.join(target, 'beliefs.md'), 'utf8')
    assert.match(beliefs, /_（暂无/, 'an empty section must say so rather than render a broken table')
    assert.doesNotMatch(beliefs, /^\| 主题 topic/m, 'no empty belief table may be emitted')
    const facts = fs.readFileSync(path.join(target, 'facts.md'), 'utf8')
    assert.match(facts, /## 世界事实 world（0）/)
    assert.doesNotMatch(facts, /^\| 时间 created/m, 'no empty facts table may be emitted')
  } finally {
    await cleanup()
  }
})

test('export: a superseded fact stays in the export as evidence', async () => {
  const { service, dir, cleanup } = await tempService('export-superseded', { markdownMirror: false })
  try {
    await seedAll(service)
    const target = path.join(dir, 'export')
    // The default includes superseded facts; excluding them must be possible but
    // is not the default, because they are the beliefs' evidence.
    const full = await service.exportMarkdown({ dir: target, now: new Date('2026-10-16T12:00:00+08:00') })
    const factsFull = fs.readFileSync(path.join(target, 'facts.md'), 'utf8')
    const superseded = (await service.allFacts()).filter((fact) => fact.supersededBy !== null)
    assert.ok(superseded.length > 0, 'the fixture must have folded evidence')
    for (const fact of superseded) assert.match(factsFull, new RegExp(fact.id.slice(0, 12)))
    const factsOnly = await service.exportMarkdown({
      dir: path.join(dir, 'export-2'),
      includeSuperseded: false,
      now: new Date('2026-10-16T12:00:00+08:00')
    })
    assert.equal(full.counts.facts, factsOnly.counts.facts, 'the database total never changes')
    const factsActive = fs.readFileSync(path.join(dir, 'export-2', 'facts.md'), 'utf8')
    assert.ok(factsActive.length < factsFull.length, 'excluding superseded rows must shrink facts.md')
  } finally {
    await cleanup()
  }
})

test('export: the renderers are pure and tolerate partial rows', () => {
  // A row missing optional columns must not throw or print `undefined`.
  const partial = [
    { id: 'f1', content: '一条没有标签的事实', layer: 'world', confidence: 0.5, createdAt: '2026-10-14T00:00:00+08:00', tags: [] },
    { id: 'f2', content: '一条带原文的事实', layer: 'experience', confidence: 0.7, createdAt: '2026-10-14T01:00:00+08:00', tags: ['x'], rawQuote: '原文在这里', sourceSession: 'session-a' }
  ]
  const facts = renderFactsDoc(partial, { facts: 2 })
  assert.match(facts, /一条没有标签的事实/)
  assert.match(facts, /原文在这里/)
  assert.doesNotMatch(facts, /undefined|NaN/)
  assert.match(renderBeliefsDoc([]), /_（暂无/)
  assert.match(renderAnswersDoc([]), /_（暂无/)
  assert.match(renderTimelineDoc([]), /_（暂无/)
  assert.match(renderTimelineDoc(partial), /## 2026-10-14/)
  // A pipe inside content must be escaped, or the table breaks.
  const piped = renderFactsDoc(
    [{ id: 'f3', content: 'a | b', layer: 'world', confidence: 0.5, createdAt: '2026-10-14T00:00:00+08:00', tags: [] }],
    {}
  )
  assert.match(piped, /a &#124; b/)
  const lines = piped.split('\n')
  const tableStart = lines.findIndex((line) => line.startsWith('| id |'))
  assert.ok(tableStart >= 0, 'the facts table header must be emitted')
  const width = lines[tableStart].split('|').length
  for (let i = tableStart; i < lines.length && lines[i].startsWith('|'); i += 1) {
    assert.equal(lines[i].split('|').length, width, 'an encoded pipe must not add a column')
  }
  // GFM does not honour a backslash-escaped pipe, so the encoder must not use one.
  assert.doesNotMatch(piped, /\\\|/)
  // buildExport writes into an existing directory; creating it is the caller's
  // job (`MemoryService.exportMarkdown` does it, and an unexpected `mkdir` here
  // would hide a typo'd path).
  const out = path.join(process.env.TEMP ?? '/tmp', `dsh-export-${Date.now()}`)
  fs.mkdirSync(out, { recursive: true })
  const files = buildExport({ dir: out, facts: partial, beliefs: [], answers: [], relations: [], counts: {}, now: new Date() })
  assert.equal(files.length, 6)
  fs.rmSync(out, { recursive: true, force: true })
})
