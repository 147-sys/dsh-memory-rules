#!/usr/bin/env node
/*!
 * dsh-memory-rules — regenerate `lib/schema.js` from `sql/schema.sql`.
 *
 * The SQL file is the human-readable source of truth (it keeps its comments);
 * the runtime executes the generated module. Only comments are removed during
 * generation, so the statement text is identical in both, and
 * `test/step1.test.js` asserts exactly that.
 *
 * Usage: node tools/build-schema.mjs
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = path.join(here, '..', 'sql', 'schema.sql')
const dst = path.join(here, '..', 'lib', 'schema.js')

/**
 * Strip `--` line comments and slash-star block comments.
 * @param sql - SQL source text.
 * @returns Executable DDL with comments replaced by nothing.
 */
export function stripSqlComments(sql) {
  return String(sql)
    .split(/\r?\n/)
    .map((line) => line.replace(/\s*--.*$/, ''))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim()
}

/**
 * Run the generator. Only called when this file is executed directly.
 *
 * `test/step1.test.js` imports {@link stripSqlComments} from here to check that
 * `lib/schema.js` matches `sql/schema.sql`. Without the guard that import would
 * re-run the generator as a side effect of every test run — which writes into
 * the package directory, so it fails outright when the checkout is read-only
 * (a packaged install, or a sandboxed test run).
 *
 * @returns {void}
 */
function main() {
  const raw = fs.readFileSync(src, 'utf8')
  const ddl = stripSqlComments(raw)
  const version = crypto.createHash('sha256').update(ddl).digest('hex').slice(0, 16)
  if (ddl.includes('`') || ddl.includes('${')) {
    throw new Error('schema.sql contains a template-literal hazard (` or ${) outside a comment')
  }

  const generated = `/*!
 * dsh-memory-rules — generated schema module. DO NOT EDIT BY HAND.
 *
 * Generated from \`sql/schema.sql\` by \`node tools/build-schema.mjs\`.
 * \`test/step1.test.js\` fails when this file and the SQL file disagree, so the
 * SQL file stays the human-readable source of truth and this module stays the
 * one the runtime actually executes.
 */

/** Fingerprint of {@link SCHEMA_SQL}; stored in \`meta\` to detect drift. */
export const SCHEMA_VERSION = '${version}'

/** Executable DDL (comments stripped), in dependency order. */
export const SCHEMA_SQL = \`
${ddl}
\`
`

  fs.writeFileSync(dst, generated, 'utf8')
  console.log(`schema.js: ${ddl.length} chars of DDL, version ${version}`)
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (invokedDirectly) main()
