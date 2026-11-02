/*!
 * dsh-memory-rules — the model-facing tools.
 *
 * Seven tools, each a thin adapter over the service; the registry contract
 * (`{ name, description, parameters, output: { schema, render }, execute }`) is
 * implemented inline so the plugin carries no import-time dependency on host
 * packages.
 *
 *   memory_write     store one durable fact (world fact or experience)
 *   memory_retrieve  the four-path retrieval (semantic/keyword/graph/timeline)
 *   memory_answer    pre-store a standing answer; later hits skip retrieval
 *   memory_reflect   run the belief consolidation now
 *   memory_relate    record a relation edge
 *   memory_export    write the human-readable Markdown export
 *   memory_search    keyword search over the hand-editable Markdown day files
 */

import { renderEntry } from './recall.js'
import { TOOL_NAMES, clip, squash } from './util.js'

/** Registry-ready shape shared by every tool's `output`. */
const OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render(_args, value) {
    if (value && value.error) return [{ type: 'text', text: String(value.error) }]
    return [{ type: 'text', text: value && value.text ? String(value.text) : 'ok' }]
  }
}

/**
 * Detach a value into strict lossless JSON.
 *
 * The host validates every tool result against lossless-JSON rules and rejects
 * the whole call otherwise: no `undefined`, no `NaN`/`Infinity`/`-0`, no
 * functions, no non-plain objects, and no holes in arrays. `JSON.stringify` is
 * *not* a sufficient self-check — it silently drops `undefined` properties,
 * which is exactly how an absent standing answer used to break
 * `memory_retrieve` (the result carried `answer: undefined`, and the host
 * refused the call with "value is not lossless JSON").
 *
 * An absent object property is therefore dropped, and an absent array element
 * becomes `null`, because dropping it would leave a hole the validator also
 * rejects.
 *
 * @param value - any value produced by a tool.
 * @returns A structure that survives the host's snapshot check.
 */
export function toLosslessJson(value) {
  if (value === null) return null
  const kind = typeof value
  if (kind === 'boolean' || kind === 'string') return value
  if (kind === 'number') return Number.isFinite(value) && !Object.is(value, -0) ? value : 0
  if (kind === 'bigint') return Number(value)
  if (kind !== 'object') return undefined
  if (Array.isArray(value)) return value.map((entry) => toLosslessJson(entry) ?? null)
  const out = {}
  for (const key of Object.keys(value)) {
    const cleaned = toLosslessJson(value[key])
    if (cleaned !== undefined) out[key] = cleaned
  }
  return out
}

/** Attach the text the renderer prints to a flat, lossless-JSON result object. */
function reply(value, text) {
  return toLosslessJson({ ...value, text })
}

/**
 * `memory_write` — store one durable fact.
 * @param deps - `{ service, config }`.
 * @returns A registry-ready tool definition.
 */
