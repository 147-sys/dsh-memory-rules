#!/usr/bin/env node
/*!
 * dsh-memory-rules — health check ("体检").
 *
 * Read-only. Never writes to the memory store, never fetches anything. It
 * answers one question in sections, each with an explicit PASS/FAIL/WARN, so
 * the output is evidence rather than opinion:
 *
 *   1. tree      — the plugin matches its manifest, schema source and reference copy
 *   2. schema    — tables, columns, indexes, engine, schema fingerprint
 *   3. integrity — foreign keys, pointer targets, JSON columns, duplicates
 *   4. quality   — extraction defects that survived into the store
 *   5. retrieval — the four paths produce results; archived facts do not
 *   6. runtime   — heartbeats, reflection history, Markdown mirror, audit trail
 *
 * Two entry points, one implementation:
 *
 *   node tools/doctor.mjs [--dir PATH] [--against PATH] [--json]
 *   import { runDoctor, renderDoctor } from './tools/doctor.mjs'
 *
 * The import form exists because a sandbox may forbid spawning a child process
 * with piped stdio, and the end-to-end test needs a programmatic verdict.
 *
 * Exit codes: 0 all good, 1 warnings only, 2 hard failures.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { resolvePaths } from '../lib/config.js'
import { openMemoryService } from '../lib/service.js'
import { probeEngines } from '../lib/db.js'
import { retrieve } from '../lib/retrieve.js'
import { squash } from '../lib/util.js'

/** Minimal argument parser: `--flag`, `--key value`, `--key=value`. */
export function parseArgs(argv) {
  const out = { flags: new Set(), values: {}, positionals: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      out.positionals.push(token)
      continue
    }
    const [key, inline] = token.slice(2).split('=')
    const next = argv[i + 1]
    if (inline !== undefined) out.values[key] = inline
    else if (next !== undefined && !next.startsWith('--')) {
      out.values[key] = next
      i += 1
    } else out.flags.add(key)
  }
  return out
}

/** Strip `--` comments and block comments, for the schema source comparison. */
export function stripSqlComments(sql) {
  return String(sql)
    .split(/\r?\n/)
    .map((line) => line.replace(/\s*--.*$/, ''))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim()
}

/**
 * The completeness rule the extractor applies, restated for auditing a store
 * that was written before the rule existed.
 *
 * @param text - a fact's content.
 * @returns `true` when the sentence looks cut mid-thought.
 */
export function looksFragmentary(text) {
  const value = squash(text)
  if (value.length < 12) return true
  if (/[:：,，、;；\-—–]$/.test(value)) return true
  if (/(?:和|与|及|以及|并且|但是|因为|所以|如果|那么|and|or|but|because|that|which)$/i.test(value)) return true
  if ((value.match(/\*\*/g) ?? []).length % 2 === 1 && !value.includes('`')) return true
  return false
}

/** Columns each table must have. */
const REQUIRED_COLUMNS = {
  facts: ['id', 'content', 'source_session', 'created_at', 'layer', 'confidence', 'tags', 'raw_quote', 'origin', 'superseded_by', 'archived_at', 'embedding'],
  beliefs: ['id', 'topic', 'statement', 'evidence_ids', 'evidence_count', 'strength', 'updated_at', 'created_at', 'layer', 'revision'],
  answers: ['id', 'question_pattern', 'cached_answer', 'last_verified', 'created_at', 'hits', 'confidence', 'source_fact_ids'],
  relations: ['id', 'subject', 'predicate', 'object', 'source_fact_id', 'created_at', 'confidence'],
  belief_revisions: ['id', 'belief_id', 'previous_statement', 'previous_strength', 'previous_evidence', 'reason', 'trigger_fact_id', 'created_at'],
  reflections: ['id', 'period_key', 'started_at', 'finished_at', 'kind', 'merged', 'overwritten', 'reinforced', 'scanned', 'topics', 'notes'],
  meta: ['key', 'value']
}

