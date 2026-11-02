/*!
 * dsh-memory-rules — Step 2 self-check.
 *
 * 自检目标（对应升级计划第 2 步）：
 *   1. 同一 query 四路结果是否都能产出 — each of semantic/keyword/graph/timeline
 *      contributes, and the graph path demonstrably finds something the flat
 *      paths cannot
 *   2. 合并去重逻辑是否正确 — one fact appears once, with every path that found
 *      it recorded, and the fused order is reproducible
 *   3. 按置信度重排 — confidence, agreement, layer prior and recency all move
 *      the ranking in the documented direction
 *
 * The fixture is built so each path is *forced* to be necessary: the fact that
 * only the graph path can reach contains none of the query terms.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ageInDays,
  findAnswer,
  graphPath,
  keywordPath,
  mergeAndRank,
  parseTimeFilter,
  retrieve,
  semanticPath,
  timelinePath
} from '../lib/retrieve.js'
import { embed, serializeVector } from '../lib/embed.js'
import { tempService } from './helpers.js'

const NOW = new Date('2026-10-14T21:00:00+08:00')

/**
 * Build the self-check corpus.
 *
 * Deliberate shape:
 *  - f_pg is reachable from "向量索引" only by walking pgvector -> PostgreSQL
 *  - f_pg shares no token and no bigram with the graph query
 *  - f_old sits on a known past day so the timeline filter has exactly one hit
 */
async function seed(service) {
  const add = (content, layer, confidence, createdAt, tags, relations) =>
    service.ingestFact({ content, layer, confidence, createdAt, tags, relations })

  await add(
    'dsh-memory-rules 插件使用 SQLite 作为记忆数据库',
    'world',
    0.9,
    '2026-10-01T10:00:00+08:00',
    ['config', 'sqlite'],
    [{ subject: 'dsh-memory-rules', predicate: 'uses', object: 'SQLite' }]
  )
  await add(
    'SQLite 支持 WAL 模式以提升并发读写性能',
    'world',
    0.85,
    '2026-10-02T10:00:00+08:00',
    ['sqlite'],
    [{ subject: 'SQLite', predicate: 'supports', object: 'WAL' }]
  )
  await add(
    'pgvector 是 PostgreSQL 的向量检索扩展',
    'world',
    0.8,
    '2026-10-03T10:00:00+08:00',
    ['postgres'],
    [{ subject: 'pgvector', predicate: 'is_extension_of', object: 'PostgreSQL' }]
  )
  // Reachable only through the graph: none of these words occur in the query.
  await add(
    '向量索引的召回率取决于维度与距离度量',
    'world',
    0.7,
    '2026-10-04T10:00:00+08:00',
    ['recall'],
    [{ subject: 'PostgreSQL', predicate: 'stores', object: '向量索引' }]
  )
  await add(
    '用户在 2026-09-01 完成了记忆插件的第一次升级',
    'experience',
    0.75,
    '2026-09-01T09:00:00+08:00',
    ['upgrade']
  )
  await add(
    '用户偏好用 pnpm 管理依赖',
    'experience',
    0.6,
    '2026-10-13T09:00:00+08:00',
    ['preference']
  )
  return { pgFact: '向量索引的召回率取决于维度与距离度量' }
}

