#!/usr/bin/env node
/*!
 * dsh-memory-rules — offline retrieval A/B ("离线评测").
 *
 * Runs the same queries through the same store twice: once with the pre-3.2
 * ranking, once with the 3.2 ranking, and prints what actually changed. This
 * exists because "改了权重，感觉更准了" is not evidence — the store grows every
 * day, so a before/after comparison taken on different days measures the data,
 * not the change. Both arms here read one frozen copy of the database.
 *
 * The store is copied before opening: the evaluation must never be able to
 * migrate, checkpoint or lock the live file.
 *
 * Usage:
 *   node tools/eval-retrieval.mjs                 # compare on a DB snapshot
 *   node tools/eval-retrieval.mjs --json out.json # also write machine-readable
 *   node tools/eval-retrieval.mjs --db <file>     # explicit source database
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { openMemoryService } from '../lib/service.js'

/** The two configurations under comparison. */
const ARMS = {
  'pre-3.2': { rankConfidenceWeight: 0.35, rankRecencyWeight: 0.1, rankNormalize: 'single' },
  '3.2': { rankConfidenceWeight: 0.2, rankRecencyWeight: 0.15, rankNormalize: 'observed' }
}

/** Queries a person actually asked this assistant, in this project. */
const FIXED_QUERIES = [
  '记忆插件升级到哪一步了',
  '数据库里 superseded 是什么意思',
  '注入块应该放在用户消息前面还是后面',
  '知识库和记忆为什么要分库',
  '信念保底槽占几个',
  'RRF 融合 k 取多少',
  '记忆插件的工具名字叫什么',
  '怎么给记忆加一个常设答案',
  '为什么换了个说法就召不回来',
  '记忆库的文件在哪里',
  'reflect 多久跑一次',
  '怎么把一条记忆作废'
]

/** A fact is scaffolding if this matches — the same shape the gate rejects. */
const SCAFFOLD_RE = /Time sampled while preparing|Elapsed since the preceding|Current runtime context|Current working directory:|Approval policy:/

/** Copy the live store (plus its WAL) so the evaluation cannot touch it. */
function snapshotDb(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem-eval-'))
  for (const suffix of ['', '-wal', '-shm']) {
    const from = `${source}${suffix}`
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dir, `memory.db${suffix}`))
  }
  return dir
}

/** Run one query against one arm. */
async function run(service, query, arm) {
  const result = await service.retrieve(query, { limit: 6, ...arm })
  return result
}

/** Rank-6 overlap of two id lists. */
function overlap(a, b) {
  const set = new Set(b)
  return a.filter((id) => set.has(id)).length
}

const args = process.argv.slice(2)
const flag = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const source =
  flag('--db') ?? path.join(process.env.DSH_MEMORY_DIR ?? path.join(os.homedir(), '.dsh', 'memory'), 'memory.db')
const jsonOut = flag('--json')

if (!fs.existsSync(source)) {
  console.error(`no database at ${source}`)
  process.exit(1)
}

const dir = snapshotDb(source)
const service = await openMemoryService({
  memoryDir: dir,
  dbFile: path.join(dir, 'memory.db'),
  reflectEnabled: false,
  markdownMirror: false,
  logger: { info() {}, warn() {}, error() {}, debug() {} }
})

const facts = await service.allFacts({ includeSuperseded: true })
const active = facts.filter((fact) => fact.archivedAt === null && fact.supersededBy === null)
const cleanActive = active.filter((fact) => !SCAFFOLD_RE.test(fact.content))

const report = {
  source,
  snapshot: {
    facts: facts.length,
    active: active.length,
    cleanActive: cleanActive.length,
    scaffolding: facts.filter((fact) => SCAFFOLD_RE.test(fact.content)).length
  },
  fixed: [],
  selfQuery: {},
  summary: {}
}

