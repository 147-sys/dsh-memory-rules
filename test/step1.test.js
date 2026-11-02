/*!
 * dsh-memory-rules — Step 1 self-check.
 *
 * 自检目标（对应升级计划第 1 步）：
 *   1. 表结构能否创建            — schema creates every required table/column/index
 *   2. 抽取结果能否按四层正确写入 — extraction output lands in the right layer
 *   3. relations 是否同步         — relation edges follow their source fact
 *
 * Every test uses a real database engine (`node:sqlite` here, `sql.js` when it
 * is the only one available) on a temporary directory, so a passing suite means
 * the DDL actually executed rather than merely parsed.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { MemoryService, decodeAnswer, decodeBelief, decodeFact, openMemoryService } from '../lib/service.js'
import { RULES } from '../lib/rules.js'
import { probeEngines } from '../lib/db.js'
import { SCHEMA_SQL, SCHEMA_VERSION } from '../lib/schema.js'
import { stripSqlComments } from '../tools/build-schema.mjs'
import { extractFacts, isCompleteStatement } from '../lib/extract.js'
import { assistantTurn, tempDir, tempService, userTurn } from './helpers.js'

const REQUIRED_TABLES = ['facts', 'beliefs', 'answers', 'relations', 'belief_revisions', 'reflections', 'meta', 'prompt_blocks']

/** The columns the upgrade specification names, per table. */
const REQUIRED_COLUMNS = {
  facts: ['id', 'content', 'source_session', 'created_at', 'layer', 'confidence', 'tags'],
  beliefs: ['id', 'statement', 'evidence_ids', 'evidence_count', 'strength', 'updated_at', 'revision', 'archived_at'],
  answers: ['id', 'question_pattern', 'cached_answer', 'last_verified'],
  relations: ['subject', 'predicate', 'object', 'source_fact_id'],
  prompt_blocks: ['id', 'title', 'body', 'position', 'enabled', 'created_at', 'updated_at']
}

test('schema: sql/schema.sql and the generated module agree', () => {
  const sqlFile = path.join(import.meta.dirname, '..', 'sql', 'schema.sql')
  const source = fs.readFileSync(sqlFile, 'utf8')
  assert.equal(
    stripSqlComments(source),
    SCHEMA_SQL.trim(),
    'lib/schema.js is stale: run `node tools/build-schema.mjs`'
  )
  assert.match(SCHEMA_VERSION, /^[0-9a-f]{16}$/)
})

test('schema: every required table, column and index is created', async () => {
  const { service, cleanup } = await tempService('schema')
  try {
    const tables = (await service.db.all("SELECT name FROM sqlite_master WHERE type = 'table'", [])).map(
      (row) => row.name
    )
    for (const table of REQUIRED_TABLES) {
      assert.ok(tables.includes(table), `missing table: ${table}`)
    }
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
      const info = await service.db.all(`PRAGMA table_info(${table})`, [])
      const names = info.map((row) => row.name)
      for (const column of columns) {
        assert.ok(names.includes(column), `missing column: ${table}.${column}`)
      }
    }
    const indexes = (await service.db.all("SELECT name FROM sqlite_master WHERE type = 'index'", [])).map(
      (row) => row.name
    )
    for (const index of ['idx_facts_layer_created', 'idx_relations_subject', 'idx_beliefs_topic', 'idx_prompt_blocks_order']) {
      assert.ok(indexes.includes(index), `missing index: ${index}`)
    }
    // The engine that actually ran is recorded, and `meta` carries the version.
    assert.ok(['node:sqlite', 'sql.js'].includes(service.engine), `unexpected engine: ${service.engine}`)
    const version = await service.db.get('SELECT value FROM meta WHERE key = ?', ['schema_version'])
    assert.equal(version.value, SCHEMA_VERSION)
  } finally {
    await cleanup()
  }
})

