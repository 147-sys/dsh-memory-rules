/*!
 * dsh-memory-rules — single-process test runner.
 *
 * `node --test` spawns one child process per test file, which some sandboxes
 * forbid (EPERM on spawn). This runner imports the same test modules into one
 * process:
 *
 *   node test/run-all.mjs
 *
 * `node:test` executes top-level tests once the entry module finishes and sets
 * the process exit code itself (verified: a passing file exits 0, a failing one
 * exits 1), so there is no counter to maintain here. Note that `run()` must NOT
 * be used for this: it discovers files from the working directory and would pick
 * up unrelated `*.test.js` files anywhere in the workspace.
 *
 * The normal entry point (`npm test` → `node --test test/`) remains the default.
 */

import fs from 'node:fs'
import path from 'node:path'

const dir = import.meta.dirname
const files = fs
  .readdirSync(dir)
  .filter((name) => name.endsWith('.test.js'))
  .sort()

// `import.meta.resolve` keeps this correct on Windows, where `import()` of a
// bare `C:\...` path fails with ERR_UNSUPPORTED_ESM_URL_SCHEME.
for (const file of files) {
  await import(import.meta.resolve(`./${file}`))
}

process.stdout.write(`\nimported ${files.length} file(s): ${files.join(', ')}\n`)