/**
 * Run every check.
 *
 * @param options - `{ pkgDir, memoryDir, dbFile, against }`.
 * @returns `{ verdict, counts, sections, paths, engine }`.
 */
export async function runDoctor(options = {}) {
  const pkgDir = path.resolve(options.pkgDir ?? path.join(import.meta.dirname, '..'))
  const sections = []
  const check = (section, name, status, detail) => {
    let entry = sections.find((item) => item.title === section)
    if (entry === undefined) {
      entry = { title: section, checks: [] }
      sections.push(entry)
    }
    entry.checks.push({ name, status, detail: detail ?? '' })
  }
  const pass = (section, name, detail) => check(section, name, 'PASS', detail)
  const warn = (section, name, detail) => check(section, name, 'WARN', detail)
  const fail = (section, name, detail) => check(section, name, 'FAIL', detail)

  // ------------------------------------------------------------------- tree
  const libDir = path.join(pkgDir, 'lib')
  const libFiles = fs.readdirSync(libDir).filter((name) => name.endsWith('.js')).sort()

  const unresolved = []
  for (const name of libFiles) {
    const text = fs.readFileSync(path.join(libDir, name), 'utf8')
    for (const spec of [...text.matchAll(/from\s+['"](\.\/[^'"]+)['"]/g)].map((m) => m[1])) {
      if (!fs.existsSync(path.join(libDir, spec))) unresolved.push(`${name} -> ${spec}`)
    }
  }
  if (unresolved.length === 0) pass('tree', 'relative imports all resolve', `${libFiles.length} modules`)
  else fail('tree', 'relative imports all resolve', unresolved.join('; '))

  const nonBuiltin = []
  for (const name of libFiles) {
    const text = fs.readFileSync(path.join(libDir, name), 'utf8')
    for (const spec of [...text.matchAll(/from\s+['"]([^'".][^'"]*)['"]/g)].map((m) => m[1])) {
      if (!spec.startsWith('node:')) nonBuiltin.push(`${name} -> ${spec}`)
    }
  }
  if (nonBuiltin.length === 0) pass('tree', 'no host-package imports at load time')
  else fail('tree', 'no host-package imports at load time', nonBuiltin.join('; '))

  if (typeof options.against === 'string' && options.against !== '') {
    const otherLib = path.resolve(options.against)
    const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    const different = []
    for (const name of libFiles) {
      const theirs = path.join(otherLib, name)
      if (!fs.existsSync(theirs)) different.push(`${name} (absent there)`)
      else if (hash(path.join(libDir, name)) !== hash(theirs)) different.push(name)
    }
    if (different.length === 0) pass('tree', 'lib matches the reference copy', otherLib)
    else fail('tree', 'lib matches the reference copy', `differs: ${different.join(', ')}`)
  }

  const sqlFile = path.join(pkgDir, 'sql', 'schema.sql')
  const schemaFile = path.join(libDir, 'schema.js')
  if (!fs.existsSync(sqlFile) || !fs.existsSync(schemaFile)) {
    warn('tree', 'schema.sql and lib/schema.js agree', 'one of the two files is absent')
  } else {
    const embedded = /SCHEMA_SQL = `\n([\s\S]*?)\n`/.exec(fs.readFileSync(schemaFile, 'utf8'))
    if (embedded === null) fail('tree', 'schema.sql and lib/schema.js agree', 'SCHEMA_SQL not found')
    else if (embedded[1].trim() !== stripSqlComments(fs.readFileSync(sqlFile, 'utf8'))) {
      fail('tree', 'schema.sql and lib/schema.js agree', 'run `node tools/build-schema.mjs`')
    } else pass('tree', 'schema.sql and lib/schema.js agree')
  }

  // ----------------------------------------------------------------- schema
  const paths = resolvePaths({ memoryDir: options.memoryDir ?? '', dbFile: options.dbFile ?? '' })
  const service = await openMemoryService({
    memoryDir: paths.memoryDir,
    dbFile: paths.dbFile,
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    markdownMirror: false
  })

  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    const info = await service.db.all(`PRAGMA table_info(${table})`, [])
    if (info.length === 0) {
      fail('schema', `table ${table}`, 'missing')
      continue
    }
    const names = info.map((row) => row.name)
    const gone = columns.filter((column) => !names.includes(column))
    if (gone.length === 0) pass('schema', `table ${table}`, `${names.length} columns`)
    else fail('schema', `table ${table}`, `missing: ${gone.join(', ')}`)
  }
  const indexes = (await service.db.all("SELECT name FROM sqlite_master WHERE type = 'index'", [])).map((r) => r.name)
  for (const index of ['idx_facts_layer_created', 'idx_facts_archived', 'idx_relations_subject', 'idx_beliefs_topic', 'idx_reflections_period']) {
    if (indexes.includes(index)) pass('schema', `index ${index}`)
    else warn('schema', `index ${index}`, 'absent')
  }
  const engines = probeEngines()
  pass('schema', 'engine', `${service.engine} (probe ${engines.preferred ?? 'none'}, node ${engines.nodeVersion})`)
  pass('schema', 'schema fingerprint', String(await service.getMeta('schema_version')))
  pass('schema', 'database file', paths.dbFile)

  // -------------------------------------------------------------- integrity
  const facts = await service.allFacts({ includeSuperseded: true })
  const beliefs = await service.allBeliefs()
  const answers = await service.allAnswers()
  const relations = await service.allRelations()
  const revisions = await service.beliefRevisions()
  const reflections = await service.reflections()
  const factIds = new Set(facts.map((fact) => fact.id))
  const beliefIds = new Set(beliefs.map((belief) => belief.id))

  const dangling = relations.filter((edge) => edge.source_fact_id !== null && !factIds.has(edge.source_fact_id))
  if (dangling.length === 0) pass('integrity', 'every relation points at a real fact', `${relations.length} edge(s)`)
  else fail('integrity', 'every relation points at a real fact', dangling.map((edge) => edge.id).join(', '))

  const danglingEvidence = []
  for (const belief of beliefs) for (const id of belief.evidenceIds) if (!factIds.has(id)) danglingEvidence.push(`${belief.id} -> ${id}`)
  if (danglingEvidence.length === 0) pass('integrity', 'every belief evidence id resolves')
  else fail('integrity', 'every belief evidence id resolves', danglingEvidence.join('; '))

  const mismatch = beliefs.filter((belief) => belief.evidenceCount !== belief.evidenceIds.length)
  if (mismatch.length === 0) pass('integrity', 'evidence_count matches evidence_ids length')
  else fail('integrity', 'evidence_count matches evidence_ids length', mismatch.map((belief) => belief.id).join(', '))

  const orphanSupersede = facts.filter((fact) => fact.supersededBy !== null && !beliefIds.has(fact.supersededBy))
  if (orphanSupersede.length === 0) pass('integrity', 'every superseded_by points at a real belief')
  else warn('integrity', 'every superseded_by points at a real belief', orphanSupersede.map((fact) => fact.id).join(', '))

  const bothStates = facts.filter((fact) => fact.supersededBy !== null && fact.archivedAt !== null)
  if (bothStates.length === 0) pass('integrity', 'no fact is both superseded and archived')
  else fail('integrity', 'no fact is both superseded and archived', bothStates.map((fact) => fact.id).join(', '))

  const noVector = facts.filter((fact) => !Array.isArray(fact.embedding) || fact.embedding.length === 0)
  if (noVector.length === 0) pass('integrity', 'every fact carries its semantic vector', `${facts.length} fact(s)`)
  else warn('integrity', 'every fact carries its semantic vector', `${noVector.length} without`)

  const badJson = []
  if (facts.some((fact) => !Array.isArray(fact.tags))) badJson.push('facts.tags')
  if (beliefs.some((belief) => !Array.isArray(belief.evidenceIds))) badJson.push('beliefs.evidence_ids')
  if (answers.some((answer) => !Array.isArray(answer.questions))) badJson.push('answers.question_pattern')
  if (badJson.length === 0) pass('integrity', 'JSON columns decode as arrays')
  else fail('integrity', 'JSON columns decode as arrays', badJson.join(', '))

  // The stored text itself must parse, not merely decode into an empty array.
  const unparsable = []
  for (const row of await service.db.all('SELECT id, tags FROM facts', [])) {
    try {
      if (!Array.isArray(JSON.parse(row.tags))) unparsable.push(`facts.tags ${row.id}`)
    } catch {
      unparsable.push(`facts.tags ${row.id}`)
    }
  }
  if (unparsable.length === 0) pass('integrity', 'stored JSON text parses')
  else fail('integrity', 'stored JSON text parses', unparsable.join(', '))

  const seen = new Map()
  const duplicates = []
  for (const fact of facts) {
    const key = squash(fact.content)
    if (seen.has(key)) duplicates.push(`${seen.get(key)} == ${fact.id}`)
    else seen.set(key, fact.id)
  }
  if (duplicates.length === 0) pass('integrity', 'no duplicate fact content', `${seen.size} unique of ${facts.length}`)
  else warn('integrity', 'no duplicate fact content', duplicates.join('; '))

  const periods = new Map()
  for (const row of reflections) {
    const key = `${row.period_key}:${row.kind}`
    periods.set(key, (periods.get(key) ?? 0) + 1)
  }
  const multi = [...periods.entries()].filter(([, n]) => n > 1)
  if (multi.length === 0) pass('integrity', 'one reflection row per period')
  else fail('integrity', 'one reflection row per period', multi.map(([key]) => key).join(', '))

  const orphanRevision = revisions.filter((revision) => !beliefIds.has(revision.belief_id))
  if (orphanRevision.length === 0) pass('integrity', 'every revision belongs to a real belief')
  else fail('integrity', 'every revision belongs to a real belief', orphanRevision.map((r) => r.id).join(', '))

  // ---------------------------------------------------------------- quality
  const live = facts.filter((fact) => fact.supersededBy === null && fact.archivedAt === null)
  /**
   * Live facts whose text quotes the injected-context markers.
   *
   * Split by origin, which is what makes the check meaningful. The defect it
   * exists to catch is *automatic extraction absorbing harness-authored text*
   * (`origin: 'user' | 'assistant'`), and only that is reported as a failure. A
   * `origin: 'manual'` fact is one somebody chose to write — and a note *about*
   * this very defect necessarily quotes the strings this check looks for, which
   * is how the first draft of the cleanup rules came to mis-flag one. Reporting
   * a deliberate note as a defect would train the reader to ignore the check.
   */
  const INJECTED_MARKERS = /task-specific instructions|available_skills|Current runtime context|This snapshot supersedes|DOCX file is an input/i
  const injected = live.filter((fact) => fact.origin !== 'manual' && INJECTED_MARKERS.test(fact.content))
  const quotingNotes = live.filter((fact) => fact.origin === 'manual' && INJECTED_MARKERS.test(fact.content))
  if (injected.length === 0) pass('quality', 'no extracted fact absorbed injected context')
  else {
    fail(
      'quality',
      'no extracted fact absorbed injected context',
      injected.map((fact) => `${fact.id} [origin=${fact.origin}]: ${squash(fact.content).slice(0, 46)}`).join(' | ')
    )
  }
  if (quotingNotes.length === 0) pass('quality', 'no hand-written note quotes injected text')
  else {
    pass(
      'quality',
      'no hand-written note quotes injected text',
      `${quotingNotes.length} note(s) quote it on purpose: ${quotingNotes.map((fact) => fact.id).join(', ')}`
    )
  }

  const fragments = live.filter((fact) => looksFragmentary(fact.content))
  if (fragments.length === 0) pass('quality', 'no truncated fragment is live', `${live.length} live fact(s)`)
  else warn('quality', 'no truncated fragment is live', fragments.map((fact) => `${fact.id}: "${squash(fact.content).slice(0, 40)}"`).join(' | '))

  const broken = live.filter((fact) => /[^\S\n]\/[^\S\n]*\/[^\S\n]/.test(fact.content))
  if (broken.length === 0) pass('quality', 'no sentence broken by the noise stripper')
  else warn('quality', 'no sentence broken by the noise stripper', broken.map((fact) => fact.id).join(', '))

  const verbatim = live.filter((fact) => fact.rawQuote !== null && squash(fact.content) === squash(fact.rawQuote))
  if (verbatim.length === 0) pass('quality', 'no live fact is stored verbatim')
  else warn('quality', 'no live fact is stored verbatim', `${verbatim.length}/${live.length} identical to their quote`)

  const byLayer = {}
  for (const fact of live) byLayer[fact.layer] = (byLayer[fact.layer] ?? 0) + 1
  pass('quality', 'live facts by layer', JSON.stringify(byLayer))

  const byOrigin = {}
  for (const fact of live) byOrigin[fact.origin] = (byOrigin[fact.origin] ?? 0) + 1
  pass('quality', 'live facts by origin', JSON.stringify(byOrigin))

  pass('quality', 'archived facts (withdrawn, still stored)', String(facts.filter((fact) => fact.archivedAt !== null).length))

  // -------------------------------------------------------------- retrieval
  if (live.length === 0) {
    warn('retrieval', 'four paths produce candidates', 'no live facts to retrieve')
  } else {
    const probe = squash(live[0].content).slice(0, 12)
    const snapshot = await service.snapshot()
    const result = retrieve(probe, snapshot, { limit: 10 })
    const pathCounts = result.stats.pathCounts ?? {}
    const produced = Object.values(pathCounts).filter((n) => n > 0).length
    if (produced >= 2) pass('retrieval', 'four paths produce candidates', JSON.stringify(pathCounts))
    else warn('retrieval', 'four paths produce candidates', `only ${produced} path(s) hit for "${probe}"`)

    const archivedIds = new Set(facts.filter((fact) => fact.archivedAt !== null).map((fact) => fact.id))
    const leaked = result.results.filter((entry) => archivedIds.has(entry.id))
    if (leaked.length === 0) pass('retrieval', 'archived facts are not returned')
    else fail('retrieval', 'archived facts are not returned', leaked.map((entry) => entry.id).join(', '))

    const ordered = result.results.every((entry, index) => index === 0 || result.results[index - 1].score >= entry.score)
    if (ordered) pass('retrieval', 'the merged ranking is ordered by score')
    else fail('retrieval', 'the merged ranking is ordered by score')
  }

  // ---------------------------------------------------------------- runtime
  const meta = Object.fromEntries((await service.allMeta()).map((row) => [row.key, row.value]))
  if (meta['heartbeat:turn-end'] !== undefined) pass('runtime', 'turn-end hook has fired', meta['heartbeat:turn-end'])
  else warn('runtime', 'turn-end hook has fired', 'no heartbeat recorded')
  if (meta['heartbeat:idle'] !== undefined) pass('runtime', 'idle flush has fired', meta['heartbeat:idle'])
  else warn('runtime', 'idle flush has fired', 'no heartbeat recorded')

  if (reflections.length === 0) warn('runtime', 'reflection history', 'no run recorded yet')
  else {
    const latest = reflections[0]
    pass(
      'runtime',
      'reflection history',
      `${reflections.length} run(s); latest ${latest.period_key} (${latest.kind}) scanned=${latest.scanned} topics=${latest.topics}`
    )
    const unfinished = reflections.filter((row) => !row.finished_at)
    if (unfinished.length === 0) pass('runtime', 'every reflection run finished')
    else warn('runtime', 'every reflection run finished', unfinished.map((row) => row.id).join(', '))
  }

  const dayFiles = fs.existsSync(paths.memoryDir)
    ? fs.readdirSync(paths.memoryDir).filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)).sort()
    : []
  if (dayFiles.length === 0) warn('runtime', 'Markdown mirror exists', 'no day file yet')
  else {
    const newest = dayFiles.at(-1)
    const stat = fs.statSync(path.join(paths.memoryDir, newest))
    pass(
      'runtime',
      'Markdown mirror exists',
      `${dayFiles.length} day file(s); newest ${newest} (${((Date.now() - stat.mtimeMs) / 60000).toFixed(1)} min old)`
    )
    const text = fs.readFileSync(path.join(paths.memoryDir, newest), 'utf8')
    if (text.startsWith('# Memory')) pass('runtime', 'mirror keeps the day-file header')
    else warn('runtime', 'mirror keeps the day-file header', JSON.stringify(text.slice(0, 20)))
  }

  const audits = fs.existsSync(paths.memoryDir)
    ? fs.readdirSync(paths.memoryDir).filter((name) => /^archived-facts-.*\.json$/.test(name))
    : []
  const archivedCount = facts.filter((fact) => fact.archivedAt !== null).length
  if (audits.length === 0) {
    if (archivedCount === 0) pass('runtime', 'archive audit trail', 'no archiving applied')
    else fail('runtime', 'archive audit trail', `${archivedCount} archived fact(s) with no audit file`)
  } else {
    let recorded = 0
    for (const name of audits) {
      try {
        recorded += (JSON.parse(fs.readFileSync(path.join(paths.memoryDir, name), 'utf8')).facts ?? []).length
      } catch {
        /* a corrupt audit file shows up as a shortfall below */
      }
    }
    if (recorded >= archivedCount) {
      pass('runtime', 'archive audit trail', `${audits.length} file(s) covering ${archivedCount} archived fact(s)`)
    } else {
      warn('runtime', 'archive audit trail', `${recorded} recorded vs ${archivedCount} archived — restore would be partial`)
    }
  }

  await service.close()

  const flat = sections.flatMap((section) => section.checks.map((entry) => ({ ...entry, section: section.title })))
  const counts = {
    pass: flat.filter((entry) => entry.status === 'PASS').length,
    warn: flat.filter((entry) => entry.status === 'WARN').length,
    fail: flat.filter((entry) => entry.status === 'FAIL').length
  }
  return {
    verdict: counts.fail > 0 ? 'FAIL' : counts.warn > 0 ? 'WARN' : 'PASS',
    counts,
    sections,
    paths,
    engine: service.engine
  }
}