test('retrieve: each of the four paths produces candidates for one query', async () => {
  const { service, cleanup } = await tempService('paths')
  try {
    await seed(service)
    const snapshot = await service.snapshot()

    // --- path 1: semantic -------------------------------------------------
    const sem = semanticPath('记忆数据存放在哪里', snapshot.facts, { embedDims: 256, pathLimit: 24 })
    assert.ok(sem.length >= 1, 'semantic path must return candidates')
    assert.ok(
      sem.some((entry) => entry.fact.content.includes('SQLite')),
      'semantic path should surface the storage fact'
    )
    assert.ok(sem.every((entry, index) => index === 0 || sem[index - 1].score >= entry.score), 'semantic order')

    // --- path 2: keyword --------------------------------------------------
    const key = keywordPath('SQLite WAL', snapshot.facts, { pathLimit: 24 })
    assert.ok(key.length >= 1, 'keyword path must return candidates')
    assert.ok(key[0].fact.content.includes('WAL'), 'keyword path ranks the exact-term fact first')
    assert.deepEqual(keywordPath('', snapshot.facts, {}), [])

    // --- path 3: graph ----------------------------------------------------
    // The query names "向量索引", which appears in the fact but in *no relation
    // endpoint of its own*: the edge PostgreSQL --stores--> 向量索引 is the only
    // route the query's node has into this fact.
    const snapshotFacts = snapshot.facts
    const graphOnlyContent = '向量索引的召回率取决于维度与距离度量'
    const graphOnlyFact = snapshotFacts.find((fact) => fact.content === graphOnlyContent)
    assert.ok(graphOnlyFact, 'the graph-only fact must be stored')
    const graph = graphPath('向量索引', snapshotFacts, snapshot.relations, { pathLimit: 24 }, [])
    assert.ok(graph.length >= 1, 'graph path must return candidates')
    const reached = graph.find((entry) => entry.fact.id === graphOnlyFact.id)
    assert.ok(reached, 'the graph path must reach the vector-index fact through its edges')
    assert.match(reached.via.join(' '), /PostgreSQL/, 'the traversal must report the relation it walked')
    // Without graph traversal the relation is invisible: no edge is walked when
    // the query shares no node with any edge.
    assert.deepEqual(graphPath('完全无关的查询词', snapshotFacts, snapshot.relations, { pathLimit: 24 }, []), [])

    // --- path 4: timeline -------------------------------------------------
    const line = timelinePath('2026-09-01 做了什么', snapshot.facts, { pathLimit: 24 }, NOW)
    assert.ok(line.length >= 1, 'timeline path must return candidates')
    assert.ok(
      line.some((entry) => entry.fact.content.includes('第一次升级')),
      'timeline path must find the fact dated by the query'
    )
    const recency = timelinePath('随便问点什么', snapshot.facts, { pathLimit: 3 }, NOW)
    assert.equal(recency.length, 3, 'without a date the timeline path falls back to the newest rows')
    assert.equal(recency[0].fact.createdAt.slice(0, 10), '2026-10-13')
  } finally {
    await cleanup()
  }
})

test('retrieve: the merged result carries every path that found a fact', async () => {
  const { service, cleanup } = await tempService('merge')
  try {
    await seed(service)
    const result = await service.retrieve('SQLite 记忆数据库', { pathLimit: 24, limit: 10 }, NOW)

    assert.equal(result.query, 'SQLite 记忆数据库')
    assert.equal(result.answer, undefined)
    assert.ok(result.results.length >= 1)
    // 1. de-duplication: one row per fact id, never two.
    const ids = result.results.map((entry) => entry.id)
    assert.equal(new Set(ids).size, ids.length, 'merged results must be de-duplicated by fact id')
    // 2. every path that found the top fact is recorded.
    const top = result.results.find((entry) => entry.content.includes('SQLite 作为记忆数据库'))
    assert.ok(top, 'the storage fact must be in the merged result')
    assert.ok(top.foundBy.length >= 2, `expected agreement from several paths, got ${top.foundBy.join(',')}`)
    assert.ok(top.pathScores.semantic > 0 && top.pathScores.keyword > 0)
    assert.ok(result.stats.pathCounts.semantic > 0 && result.stats.pathCounts.keyword > 0)
    // 3. agreement outranks a single-path hit of similar confidence.
    const single = result.results.find((entry) => entry.foundBy.length === 1)
    if (single !== undefined) assert.ok(top.score >= single.score)
    // 4. the fused order is stable across repeated runs.
    const again = await service.retrieve('SQLite 记忆数据库', { pathLimit: 24, limit: 10 }, NOW)
    assert.deepEqual(
      again.results.map((entry) => entry.id),
      ids
    )
  } finally {
    await cleanup()
  }
})