export function createMemoryWriteTool(deps) {
  const { service } = deps
  return {
    name: TOOL_NAMES.write,
    description:
      'Write one durable memory to the local memory store. Use it for facts worth remembering in future sessions ' +
      '(user preferences, project conventions, decisions and their reasons). The fact is de-duplicated, tagged, ' +
      'embedded for semantic recall, and mirrored into the per-day Markdown file.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The fact itself, as one self-contained statement.' },
        layer: {
          type: 'string',
          enum: ['experience', 'world'],
          description:
            'Layer: "experience" (default) for a concrete episode of this agent or user; "world" for general, ' +
            'time-stable knowledge.'
        },
        confidence: { type: 'number', description: 'How sure you are, 0..1 (default 0.8).' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional short tags for retrieval, without the leading "#".'
        },
        relations: {
          type: 'array',
          description: 'Optional relation edges this fact asserts.',
          items: {
            type: 'object',
            properties: {
              subject: { type: 'string' },
              predicate: { type: 'string' },
              object: { type: 'string' }
            },
            required: ['subject', 'predicate', 'object']
          }
        }
      },
      required: ['content']
    },
    output: OUTPUT,
    async execute(args) {
      const content = squash(args && args.content)
      if (content === '') return { error: 'content must be a non-empty string' }
      const layer = args && args.layer === 'world' ? 'world' : 'experience'
      const confidence = Number(args && args.confidence)
      const result = await service.ingestFact({
        content,
        layer,
        confidence: Number.isFinite(confidence) ? confidence : 0.8,
        tags: Array.isArray(args && args.tags) ? args.tags : [],
        relations: Array.isArray(args && args.relations) ? args.relations : [],
        origin: 'manual'
      })
      if (result.duplicate) {
        return reply({ ok: true, duplicate: true }, 'An identical fact is already stored; nothing was written.')
      }
      return reply(
        {
          ok: true,
          id: result.stored.id,
          layer: result.stored.layer,
          confidence: result.stored.confidence,
          relations: result.relations
        },
        `Stored as ${result.stored.layer} (confidence ${result.stored.confidence}) with ${result.relations} ` +
          `relation edge(s): ${result.stored.content}`
      )
    }
  }
}

/**
 * `memory_retrieve` — run the four-path retrieval deliberately.
 * @param deps - `{ service, config }`.
 * @returns A registry-ready tool definition.
 */
export function createMemoryRetrieveTool(deps) {
  const { service, config } = deps
  return {
    name: TOOL_NAMES.retrieve,
    description:
      'Search the local memory store through all four recall paths at once — semantic (vector), keyword, relation ' +
      'graph, and timeline — and return the merged, de-duplicated ranking. Every result reports which paths found ' +
      'it. When a standing answer matches, it is returned instead of the list.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, in natural language.' },
        limit: { type: 'integer', description: `Maximum results (default ${config.searchMaxResults}).` },
        paths: {
          type: 'array',
          items: { type: 'string', enum: ['semantic', 'keyword', 'graph', 'timeline'] },
          description: 'Restrict to a subset of the four paths (default: all four).'
        }
      },
      required: ['query']
    },
    output: OUTPUT,
    async execute(args) {
      const query = squash(args && args.query)
      if (query === '') return { error: 'query must be a non-empty string' }
      const limit = Number.isSafeInteger(args && args.limit) && args.limit > 0 ? args.limit : config.searchMaxResults
      const only = Array.isArray(args && args.paths) && args.paths.length > 0 ? new Set(args.paths) : undefined
      const result = await service.retrieve(query, {
        limit,
        pathSemantic: only === undefined ? true : only.has('semantic'),
        pathKeyword: only === undefined ? true : only.has('keyword'),
        pathGraph: only === undefined ? true : only.has('graph'),
        pathTimeline: only === undefined ? true : only.has('timeline')
      })
      const counts = result.stats.pathCounts
      const body =
        result.results.length === 0 && result.answer === undefined
          ? `No memory matched "${query}" (${result.stats.scanned} fact(s) scanned).`
          : [
              result.answer === undefined
                ? `${result.results.length} memory result(s) for "${query}" (four paths ` +
                  `semantic/keyword/graph/timeline = ${counts.semantic}/${counts.keyword}/${counts.graph}/${counts.timeline}):`
                : `常设答案命中（未跑检索）：${result.answer.text}`,
              ...result.results.map((entry) => renderEntry(entry, config.recallEntryChars))
            ].join('\n')
      return reply(
        {
          ok: true,
          query,
          answer: result.answer,
          foundBy: result.results.map((entry) => ({ id: entry.id, layer: entry.layer, paths: entry.foundBy })),
          count: result.results.length,
          stats: result.stats
        },
        body
      )
    }
  }
}

/**
 * `memory_answer` — pre-store a standing answer.
 * @param deps - `{ service, config }`.
 * @returns A registry-ready tool definition.
 */
