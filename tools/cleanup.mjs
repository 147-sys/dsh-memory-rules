#!/usr/bin/env node
/*!
 * dsh-memory-rules — withdraw facts whose *extraction* was wrong.
 *
 * Two different reasons a fact can stop being retrieved, and they must not be
 * confused:
 *
 *   superseded  a newer claim replaced this one. The fact is still a valid
 *               observation and still evidence for a belief, so it keeps being
 *               retrievable as evidence.
 *   archived    the row was never a valid observation at all: a fragment of the
 *               injected runtime context, a sentence the noise stripper broke,
 *               a truncated scrap. `facts.archived_at` records the withdrawal.
 *
 * Archiving is additive and reversible. The row, its `raw_quote` and its
 * relations all stay exactly as they were; only retrieval and the export stop
 * offering it. Every run writes an audit JSON next to the database, and
 * `--restore` replays one to put the facts back.
 *
 *   node tools/cleanup.mjs                       # dry run: list what would go
 *   node tools/cleanup.mjs --apply               # withdraw them, write the audit
 *   node tools/cleanup.mjs --apply --ids fact_1,fact_2
 *   node tools/cleanup.mjs --restore <audit.json>
 *
 * `--dir` points the run at another memory directory, which is how the dry run
 * was exercised against the live store during development.
 */

import fs from 'node:fs'
import path from 'node:path'

import { resolvePaths } from '../lib/config.js'
import { openMemoryService } from '../lib/service.js'
import { looksFragmentary } from './doctor.mjs'
import { squash } from '../lib/util.js'