/** Render a report for a terminal. */
export function renderDoctor(report) {
  const lines = []
  for (const section of report.sections) {
    lines.push(`\n== ${section.title} ==`)
    for (const entry of section.checks) {
      const mark = entry.status === 'PASS' ? 'OK  ' : entry.status === 'WARN' ? 'WARN' : 'FAIL'
      lines.push(`  [${mark}] ${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}`)
    }
  }
  lines.push(
    `\n${report.verdict}: ${report.counts.pass} pass, ${report.counts.warn} warn, ${report.counts.fail} fail`,
    `store: ${report.paths.dbFile}`,
    `engine: ${report.engine}`
  )
  return `${lines.join('\n')}\n`
}

// Only run as a CLI when this module is the entry point: the end-to-end test
// imports `runDoctor` directly, because a sandbox may forbid spawning a child
// process with piped stdio.
const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)

if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2))
  if (args.flags.has('help') || args.flags.has('h')) {
    process.stdout.write('usage: node tools/doctor.mjs [--dir PATH] [--db PATH] [--against PATH] [--json]\n')
  } else {
    const report = await runDoctor({
      memoryDir: args.values.dir,
      dbFile: args.values.db,
      against: args.values.against
    })
    process.stdout.write(args.flags.has('json') ? `${JSON.stringify(report, null, 2)}\n` : renderDoctor(report))
    process.exitCode = report.counts.fail > 0 ? 2 : report.counts.warn > 0 ? 1 : 0
  }
}