export function createMemoryAnswerTool(deps) {
  const { service, config } = deps
  return {
    name: TOOL_NAMES.answer,
    description:
      'Pre-store a frequently needed conclusion as a standing answer. A later turn whose question matches is ' +
      'answered straight from this row: no retrieval pass and no model call. Use it for stable facts the user asks ' +
      'about repeatedly (where a file lives, which profile is active, which command to run).',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The canonical question.' },
        answer: { type: 'string', description: 'The cached answer, complete enough to be used as-is.' },
        questions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional extra phrasings of the same question.'
        },
        confidence: { type: 'number', description: 'Confidence 0..1 (default 0.9).' }
      },
      required: ['question', 'answer']
    },
    output: OUTPUT,
    async execute(args) {
      const question = squash(args && args.question)
      const answer = squash(args && args.answer)
      if (question === '' || answer === '') return { error: 'question and answer must both be non-empty' }
      const saved = await service.saveAnswer({
        question,
        answer,
        questions: Array.isArray(args && args.questions) ? args.questions : [],
        confidence: Number(args && args.confidence)
      })
      return reply(
        { ok: true, id: saved.id, updated: saved.updated, variants: saved.questions.length },
        `${saved.updated ? 'Updated' : 'Stored'} the standing answer for "${saved.question}" ` +
          `(${saved.questions.length} phrasing(s)). Answers older than ${config.answerStaleDays} day(s) are stale.`
      )
    }
  }
}

/**
 * `memory_reflect` — consolidate beliefs now.
 * @param deps - `{ service }`.
 * @returns A registry-ready tool definition.
 */
export function createMemoryReflectTool(deps) {
  const { service } = deps
  return {
    name: TOOL_NAMES.reflect,
    description:
      'Consolidate related facts into beliefs now, instead of waiting for the 7-day background run (the 1st, 8th, ' +
      '15th, 22nd and 29th). Same-topic facts are merged; contradicting evidence either weakens the belief or ' +
      'overwrites its conclusion and archives the previous wording. No fact is ever deleted.',
    parameters: {
      type: 'object',
      properties: {
        force: { type: 'boolean', description: 'Re-run even when this run already consolidated.' },
        period: { type: 'string', description: 'Run-day key to record the run under: YYYY-MM-DD.' }
      },
      required: []
    },
    output: OUTPUT,
    async execute(args) {
      const result = await service.runReflection({
        kind: 'manual',
        force: args && args.force === true,
        periodKey: squash(args && args.period) || undefined,
        phase: 'manual-tool'
      })
      if (result.skipped) {
        return reply(
          { ok: true, skipped: true, periodKey: result.periodKey },
          `Period ${result.periodKey} has already been consolidated; pass force=true to re-run.`
        )
      }
      const stats = result.stats ?? {}
      return reply(
        { ok: true, skipped: false, periodKey: result.periodKey, stats, applied: result.applied },
        `Reflection ${result.periodKey}: scanned ${result.plan.scanned} fact(s) in ${result.plan.clusters} topic(s) — ` +
          `created ${stats.created}, merged ${stats.merged}, reinforced ${stats.reinforced}, ` +
          `overwritten ${stats.overwritten}. Evidence for every belief is preserved; ` +
          `${result.applied.revisions} conclusion(s) archived to belief_revisions.`
      )
    }
  }
}

/**
 * `memory_relate` — record one relation edge by hand.
 * @param deps - `{ service }`.
 * @returns A registry-ready tool definition.
 */
export function createMemoryRelateTool(deps) {
  const { service } = deps
  return {
    name: TOOL_NAMES.relate,
    description:
      'Record one relation edge (subject, predicate, object) in the memory graph, so the relation path can reach ' +
      'facts that mention neither endpoint literally.',
    parameters: {
      type: 'object',
      properties: {
        subject: { type: 'string' },
        predicate: { type: 'string', description: 'A short verb phrase, e.g. "uses", "depends_on", "owns".' },
        object: { type: 'string' },
        confidence: { type: 'number', description: 'Confidence 0..1 (default 0.8).' }
      },
      required: ['subject', 'predicate', 'object']
    },
    output: OUTPUT,
    async execute(args) {
      const relation = await service.addRelation({
        subject: args && args.subject,
        predicate: args && args.predicate,
        object: args && args.object,
        confidence: Number(args && args.confidence)
      })
      return reply(relation, `Recorded: ${relation.subject} —${relation.predicate}→ ${relation.object}`)
    }
  }
}