/** Minimal argument parser: `--flag`, `--key value`, `--key=value`. */
function parseArgs(argv) {
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

const args = parseArgs(process.argv.slice(2))
if (args.flags.has('help') || args.flags.has('h')) {
  process.stdout.write(
    'usage: node tools/cleanup.mjs [--apply] [--restore FILE] [--ids a,b] [--dir PATH] [--reason TEXT] [--json]\n'
  )
  process.exit(0)
}

/**
 * Default withdrawal set: the extraction defects found in the live store on
 * 2026-10-14, matched by property rather than by database id so the same script
 * works on any store that inherited them.
 *
 * The rule set is split by *how much it can go wrong*, and the split matters:
 *
 *  - A **safe rule** is generic and can only ever match a fragment: it is
 *    anchored at the start, capped in length, and cannot match a hand-written
 *    note that merely quotes the same wording.
 *  - A **known fragment** is an exact prefix of text reviewed by a human. It is
 *    not a heuristic at all, so it cannot over-reach.
 *
 * Two earlier drafts of this file were rejected by their own dry run for
 * matching a real note ("DSH 插件开发的三个实战坑…"), first on the phrase
 * `task-specific instructions` and then on the mention of `undefined / NaN`.
 * Anything that broad belongs in neither list — leaving noise in the store is
 * strictly better than withdrawing a real memory.
 */
export const SAFE_RULES = [
  {
    name: 'injected-skill-catalog',
    reason: 'injected_context_fragment',
    test: (content) => {
      const text = squash(content)
      return text.length <= 150 && /^(use when\b|a skill is\b|create, read, edit)/i.test(text)
    }
  },
  {
    name: 'broken-by-noise-stripper',
    reason: 'noise_stripper_broke_the_sentence',
    test: (content) => {
      const text = squash(content)
      // An odd number of `**` means the stripper removed the inline code span
      // one of them wrapped, so the sentence no longer reads as written. A note
      // that quotes markdown in pairs, or that shows the syntax in a code span,
      // has an even count or contains a backtick.
      return (text.match(/\*\*/g) ?? []).length % 2 === 1 && !text.includes('`') && text.length <= 300
    }
  }
]

/**
 * Exact fragments, reviewed by hand against the live store.
 *
 * A fact matches when its content starts with one of these. They are listed
 * verbatim rather than derived, because the only thing that distinguishes them
 * from an ordinary sentence is that a human looked at them and said so.
 */
export const KNOWN_FRAGMENTS = [
  { prefix: '常设答案（常用结论预存', reason: 'fragment_lifted_from_a_specification_list' },
  { prefix: '旧 / 已被 / 吸收', reason: 'identifiers_removed_by_the_noise_stripper' },
  { prefix: '导出 6 份文档，全部是给人看的、可 的 Markdown', reason: 'identifiers_removed_by_the_noise_stripper' },
  { prefix: '「导出文件是否人类可读」被做成了机械判据', reason: 'fragment_truncated_before_storage' },
  {
    // A skill-catalog bullet long enough to clear the length cap of
    // `injected-skill-catalog` and well-formed enough to clear the emphasis
    // heuristic, so it is recognised by its own wording instead.
    prefix: 'lunheng-commands v1.0.3 是论衡 v19.5.0',
    reason: 'injected_context_fragment'
  }
]

/** Load the service for a memory directory. */
async function open(dir, dbFile) {
  const paths = resolvePaths({ memoryDir: dir ?? '', dbFile: dbFile ?? '' })
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
  return { service, paths }
}

/** Print one candidate for review. */
function describe(fact, index) {
  return [
    `  ${index + 1}. [${fact.layer} conf=${fact.confidence}] id=${fact.id}`,
    `     content : ${squash(fact.content).slice(0, 150)}`,
    `     quote   : ${squash(fact.rawQuote ?? '—').slice(0, 150)}`
  ].join('\n')
}

const { service, paths } = await open(args.values.dir, args.values.db)

try {
  if (args.values.restore !== undefined) {
    const audit = JSON.parse(fs.readFileSync(args.values.restore, 'utf8'))
    const ids = (audit.facts ?? []).map((entry) => entry.id)
    let restored = 0
    for (const id of ids) {
      const result = await service.db.run('UPDATE facts SET archived_at = NULL WHERE id = ?', [id])
      restored += Number(result?.changes ?? 0)
    }
    service.invalidate()
    process.stdout.write(
      `restored ${restored} fact(s) from ${args.values.restore} (audit reason: ${audit.reason ?? 'n/a'})\n`
    )
  } else {
    const all = await service.allFacts({ includeSuperseded: true })
    const explicit = typeof args.values.ids === 'string' && args.values.ids.trim() !== ''
      ? new Set(args.values.ids.split(',').map((id) => id.trim()).filter(Boolean))
      : undefined
    const archived = all.filter((fact) => fact.archivedAt)
    const candidates =
      explicit === undefined
        ? all
            // A fact somebody wrote on purpose is never withdrawn by a rule.
            // `origin: 'manual'` means `memory_write` (or a note) put it there
            // deliberately, and a hand-written note about this very defect
            // quotes the strings the rules look for — which is how the first
            // draft of those rules came to mis-flag one.
            .filter((fact) => !fact.archivedAt && !fact.supersededBy && fact.origin !== 'manual')
            .map((fact) => {
              const text = squash(fact.content)
              const hits = [
                ...SAFE_RULES.filter((rule) => rule.test(fact.content)).map((rule) => ({
                  name: rule.name,
                  reason: rule.reason
                })),
                ...KNOWN_FRAGMENTS.filter((fragment) => text.startsWith(fragment.prefix)).map((fragment) => ({
                  name: `known-fragment:${fragment.prefix.slice(0, 20)}`,
                  reason: fragment.reason
                })),
                // The general rule for everything the hand-reviewed list does
                // not name: a sentence cut mid-thought. It shares its definition
                // with the doctor's audit (`looksFragmentary`), so a store this
                // script cleans is a store the doctor then reports clean.
                //
                // Only facts the extractor produced are eligible — the candidate
                // filter above excludes `origin: 'manual'` — because a note
                // somebody wrote is not a rule's business, and a note *about*
                // this defect quotes exactly the strings the rules look for.
                ...(looksFragmentary(fact.content)
                  ? [{ name: 'truncated-fragment', reason: 'sentence_cut_mid_thought' }]
                  : [])
              ]
              return hits.length === 0 ? undefined : { fact, hits }
            })
            .filter(Boolean)
        : all.filter((fact) => explicit.has(fact.id)).map((fact) => ({ fact, hits: [] }))

    if (candidates.length === 0) {
      process.stdout.write(
        `no fact matched the withdrawal rules in ${paths.memoryDir}\n` +
          `  facts: ${all.length}, already archived: ${archived.length}\n`
      )
    } else {
      process.stdout.write(
        `${candidates.length} fact(s) matched in ${paths.memoryDir}` +
          `${args.flags.has('apply') ? '' : ' (dry run — nothing written)'}\n\n`
      )
      candidates.forEach((entry, index) => {
        process.stdout.write(`${describe(entry.fact, index)}\n`)
        if (entry.hits.length > 0) {
          process.stdout.write(`     rules   : ${entry.hits.map((hit) => hit.name).join(', ')}\n`)
        }
        process.stdout.write('\n')
      })

      if (args.flags.has('apply')) {
        const reason = args.values.reason ?? 'extraction_defect:injected_context_or_broken_sentence'
        const stamp = new Date().toISOString()
        const audit = {
          reason,
          appliedAt: stamp,
          memoryDir: paths.memoryDir,
          dbFile: paths.dbFile,
          rules: [...SAFE_RULES.map((rule) => rule.name), ...KNOWN_FRAGMENTS.map((f) => `known-fragment:` + f.prefix.slice(0, 20))],
          facts: candidates.map((entry) => ({
            id: entry.fact.id,
            content: entry.fact.content,
            rawQuote: entry.fact.rawQuote,
            layer: entry.fact.layer,
            confidence: entry.fact.confidence,
            createdAt: entry.fact.createdAt,
            sourceSession: entry.fact.sourceSession,
            rules: entry.hits.map((hit) => hit.name),
            reasons: entry.hits.map((hit) => hit.reason)
          }))
        }
        const auditFile = path.join(
          paths.memoryDir,
          `archived-facts-${stamp.replace(/[:.]/g, '-')}.json`
        )
        fs.mkdirSync(path.dirname(auditFile), { recursive: true })
        fs.writeFileSync(auditFile, `${JSON.stringify(audit, null, 2)}\n`, 'utf8')

        let changed = 0
        for (const entry of candidates) {
          const result = await service.db.run('UPDATE facts SET archived_at = ? WHERE id = ? AND archived_at IS NULL', [
            stamp,
            entry.fact.id
          ])
          changed += Number(result?.changes ?? 0)
        }
        service.invalidate()
        process.stdout.write(`archived ${changed} fact(s); audit written to ${auditFile}\n`)
        process.stdout.write(`restore with: node tools/cleanup.mjs --restore "${auditFile}"\n`)
      }
    }

    if (args.flags.has('json')) {
      process.stdout.write(
        `${JSON.stringify({
          memoryDir: paths.memoryDir,
          dbFile: paths.dbFile,
          applied: args.flags.has('apply'),
          candidates: candidates.map((entry) => ({ id: entry.fact.id, rules: entry.hits.map((hit) => hit.name) }))
        }, null, 2)}\n`
      )
    }
  }
} finally {
  await service.close()
}