// ---------------------------------------------------------------- fixed set
for (const query of FIXED_QUERIES) {
  const row = { query }
  for (const [name, arm] of Object.entries(ARMS)) {
    const result = await run(service, query, arm)
    row[name] = {
      ids: result.results.map((entry) => entry.id),
      layers: result.results.map((entry) => entry.layer),
      scaffolding: result.results.filter((entry) => SCAFFOLD_RE.test(entry.content)).length
    }
  }
  row.overlap = overlap(row['pre-3.2'].ids, row['3.2'].ids)
  report.fixed.push(row)
}

// ------------------------------------------------------------- self queries
// "Does the store still find the memory it is made of?" — 50 facts, queried by
// their own opening clause. It is an easy task by design: it measures the
// ranking's stability, not its semantic reach (which is the hash-embedding's
// known ceiling and is the knowledge base's job to fix).
const sample = []
const step = Math.max(1, Math.floor(cleanActive.length / 50))
for (let index = 0; index < cleanActive.length && sample.length < 50; index += step) {
  const fact = cleanActive[index]
  const text = String(fact.content).replace(/\s+/g, ' ')
  if (text.length < 12) continue
  sample.push({ id: fact.id, query: text.slice(0, 16) })
}

for (const [name, arm] of Object.entries(ARMS)) {
  let hit1 = 0
  let hit6 = 0
  let reciprocal = 0
  for (const item of sample) {
    const result = await run(service, item.query, arm)
    const ids = result.results.map((entry) => entry.id)
    const at = ids.indexOf(item.id)
    if (at === 0) hit1 += 1
    if (at >= 0) {
      hit6 += 1
      reciprocal += 1 / (at + 1)
    }
  }
  report.selfQuery[name] = {
    queries: sample.length,
    hit1: sample.length === 0 ? 0 : Number((hit1 / sample.length).toFixed(3)),
    hit6: sample.length === 0 ? 0 : Number((hit6 / sample.length).toFixed(3)),
    mrr: sample.length === 0 ? 0 : Number((reciprocal / sample.length).toFixed(3))
  }
}

const avgOverlap = report.fixed.reduce((sum, row) => sum + row.overlap, 0) / (report.fixed.length || 1)
const scaffoldingInTop = (name) =>
  report.fixed.reduce((sum, row) => sum + row[name].scaffolding, 0)
report.summary = {
  avgTop6Overlap: Number(avgOverlap.toFixed(2)),
  scaffoldingInTop6: {
    'pre-3.2': scaffoldingInTop('pre-3.2'),
    '3.2': scaffoldingInTop('3.2')
  }
}

// ------------------------------------------------------------------- output
const pad = (value, width) => String(value).padEnd(width)
console.log(`\nsnapshot: ${report.snapshot.facts} facts · ${report.snapshot.active} active · ` +
  `${report.snapshot.cleanActive} clean · ${report.snapshot.scaffolding} scaffolding\n`)
console.log(pad('query', 30) + pad('pre-3.2 top1', 34) + pad('3.2 top1', 34) + 'overlap@6')
for (const row of report.fixed) {
  const short = (ids) => (ids[0] ?? '—').slice(0, 18)
  console.log(pad(row.query.slice(0, 28), 30) + pad(short(row['pre-3.2'].ids), 34) + pad(short(row['3.2'].ids), 34) + row.overlap)
}
console.log('\nself-query (query = own opening clause):')
for (const [name, stats] of Object.entries(report.selfQuery)) {
  console.log(`  ${pad(name, 10)} hit@1=${stats.hit1}  hit@6=${stats.hit6}  MRR=${stats.mrr}`)
}
console.log(`\navg top6 overlap: ${report.summary.avgTop6Overlap}/6` +
  `   scaffolding in top6: pre-3.2=${report.summary.scaffoldingInTop6['pre-3.2']} 3.2=${report.summary.scaffoldingInTop6['3.2']}`)

if (jsonOut !== undefined) {
  fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2))
  console.log(`\nwrote ${jsonOut}`)
}

await service.close()
fs.rmSync(dir, { recursive: true, force: true })