/**
 * `memory_export` — write the Markdown export.
 * @param deps - `{ service, config }`.
 * @returns A registry-ready tool definition.
 */
export function createMemoryExportTool(deps) {
  const { service, config } = deps
  return {
    name: TOOL_NAMES.export,
    description:
      'Write the human-readable Markdown export of the memory store (facts, beliefs, answers, relations, timeline ' +
      'and an index with live counts). The SQLite database stays the source of truth; this view can be rebuilt at ' +
      'any time.',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: `Target directory (default: the memory directory ${config.memoryDir}).` },
        includeSuperseded: {
          type: 'boolean',
          description: 'Include facts already folded into a belief (default true; they are that belief\'s evidence).'
        }
      },
      required: []
    },
    output: OUTPUT,
    async execute(args) {
      const result = await service.exportMarkdown({
        dir: squash(args && args.dir) || undefined,
        includeSuperseded: !(args && args.includeSuperseded === false)
      })
      const names = result.files.map((file) => file.split(/[\\/]/).pop())
      return reply(
        { ok: true, dir: result.dir, files: result.files, counts: result.counts },
        `Exported ${names.length} file(s) to ${result.dir}: ${names.join(', ')}.`
      )
    }
  }
}

/**
 * `memory_search` — keyword search over the Markdown day files.
 *
 * Kept because the day files are hand-editable and may hold notes that were
 * never extracted into a fact. `memory_retrieve` is the tool to prefer for
 * structured memory.
 *
 * @param deps - `{ index, config, search }`.
 * @returns A registry-ready tool definition.
 */
export function createMemorySearchTool(deps) {
  const { index, config } = deps
  const search = typeof deps.search === 'function' ? deps.search : () => []
  return {
    name: TOOL_NAMES.search,
    description:
      'Keyword search over the Markdown memory day files, including hand-written notes. Matching is ' +
      'case-insensitive and works for Latin words and CJK text. Prefer `memory_retrieve` for structured recall ' +
      'across all four memory layers; use this for raw notes.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords or a short phrase to look for.' },
        limit: { type: 'integer', description: `Maximum records to return (default ${config.searchMaxResults}).` },
        day: { type: 'string', description: 'Optional day filter in YYYY-MM-DD form.' }
      },
      required: ['query']
    },
    output: OUTPUT,
    async execute(args) {
      const query = squash(args && args.query)
      if (query === '') return { error: 'query must be a non-empty string' }
      const limit = Number.isSafeInteger(args && args.limit) && args.limit > 0 ? args.limit : config.searchMaxResults
      const day = squash(args && args.day)
      const pool = day ? index.byDay(day) : index.all()
      const hits = search(pool, query, limit, config.recallMinScore)
      if (hits.length === 0) {
        return reply({ ok: true, results: [], count: 0 }, 'No Markdown record matched that query.')
      }
      return reply(
        {
          ok: true,
          count: hits.length,
          results: hits.map((hit) => ({
            day: hit.record.day,
            time: hit.record.time,
            kind: hit.record.kind,
            score: hit.score,
            tags: hit.record.tags,
            body: hit.record.body
          }))
        },
        `${hits.length} Markdown record(s) matched:\n\n` +
          hits
            .map(
              (hit) =>
                `[${hit.record.day} ${hit.record.time}] (${hit.record.kind}, score ${hit.score}) ` +
                `${clip(squash(hit.record.body), 600)}`
            )
            .join('\n\n')
      )
    }
  }
}
