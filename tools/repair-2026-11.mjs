#!/usr/bin/env node
/*!
 * dsh-memory-rules — 2026-11 data repair ("历史数据修复").
 *
 * The write gate stops new scaffolding, but it cannot clean what is already in
 * the store: 232 of 709 facts are harness boilerplate, and 180 facts carry a
 * `superseded_by` pointer to a belief row that no longer exists (their belief
 * was deleted or replaced by a later consolidation run). Those 180 are invisible
 * to every retrieval path while still occupying the table — the "never delete"
 * promise is technically kept and practically broken.
 *
 * Defaults are read-only. Nothing is written unless `--apply` is passed, and
 * even then only `archived_at` is set: rows stay on disk, the export still shows
 * them, and clearing the column restores the previous state exactly.
 *
 * Usage:
 *   node tools/repair-2026-11.mjs                    # dry run, prints the plan
 *   node tools/repair-2026-11.mjs --json plan.json    # also write the plan
 *   node tools/repair-2026-11.mjs --apply             # archive the scaffolding
 *   node tools/repair-2026-11.mjs --apply --unlink-orphans   # + restore orphaned evidence
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** The scaffolding shapes the gate now rejects, applied retroactively. */
const SCAFFOLD_PATTERNS = [
  'Time sampled while preparing%',
  'Elapsed since the preceding%',
  'Current runtime context%',
  'Current working directory:%',
  'Current DSH file policy:%',
  'Approval policy:%',
  'Browser time zone for this request:%'
]

const args = process.argv.slice(2)
const has = (name) => args.includes(name)
const flag = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const dbFile =
  flag('--db') ?? path.join(process.env.DSH_MEMORY_DIR ?? path.join(os.homedir(), '.dsh', 'memory'), 'memory.db')
if (!fs.existsSync(dbFile)) {
  console.error(`no database at ${dbFile}`)
  process.exit(1)
}

const apply = has('--apply')
const unlinkOrphans = has('--unlink-orphans')
const jsonOut = flag('--json')
const db = new DatabaseSync(dbFile, { readOnly: !apply })

const all = (sql, params = []) => db.prepare(sql).all(...params)
const one = (sql, params = []) => db.prepare(sql).get(...params)
const run = (sql, params = []) => db.prepare(sql).run(...params)

const where = SCAFFOLD_PATTERNS.map(() => 'content LIKE ?').join(' OR ')
const patterns = SCAFFOLD_PATTERNS

const snapshot = one(
  `SELECT COUNT(*) AS total,
          SUM(CASE WHEN archived_at IS NULL AND superseded_by IS NULL THEN 1 ELSE 0 END) AS active,
          SUM(CASE WHEN superseded_by IS NOT NULL THEN 1 ELSE 0 END) AS superseded,
          SUM(CASE WHEN archived_at IS NOT NULL THEN 1 ELSE 0 END) AS archived
     FROM facts`
)

const scaffolding = {
  total: one(`SELECT COUNT(*) AS n FROM facts WHERE ${where}`, patterns).n,
  active: one(`SELECT COUNT(*) AS n FROM facts WHERE (${where}) AND archived_at IS NULL AND superseded_by IS NULL`, patterns).n,
  superseded: one(`SELECT COUNT(*) AS n FROM facts WHERE (${where}) AND superseded_by IS NOT NULL`, patterns).n
}

const orphans = one(
  `SELECT COUNT(*) AS n FROM facts f
    WHERE f.superseded_by IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM beliefs b WHERE b.id = f.superseded_by)`
).n
const orphanActive = one(
  `SELECT COUNT(*) AS n FROM facts f
    WHERE f.superseded_by IS NOT NULL AND f.archived_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM beliefs b WHERE b.id = f.superseded_by)`
).n

const samples = {
  scaffolding: all(
    `SELECT id, substr(content, 1, 60) AS content, created_at FROM facts
      WHERE (${where}) AND archived_at IS NULL AND superseded_by IS NULL
      ORDER BY created_at DESC LIMIT 5`,
    patterns
  ),
  orphans: all(
    `SELECT f.id, substr(f.content, 1, 60) AS content, f.superseded_by, f.created_at
       FROM facts f
      WHERE f.superseded_by IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM beliefs b WHERE b.id = f.superseded_by)
      ORDER BY f.created_at DESC LIMIT 5`
  )
}

const plan = {
  dbFile,
  mode: apply ? 'apply' : 'dry-run',
  snapshot,
  scaffolding,
  orphans,
  orphanActive,
  samples,
  actions: apply
    ? {
        archivedScaffolding: scaffolding.active,
        unlinkedOrphans: unlinkOrphans ? orphanActive : 0
      }
    : {}
}

const pad = (label, value) => `${String(label).padEnd(24)}${value}`
console.log(`\n${plan.mode}  ${dbFile}\n`)
console.log(pad('facts total', snapshot.total))
console.log(pad('  active', snapshot.active))
console.log(pad('  superseded', snapshot.superseded))
console.log(pad('  archived', snapshot.archived))
console.log(pad('scaffolding (all)', scaffolding.total))
console.log(pad('  still active', scaffolding.active))
console.log(pad('  superseded', scaffolding.superseded))
console.log(pad('orphan supersedes', orphans))
console.log(pad('  restorable', orphanActive))

if (apply) {
  const now = new Date().toISOString()
  const archived = run(
    `UPDATE facts SET archived_at = ?
      WHERE (${where}) AND archived_at IS NULL AND superseded_by IS NULL`,
    [now, ...patterns]
  )
  console.log(`\narchived ${archived.changes} scaffolding fact(s) at ${now}`)
  if (unlinkOrphans) {
    const unlinked = run(
      `UPDATE facts SET superseded_by = NULL
        WHERE superseded_by IS NOT NULL AND archived_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM beliefs b WHERE b.id = facts.superseded_by)`
    )
    plan.actions.unlinkedOrphans = unlinked.changes
    console.log(`unlinked ${unlinked.changes} orphaned evidence fact(s)`)
  }
} else {
  console.log('\n(dry run — nothing written; pass --apply to archive the scaffolding)')
}

if (jsonOut !== undefined) {
  fs.writeFileSync(jsonOut, JSON.stringify(plan, null, 2))
  console.log(`wrote ${jsonOut}`)
}

db.close()
