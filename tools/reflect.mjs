#!/usr/bin/env node
/*!
 * dsh-memory-rules — run the 7-day consolidation by hand.
 *
 * The plugin schedules its own reflection, but an operator (or a cron entry on
 * a machine that never keeps DSH running) may want to run it explicitly:
 *
 *   node tools/reflect.mjs                      # consolidate what is owed now
 *   node tools/reflect.mjs --period 2026-10-15  # a specific run day
 *   node tools/reflect.mjs --force              # ignore the idempotence guard
 *   node tools/reflect.mjs --db ~/.dsh/memory/memory.db --json
 *
 * It opens the same service the plugin uses, so the run is recorded in
 * `reflections` exactly as a scheduled one would be.
 */

import path from 'node:path'

import { openMemoryService } from '../lib/service.js'
import { resolvePaths } from '../lib/config.js'

/** Minimal argument parser: `--flag`, `--key value`. */
function parseArgs(argv) {
  const out = { flags: new Set(), values: {} }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
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

const args = parseArgs(process.argv.slice(2))
if (args.flags.has('help') || args.flags.has('h')) {
  process.stdout.write(
    'usage: node tools/reflect.mjs [--period YYYY-MM-DD] [--db PATH] [--memory-dir PATH] [--force] [--json]\n'
  )
  process.exit(0)
}

const paths = resolvePaths({ memoryDir: args.values['memory-dir'] ?? '', dbFile: args.values.db ?? '' })
const logger = {
  info: (message) => process.stderr.write(`${message}\n`),
  warn: (message) => process.stderr.write(`${message}\n`),
  debug: () => {},
  error: (message) => process.stderr.write(`${message}\n`)
}

const service = await openMemoryService({
  memoryDir: paths.memoryDir,
  dbFile: paths.dbFile,
  logger,
  markdownMirror: true,
  reflect: { reflectDays: [1, 8, 15, 22, 29], reflectAt: '03:00', reflectMinEvidence: 3, reflectTopicThreshold: 0.34 }
})

try {
  const due = args.values.period === undefined ? await service.reflectionDue(new Date()) : undefined
  const result = await service.runReflection({
    periodKey: args.values.period ?? due?.periodKey,
    kind: 'manual',
    force: args.flags.has('force'),
    phase: args.flags.has('force') ? 'manual-force' : 'manual'
  })
  const summary = {
    db: paths.dbFile,
    memoryDir: paths.memoryDir,
    periodKey: result.periodKey,
    skipped: result.skipped,
    scanned: result.plan?.scanned ?? 0,
    topics: result.plan?.clusters ?? 0,
    stats: result.plan?.stats ?? {},
    applied: result.applied ?? {}
  }
  if (args.flags.has('json')) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  else {
    process.stdout.write(
      `reflection ${summary.periodKey ?? '(none)'}${summary.skipped ? ' (skipped: already done)' : ''}\n` +
        `  scanned ${summary.scanned} fact(s) in ${summary.topics} topic cluster(s)\n` +
        `  created ${summary.stats.created ?? 0}, merged ${summary.stats.merged ?? 0}, ` +
        `reinforced ${summary.stats.reinforced ?? 0}, overwritten ${summary.stats.overwritten ?? 0}\n` +
        `  db ${path.relative(process.cwd(), summary.db) || summary.db}\n`
    )
  }
} finally {
  await service.close()
}
