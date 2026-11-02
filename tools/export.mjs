/*!
 * dsh-memory-rules — produce a real Markdown export into a directory.
 *
 * The plugin's `memory_export` tool writes into the memory root, which is the
 * right default for normal use. This script exists for the other case: an
 * operator wants a snapshot somewhere else (a reports directory, an attachment)
 * without changing configuration.
 *
 *   node tools/export.mjs --dir ./memory-export
 *   node tools/export.mjs --dir ./out --exclude-superseded --json
 */

import fs from 'node:fs'
import path from 'node:path'

import { resolvePaths } from '../lib/config.js'
import { openMemoryService } from '../lib/service.js'

/** Minimal argument parser: `--flag`, `--key value`, `--key=value`. */
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
  process.stdout.write('usage: node tools/export.mjs [--dir PATH] [--db PATH] [--memory-dir PATH] [--exclude-superseded] [--json]\n')
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
  markdownMirror: false
})

try {
  const dir = path.resolve(args.values.dir ?? path.join(paths.memoryDir, 'export'))
  fs.mkdirSync(dir, { recursive: true })
  const result = await service.exportMarkdown({
    dir,
    includeSuperseded: !args.flags.has('exclude-superseded')
  })
  if (args.flags.has('json')) {
    process.stdout.write(
      `${JSON.stringify({ dir: result.dir, files: result.files, counts: result.counts }, null, 2)}\n`
    )
  } else {
    process.stdout.write(`exported ${result.files.length} file(s) to ${result.dir}\n`)
    for (const file of result.files) {
      const size = fs.statSync(file).size
      process.stdout.write(`  ${String(size).padStart(7)} B  ${path.basename(file)}\n`)
    }
    const counts = result.counts
    process.stdout.write(
      `  facts=${counts.facts} beliefs=${counts.beliefs} answers=${counts.answers} ` +
        `relations=${counts.relations} revisions=${counts.belief_revisions} reflections=${counts.reflections}\n`
    )
  }
} finally {
  await service.close()
}