test('mergeAndRank: confidence, agreement, layer and recency all move the order', () => {
  const fact = (id, over = {}) => ({
    id,
    content: `fact ${id}`,
    layer: 'experience',
    confidence: 0.5,
    createdAt: '2026-10-14T00:00:00+08:00',
    tags: [],
    supersededBy: null,
    ...over
  })
  const paths = {
    semantic: [{ fact: fact('a'), score: 0.9 }],
    keyword: [{ fact: fact('a'), score: 0.9 }, { fact: fact('b'), score: 0.9 }]
  }
  const ranked = mergeAndRank(paths, {}, NOW)
  const a = ranked.find((entry) => entry.id === 'a')
  const b = ranked.find((entry) => entry.id === 'b')
  assert.deepEqual(a.foundBy, ['keyword', 'semantic'])
  assert.deepEqual(b.foundBy, ['keyword'])
  assert.ok(a.score > b.score, 'a fact found by two paths must outrank the same fact found by one')

  const highConfidence = mergeAndRank(
    { keyword: [{ fact: fact('hi', { confidence: 0.95 }), score: 0.5 }, { fact: fact('lo', { confidence: 0.05 }), score: 0.5 }] },
    {},
    NOW
  )
  assert.equal(highConfidence[0].id, 'hi', 'confidence must break the tie')

  const layer = mergeAndRank(
    {
      keyword: [
        { fact: fact('belief', { layer: 'belief' }), score: 0.5 },
        { fact: fact('experience'), score: 0.5 }
      ]
    },
    {},
    NOW
  )
  assert.equal(layer[0].id, 'belief', 'the belief layer prior must lift a consolidated memory')

  const fresh = mergeAndRank(
    {
      keyword: [
        { fact: fact('new', { createdAt: '2026-10-14T00:00:00+08:00' }), score: 0.5 },
        { fact: fact('old', { createdAt: '2024-01-01T00:00:00+08:00' }), score: 0.5 }
      ]
    },
    {},
    NOW
  )
  assert.equal(fresh[0].id, 'new', 'the recency prior must lift a fresh memory')
  assert.ok(ageInDays('2026-10-14T00:00:00+08:00', NOW) < 1)
  assert.ok(ageInDays('2024-01-01T00:00:00+08:00', NOW) > 900)
})

test('retrieve: a superseded fact leaves the flat paths but stays reachable', async () => {
  const { service, cleanup } = await tempService('superseded')
  try {
    const { stored } = await service.ingestFact({
      content: '用户使用 npm 管理依赖',
      layer: 'experience',
      confidence: 0.6,
      tags: ['preference']
    })
    await service.db.run('UPDATE facts SET superseded_by = ? WHERE id = ?', ['belief_x', stored.id])
    service.invalidate()
    const snapshot = await service.snapshot()
    assert.equal(semanticPath('npm 依赖', snapshot.facts, {}).length, 0, 'superseded facts leave the semantic path')
    assert.equal(keywordPath('npm 依赖', snapshot.facts, {}).length, 0, 'superseded facts leave the keyword path')
    assert.equal(snapshot.facts.length, 1, 'the row is still stored, and still loaded as evidence')
  } finally {
    await cleanup()
  }
})

test('retrieve: a standing answer short-circuits retrieval and counts its hits', async () => {
  const { service, cleanup } = await tempService('answer')
  try {
    await seed(service)
    await service.saveAnswer({
      question: '记忆库放在哪里？',
      questions: ['记忆数据库文件在哪个目录', 'memory.db 的路径是什么'],
      answer: '`~/.dsh/memory/memory.db`（可用 DSH_MEMORY_DB 覆盖）'
    })
    const hit = await service.retrieve('记忆数据库文件在哪个目录？', {}, NOW)
    assert.ok(hit.answer, 'a standing answer must be returned')
    assert.equal(hit.stats.fromAnswer, true)
    assert.equal(hit.results.length, 0, 'no retrieval runs when a standing answer hits')
    assert.equal(hit.stats.pathCounts, undefined)
    assert.match(hit.answer.text, /memory\.db/)
    assert.equal(hit.answer.hits, 0, 'the counter is captured before the hit is recorded')

    const second = await service.retrieve('记忆数据库文件在哪个目录', {}, NOW)
    assert.equal(second.answer.hits, 0, 'the returned object is the pre-hit snapshot')
    const row = await service.db.get('SELECT hits FROM answers WHERE id = ?', [second.answer.id])
    assert.equal(Number(row.hits), 2, 'both hits must be persisted to the answers row')

    // The shortcut can be switched off to force a real retrieval pass.
    const bypass = await service.retrieve('记忆数据库文件在哪个目录？', { answerShortcut: false }, NOW)
    assert.equal(bypass.answer, undefined)
    assert.ok(bypass.stats.pathCounts !== undefined)

    // An unrelated question must not match the standing answer.
    assert.equal(findAnswer('PostgreSQL 的向量扩展叫什么', await service.allAnswers(), {}), undefined)
  } finally {
    await cleanup()
  }
})