test('schema: the first migration seeds the hard-rules prompt block exactly once', async () => {
  const { service, cleanup } = await tempService('schema-seed')
  try {
    const rows = await service.db.all('SELECT * FROM prompt_blocks', [])
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, 'user-rules')
    assert.equal(rows[0].title, '用户硬性协作流程')
    assert.equal(rows[0].position, 0)
    assert.equal(rows[0].enabled, 1)
    assert.equal(rows[0].body, RULES, 'the seed body must be the retired bundle\'s RULES verbatim')
    assert.notEqual(rows[0].created_at, '')
    assert.notEqual(rows[0].updated_at, '')
    assert.notEqual(await service.db.get("SELECT value FROM meta WHERE key = 'prompt_blocks_seeded'", []), undefined)

    // Running the migration again (every open does) must not add a second row.
    await service.migrate()
    assert.equal((await service.db.all('SELECT id FROM prompt_blocks', [])).length, 1)
  } finally {
    await cleanup()
  }
})

test('schema: opening the same file twice is idempotent', async () => {
  const dir = tempDir('reopen')
  const opts = { memoryDir: dir, dbFile: path.join(dir, 'memory.db'), logger: silent() }
  const first = await openMemoryService(opts)
  await first.ingestFact({ content: '用户偏好 pnpm 而不是 npm。', layer: 'experience', confidence: 0.8, tags: ['pref'] })
  await first.close()

  const second = await openMemoryService(opts)
  try {
    assert.equal((await second.allFacts()).length, 1)
    assert.equal((await second.counts()).facts, 1)
  } finally {
    await second.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('extract: candidates are rewritten, not copied, and carry the five slots', () => {
  const turns = [
    userTurn(
      '嗯，我决定把 dsh-memory-rules 插件的数据库改成 SQLite，因为 Markdown 检索太慢了。今天已经装好了 sql.js 作为兜底。'
    ),
    assistantTurn('结论是：优先使用 node:sqlite，只有在 Node 版本低于 22.5 时才回退到 sql.js。')
  ]
  const facts = extractFacts(turns, { now: new Date(2026, 9, 14, 21, 0, 0), sessionId: 'session-x' })
  assert.ok(facts.length >= 2, `expected several facts, got ${facts.length}`)

  for (const fact of facts) {
    assert.ok(['world', 'experience', 'conclusion'].includes(fact.layer), `bad layer: ${fact.layer}`)
    assert.ok(fact.content.length > 0)
    assert.ok(fact.confidence > 0 && fact.confidence <= 0.99)
    assert.ok(Array.isArray(fact.tags) && fact.tags.includes(fact.layer))
    assert.ok(Array.isArray(fact.entities))
    assert.ok(Array.isArray(fact.relations))
    assert.ok(typeof fact.rawQuote === 'string' && fact.rawQuote.length > 0, 'rawQuote must keep the source')
    assert.ok(fact.timeRef && typeof fact.timeRef === 'object', 'timeRef slot must exist')
  }

  const sqliteFact = facts.find((fact) => fact.content.includes('SQLite'))
  assert.ok(sqliteFact, 'the SQLite decision must be extracted')
  // 不照搬原文: the stored statement is a rewrite, and the original is only kept
  // as the audit quote.
  assert.ok(sqliteFact.content.length < sqliteFact.rawQuote.length, 'content should be shorter than the quote')
  assert.ok(!/^嗯/.test(sqliteFact.content), 'leading filler must be stripped')
  assert.ok(/用户/.test(sqliteFact.content), 'first person must be rewritten to third person')

  const conclusion = facts.find((fact) => fact.layer === 'conclusion')
  assert.ok(conclusion, 'the explicit conclusion must be classified as a conclusion')
  assert.ok(/node:sqlite|sql\.js/.test(conclusion.content))
})

test('extract: code, links and duplicates are kept out of the memory', () => {
  const facts = extractFacts(
    [
      userTurn('看看这段：\n```js\nconst db = new DatabaseSync("a.db")\n```\n就这样。'),
      userTurn('用户偏好 SQLite。用户偏好 SQLite。')
    ],
    {}
  )
  assert.ok(!facts.some((fact) => fact.content.includes('DatabaseSync')), 'fenced code must not become a fact')
  const sqlite = facts.filter((fact) => fact.content.includes('SQLite'))
  assert.equal(sqlite.length, 1, 'a repeated statement must be stored once')
})

test('ingest: extracted facts are written into the correct layer', async () => {
  const { service, cleanup } = await tempService('layers')
  try {
    const result = await service.ingestTurn(
      [
        userTurn('TypeScript 是 JavaScript 的超集，这一点长期成立。'),
        userTurn('今天我把记忆插件的数据库从 Markdown 换成了 SQLite。'),
        assistantTurn('所以结论是：检索要先走常设答案，再走四路召回。')
      ],
      { sessionId: 'session-layer', createdAt: '2026-10-14T21:00:00+08:00' }
    )
    assert.ok(result.facts.length >= 1, 'at least one fact must be stored')

    const rows = await service.allFacts()
    assert.ok(rows.length >= 1)
    for (const row of rows) {
      assert.ok(['world', 'experience'].includes(row.layer), `facts.layer must be world|experience, got ${row.layer}`)
      assert.equal(row.sourceSession, 'session-layer')
      assert.equal(row.createdAt, '2026-10-14T21:00:00+08:00')
      assert.ok(Array.isArray(row.tags))
      assert.ok(row.embedding.length === 256, 'each fact carries its semantic vector')
    }
    const world = rows.filter((row) => row.layer === 'world')
    const experience = rows.filter((row) => row.layer === 'experience')
    assert.ok(world.length >= 1, 'the general statement must land in the world layer')
    assert.ok(experience.length >= 1, 'the dated action must land in the experience layer')

    // Ingestion is idempotent: the same turn twice stores nothing new.
    const second = await service.ingestTurn(
      [userTurn('今天我把记忆插件的数据库从 Markdown 换成了 SQLite。')],
      { sessionId: 'session-layer', createdAt: '2026-10-14T21:01:00+08:00' }
    )
    assert.equal(second.facts.length, 0)
    assert.ok(second.duplicates >= 1)
  } finally {
    await cleanup()
  }
})

test('ingest: relations stay in sync with their source fact', async () => {
  const { service, cleanup } = await tempService('relations')
  try {
    const { stored } = await service.ingestFact({
      content: 'dsh-memory-rules 使用 SQLite 作为记忆数据库',
      layer: 'world',
      confidence: 0.8,
      tags: ['config'],
      relations: [{ subject: 'dsh-memory-rules', predicate: 'uses', object: 'SQLite' }]
    })
    const edges = await service.allRelations()
    assert.equal(edges.length, 1)
    assert.deepEqual(
      { subject: edges[0].subject, predicate: edges[0].predicate, object: edges[0].object },
      { subject: 'dsh-memory-rules', predicate: 'uses', object: 'SQLite' }
    )
    assert.equal(edges[0].source_fact_id, stored.id)

    // Re-ingesting the same fact must not duplicate the edge.
    await service.ingestFact({
      content: 'dsh-memory-rules 使用 SQLite 作为记忆数据库',
      layer: 'world',
      relations: [{ subject: 'dsh-memory-rules', predicate: 'uses', object: 'SQLite' }]
    })
    assert.equal((await service.allRelations()).length, 1)

    // A manual edge has no source fact and is de-duplicated by its own id.
    await service.addRelation({ subject: '用户', predicate: 'prefers', object: 'pnpm' })
    await service.addRelation({ subject: '用户', predicate: 'prefers', object: 'pnpm' })
    const all = await service.allRelations()
    assert.equal(all.length, 2)
    assert.equal(all.find((edge) => edge.predicate === 'prefers').source_fact_id, null)

    // Deleting a fact cascades to its derived edges only.
    await service.db.run('DELETE FROM facts WHERE id = ?', [stored.id])
    const after = await service.allRelations()
    assert.equal(after.length, 1)
    assert.equal(after[0].predicate, 'prefers')
  } finally {
    await cleanup()
  }
})

test('ingest: a relation is extracted from an explicit sentence', () => {
  const facts = extractFacts([userTurn('dsh-memory-rules 插件使用 SQLite 存记忆，因为 Markdown 太慢。')], {})
  const withRelation = facts.filter((fact) => fact.relations.length > 0)
  assert.ok(withRelation.length >= 1, 'an explicit "A 使用 B" sentence must produce a relation')
  const relation = withRelation[0].relations[0]
  assert.ok(relation.subject.length > 0 && relation.object.length > 0)
  assert.equal(relation.predicate, 'uses')
})

test('ingest: the four layers are addressable through one API', async () => {
  const { service, cleanup } = await tempService('fourlayers')
  try {
    await service.ingestFact({
      content: 'SQLite 是一个嵌入式关系数据库',
      layer: 'world',
      confidence: 0.8,
      tags: ['world']
    })
    await service.ingestFact({
      content: '用户在 2026-10-14 升级了记忆插件',
      layer: 'experience',
      confidence: 0.8,
      tags: ['event']
    })
    const answer = await service.saveAnswer({ question: '记忆库放在哪里？', answer: '~/.dsh/memory/memory.db' })
    assert.equal(answer.updated, false)

    // belief layer: written by `reflect` (Step 3), asserted here through the
    // raw row shape so Step 1 can prove the table and decoder are wired.
    await service.db.run(
      `INSERT INTO beliefs (id, topic, statement, evidence_ids, evidence_count, strength, updated_at, created_at, layer, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['belief_x', '记忆存储', '记忆存储在 SQLite 中', '[]', 0, 0.5, '2026-10-14T21:00:00+08:00', '2026-10-14T21:00:00+08:00', 'world', 0]
    )

    const counts = await service.counts()
    assert.equal(counts.facts, 2)
    assert.equal(counts.answers, 1)
    assert.equal(counts.beliefs, 1)

    const world = await service.factsByLayer('world')
    const experience = await service.factsByLayer('experience')
    assert.equal(world.length, 1)
    assert.equal(experience.length, 1)
    assert.equal((await service.allBeliefs()).length, 1)
    assert.equal((await service.allAnswers()).length, 1)

    const decoded = decodeFact({
      id: 'f',
      content: 'c',
      layer: 'world',
      confidence: '0.7',
      tags: '["a"]',
      created_at: 'now',
      embedding: null
    })
    assert.deepEqual(decoded.tags, ['a'])
    assert.equal(decoded.confidence, 0.7)
    assert.equal(decoded.embedding, undefined)
    assert.equal(decodeBelief({ id: 'b', evidence_ids: '["1","2"]', evidence_count: 2, strength: '0.4' }).evidenceIds.length, 2)
    assert.equal(decodeAnswer({ id: 'a', question_pattern: '["q1","q2"]', cached_answer: 'x', hits: '3' }).hits, 3)
  } finally {
    await cleanup()
  }
})

test('answers: saving the same question again refreshes the row instead of adding one', async () => {
  // Regression: the lookup compared the bare question against `question_pattern`,
  // which holds the JSON array of every phrasing — a bare question never equals
  // its own serialised array, so the match never happened. Every save inserted a
  // new row and the earliest one kept winning the read path, which is how a
  // stale standing answer survived being "corrected" twice.
  const { service, cleanup } = await tempService('answer-upsert')
  try {
    const first = await service.saveAnswer({ question: '记忆库放在哪里？', answer: '`~/.dsh/memory/memory.db`' })
    assert.equal(first.updated, false, 'the first save of a question inserts')

    const again = await service.saveAnswer({
      question: '记忆库放在哪里？',
      questions: ['memory.db 在哪'],
      answer: '改用 `DSH_MEMORY_DB` 可覆盖'
    })
    assert.equal(again.updated, true, 'the second save must refresh the existing row')
    assert.equal(again.id, first.id, 'and must keep its id')

    const rows = await service.allAnswers()
    assert.equal(rows.length, 1, 'a repeated question must not add a row')
    assert.match(rows[0].answer, /DSH_MEMORY_DB/, 'the stored text is the newer one')
    assert.deepEqual(
      [...rows[0].questions].sort(),
      ['memory.db 在哪', '记忆库放在哪里？'].sort(),
      'phrasings from both saves are kept'
    )

    const hit = await service.retrieve('记忆库放在哪里？', {}, '2026-10-14T22:00:00+08:00')
    assert.equal(hit.stats.fromAnswer, true)
    assert.match(hit.answer.text, /DSH_MEMORY_DB/, 'the read path serves the refreshed text')
  } finally {
    await cleanup()
  }
})

test('extract: inline code keeps its payload instead of leaving a broken sentence', () => {
  const facts = extractFacts([userTurn('导出 6 份文档，全部是给人看的、可 `grep` 的 Markdown。')], {})
  assert.equal(facts.length, 1)
  // The identifier must survive; dropping it left "可 的 Markdown".
  assert.match(facts[0].content, /grep/)
  assert.doesNotMatch(facts[0].content, /可\s+的/)

  const files = extractFacts([userTurn('旧 `lib/store.js` / `lib/capture.js` 已被 `service.js` 吸收。')], {})
  assert.ok(files.length >= 1)
  assert.match(files[0].content, /store\.js/)
  assert.match(files[0].content, /service\.js/)
})

test('extract: a sentence cut mid-thought is never stored', () => {
  // Every string here was, at some point, a real row in the live store, and was
  // then recalled into later turns as if it were a memory.
  const fragments = [
    '如果还失败，说明用户的修复另有问题：',
    '现在核查用户上一轮标出的两处修复和唯一的遗留疑点：',
    '同时发现一条漏网：',
    '结论是：',
    '下面是三个要点：',
    '三条结果分别是'
  ]
  for (const fragment of fragments) {
    assert.equal(isCompleteStatement(fragment), false, `must reject: ${fragment}`)
  }
  for (const statement of [
    '用户决定把记忆插件的数据库换成 SQLite，因为 Markdown 检索太慢了。',
    '工具注册是同步的、服务打开是异步的。',
    'DSH 插件开发的三个实战坑（2026-10-14 在 dsh-memory-rules v2 上踩到并修复）'
  ]) {
    assert.equal(isCompleteStatement(statement), true, `must accept: ${statement}`)
  }
  // ...and the gate is wired into extraction, not merely exported.
  assert.equal(extractFacts([userTurn('如果还失败，说明用户的修复另有问题：')], {}).length, 0)
})

test('ingest: assembled context blocks are not extracted as conversation', async () => {
  const { service, cleanup } = await tempService('injected')
  try {
    // The harness injects the runtime snapshot, the skill catalog and file
    // contents as `role: 'user'` messages. Their sentences look exactly like
    // facts, so the guard has to reject them before extraction.
    const batch = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.' }
        ],
        source: { kind: 'user' }
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              '- `office-docx`: Create, read, edit, and check Word documents (.docx). Use when a DOCX file is an ' +
              'input or requested deliverable. <available_skills>'
          }
        ],
        source: { kind: 'user' }
      },
      // A genuinely long paste is assembled input too.
      {
        role: 'user',
        content: [{ type: 'text', text: `用户粘贴了一大段文件内容。${'填充内容'.repeat(400)}` }],
        source: { kind: 'user' }
      },
      // The real conversation.
      { role: 'user', content: [{ type: 'text', text: '用户决定把记忆库的数据库换成 SQLite。' }], source: { kind: 'user' } },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '所以结论是：先跑四路检索，命中常设答案就不再检索。' }],
        source: { kind: 'assistant' }
      },
      // Short but harness-authored: the *label* is what disqualifies it, not its
      // length or wording. This is how the plugin's own recall injection looks.
      {
        role: 'user',
        content: [{ type: 'text', text: '用户偏好 TypeScript。' }],
        source: { kind: 'memory' }
      },
      {
        role: 'user',
        content: [{ type: 'text', text: '用户偏好 JavaScript。' }],
        source: { kind: 'system' }
      }
    ]
    const result = await service.ingestMessages(batch, { sessionId: 'session-injected' })
    assert.equal(result.skipped, 5, 'the three assembled blocks and two labelled messages must be skipped')
    assert.equal(result.turns, 2, 'only the two spoken turns are extracted')
    assert.ok(result.facts.length >= 1)
    for (const fact of result.facts) {
      assert.doesNotMatch(fact.content, /available_skills|task-specific|DOCX file is an input/)
      assert.doesNotMatch(fact.content, /Current runtime context/)
    }
    assert.equal((await service.counts()).facts, result.facts.length)
  } finally {
    await cleanup()
  }
})

test('ingest: an archived fact is withdrawn from retrieval but kept in the store', async () => {
  const { service, cleanup } = await tempService('archived')
  try {
    const { stored } = await service.ingestFact({
      content: '用户使用 npm 管理依赖',
      layer: 'experience',
      confidence: 0.7,
      tags: ['preference']
    })
    await service.ingestFact({
      content: '用户使用 pnpm 管理依赖',
      layer: 'experience',
      confidence: 0.7,
      tags: ['preference']
    })
    service.invalidate()
    assert.equal((await service.retrieve('用什么管理依赖', { limit: 5 })).results.length, 2)

    // Archiving is the "this extraction was never valid" state; it is distinct
    // from `superseded_by`, which means "a newer claim replaced this one and it
    // is still evidence for a belief".
    await service.db.run('UPDATE facts SET archived_at = ? WHERE id = ?', ['2026-10-14T22:00:00+08:00', stored.id])
    service.invalidate()
    const after = await service.retrieve('用什么管理依赖', { limit: 5 })
    assert.ok(
      !after.results.some((entry) => entry.id === stored.id),
      'an archived fact must not be retrievable'
    )
    // ...but the row and its content are untouched.
    const rows = await service.allFacts({ includeSuperseded: true })
    assert.equal(rows.length, 2, 'the archived row stays in the store')
    const archived = rows.find((row) => row.id === stored.id)
    assert.equal(archived.content, '用户使用 npm 管理依赖')
    assert.equal(archived.archivedAt, '2026-10-14T22:00:00+08:00')

    // Restoring is a single column write, which is what makes the cleanup
    // reversible.
    await service.db.run('UPDATE facts SET archived_at = NULL WHERE id = ?', [stored.id])
    service.invalidate()
    assert.equal((await service.retrieve('用什么管理依赖', { limit: 5 })).results.length, 2)
  } finally {
    await cleanup()
  }
})

test('schema: the archived_at migration is additive and idempotent', async () => {
  const dir = tempDir('migrate-archived')
  const opts = { memoryDir: dir, dbFile: path.join(dir, 'memory.db'), logger: silent() }
  // Simulate a store created before `archived_at` existed: drop the column's
  // index and the column itself, then reopen.
  const first = await openMemoryService(opts)
  await first.ingestFact({ content: '迁移前写入的事实', layer: 'experience', confidence: 0.6 })
  await first.db.exec('DROP INDEX IF EXISTS idx_facts_archived')
  await first.db.exec('ALTER TABLE facts DROP COLUMN archived_at')
  await first.close()

  const second = await openMemoryService(opts)
  const info = await second.db.all('PRAGMA table_info(facts)', [])
  assert.ok(info.some((entry) => entry.name === 'archived_at'), 'the column must be re-added')
  const indexes = (await second.db.all("SELECT type, name FROM sqlite_master WHERE type = 'index'", [])).map(
    (row) => row.name
  )
  assert.ok(indexes.includes('idx_facts_archived'), 'the index must follow the column')
  const rows = await second.allFacts()
  assert.equal(rows.length, 1, 'the existing row must survive the migration')
  assert.equal(rows[0].archivedAt, null)
  await second.close()

  // A third open is a no-op.
  const third = await openMemoryService(opts)
  try {
    assert.equal((await third.allFacts()).length, 1)
  } finally {
    await third.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('schema: the beliefs.archived_at migration is additive and idempotent', async () => {
  const dir = tempDir('migrate-belief-archived')
  const opts = { memoryDir: dir, dbFile: path.join(dir, 'memory.db'), logger: silent() }
  const first = await openMemoryService(opts)
  await first.db.run(
    `INSERT INTO beliefs (id, topic, statement, evidence_ids, evidence_count, strength, updated_at, created_at, layer, revision)
     VALUES ('belief_migrate', '迁移', '迁移前的信念', '[]', 0, 0.6, '2026-10-20T10:00:00+08:00', '2026-10-20T10:00:00+08:00', 'experience', 0)`,
    []
  )
  await first.db.exec('DROP INDEX IF EXISTS idx_beliefs_archived')
  await first.db.exec('ALTER TABLE beliefs DROP COLUMN archived_at')
  await first.close()

  const second = await openMemoryService(opts)
  const info = await second.db.all('PRAGMA table_info(beliefs)', [])
  assert.ok(info.some((entry) => entry.name === 'archived_at'), 'the column must be re-added')
  const indexes = (await second.db.all("SELECT type, name FROM sqlite_master WHERE type = 'index'", [])).map(
    (row) => row.name
  )
  assert.ok(indexes.includes('idx_beliefs_archived'), 'the index must follow the column')
  const beliefs = await second.allBeliefs()
  assert.equal(beliefs.length, 1, 'the existing belief must survive the migration')
  assert.equal(beliefs[0].archivedAt, null)
  await second.close()

  const third = await openMemoryService(opts)
  try {
    assert.equal((await third.allBeliefs()).length, 1)
  } finally {
    await third.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('ingest: the Markdown mirror appends without destroying the day file', async () => {
  const { service, dir, cleanup } = await tempService('mirror', { markdownMirror: true })
  try {
    await service.ingestFact(
      { content: '用户偏好 TypeScript', layer: 'experience', confidence: 0.8, tags: ['pref'] },
      { createdAt: '2026-10-14T10:00:00+08:00' }
    )
    const file = path.join(dir, '2026-10-14.md')
    const first = fs.readFileSync(file, 'utf8')
    assert.match(first, /# Memory — 2026-10-14/)
    assert.match(first, /偏好 TypeScript/)

    fs.appendFileSync(file, '\n## 手写笔记\n\n保留我\n', 'utf8')
    await service.ingestFact(
      { content: '用户偏好 pnpm', layer: 'experience', confidence: 0.8, tags: ['pref'] },
      { createdAt: '2026-10-14T11:00:00+08:00' }
    )
    const second = fs.readFileSync(file, 'utf8')
    assert.match(second, /保留我/)
    assert.match(second, /偏好 pnpm/)
  } finally {
    await cleanup()
  }
})

test('db: the engine probe reports an actionable capability set', () => {
  const probe = probeEngines()
  assert.ok(probe.preferred, 'at least one engine must be available in this runtime')
  assert.equal(typeof probe.nodeVersion, 'string')
  if (probe.preferred === 'sql.js') {
    assert.equal(probe.nodeSqlite, false, 'sql.js is only preferred when node:sqlite is absent')
  }
})

test('db: MemoryService rejects an empty fact', async () => {
  const { service, cleanup } = await tempService('emptyfact')
  try {
    await assert.rejects(() => service.ingestFact({ content: '   ' }), /non-empty content/)
    assert.equal(await service.flush(), false)
  } finally {
    await cleanup()
  }
})

/** A logger that swallows everything, for tests that only care about state. */
function silent() {
  return { info() {}, warn() {}, debug() {}, error() {} }
}

void MemoryService