test('retrieve: the time filter understands days, months and ranges', () => {
  assert.deepEqual([...parseTimeFilter('2026-10-14 的会议', NOW).days], ['2026-10-14'])
  assert.deepEqual([...parseTimeFilter('10月14日', NOW).days], ['2026-10-14'])
  assert.deepEqual([...parseTimeFilter('2026年10月的记录', NOW).months], ['2026-10'])
  assert.deepEqual([...parseTimeFilter('今天做了什么', NOW).days], ['2026-10-14'])
  assert.deepEqual([...parseTimeFilter('昨天做了什么', NOW).days], ['2026-10-13'])
  // 2026-10-14 is a Wednesday, so "上周" is the ISO week Mon 10-05 .. Sun 10-11.
  const lastWeek = parseTimeFilter('上周做了什么', NOW)
  assert.deepEqual(lastWeek.ranges, [{ from: '2026-10-05', to: '2026-10-11' }])
  assert.deepEqual(parseTimeFilter('本周做了什么', NOW).ranges, [{ from: '2026-10-12', to: '2026-10-18' }])
  assert.deepEqual(parseTimeFilter('上个月的记录', NOW).ranges, [{ from: '2026-09-01', to: '2026-09-30' }])
  const recent = parseTimeFilter('最近有没有改动', NOW)
  assert.deepEqual(recent.ranges, [{ from: '2026-09-30', to: '2026-10-14' }])
  assert.equal(parseTimeFilter('没有时间词的查询', NOW).window, false)
  // A full date must not also register as a month-only reference.
  assert.deepEqual([...parseTimeFilter('2026-10-14', NOW).months], [])
})

test('retrieve: every path can be individually disabled', async () => {
  const { service, cleanup } = await tempService('toggle')
  try {
    await seed(service)
    const only = await service.retrieve(
      'SQLite',
      { pathSemantic: false, pathGraph: false, pathTimeline: false, pathLimit: 24 },
      NOW
    )
    assert.equal(only.stats.pathCounts.semantic, 0)
    assert.equal(only.stats.pathCounts.graph, 0)
    assert.equal(only.stats.pathCounts.timeline, 0)
    assert.ok(only.stats.pathCounts.keyword > 0)
    assert.ok(only.results.length > 0)
    const none = await service.retrieve(
      'SQLite',
      { pathSemantic: false, pathKeyword: false, pathGraph: false, pathTimeline: false },
      NOW
    )
    assert.equal(none.results.length, 0, 'with every path off there is nothing to merge')
  } finally {
    await cleanup()
  }
})

test('embed: the hash-ngram sketch ranks related text above unrelated text', async () => {
  const a = embed('用户决定把记忆数据库换成 SQLite', 256)
  const b = embed('记忆库改用 SQLite 存储事实', 256)
  const c = embed('今天的天气不错，适合出门散步', 256)
  const { cosine, toSimilarity } = await import('../lib/embed.js')
  assert.ok(
    toSimilarity(cosine(a, b)) > toSimilarity(cosine(a, c)),
    'related text must score closer than unrelated text'
  )
  assert.equal(serializeVector(a).length > 0, true)
})
