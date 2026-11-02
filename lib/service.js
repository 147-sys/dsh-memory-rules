/*!
 * dsh-memory-rules — the local memory service.
 *
 * One long-lived object owns the SQLite database, the Markdown mirror and the
 * four-layer vocabulary. It is the only module that writes to the database;
 * `ingest.js`, `retrieve.js`, `reflect.js` and `export.js` are pure functions
 * over the rows it hands them, which is what keeps the whole pipeline testable
 * without a host.
 *
 * Layers, as stored:
 *
 *   世界事实 world       facts.layer = 'world'
 *   自身经历 experience  facts.layer = 'experience'
 *   观察信念 belief      beliefs row + the facts row(s) it cites as evidence
 *   常设答案 answer      answers row (read directly, no retrieval, no model)
 *
 * Everything is additive: no code path in this plugin deletes a fact. A fact
 * that has been folded into a belief keeps its row and gains only a
 * `superseded_by` pointer, so the evidence behind every belief stays readable.
 */

import fs from 'node:fs'
import path from 'node:path'

import { openDatabase } from './db.js'
import { embed, parseVector, serializeVector } from './embed.js'
import { extractFacts } from './extract.js'
import * as reflectImpl from './reflect.js'
import { findAnswer, retrieve as retrieveImpl } from './retrieve.js'
import { RULES } from './rules.js'
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js'
import { buildExport, renderAnswerRecord, renderBeliefRecord, renderFactRecord } from './export.js'
import {
  clamp,
  isoNow,
  makeId,
  normalizeText,
  parseJsonArray,
  round,
  sha256,
  squash
} from './util.js'

/**
 * Message `source.kind` values that represent something a human or the model
 * actually said. Anything else — `memory` (this plugin's own injection),
 * `system`, `developer`, a model-switch notice — is harness-authored text that
 * only looks like conversation.
 */
export const SPOKEN_SOURCE_KINDS = new Set(['user', 'assistant'])

/** How many daily periods a `memory_note` style mirror write may create. */
const MIRROR_HEADER = '# Memory'

/**
 * Identity of the built-in 提示词 block seeded into `prompt_blocks`.
 *
 * The id is deliberately `user-rules`: it is the row that carries the hard
 * collaboration rules inherited from the retired `dsh-user-rules` bundle, keeps
 * that bundle's context text stable in audits, and is the first row of the
 * 提示词 tab.
 */
export const PROMPT_SEED_ID = 'user-rules'

/** Title of the seeded block, as shown in the 提示词 tab. */
export const PROMPT_SEED_TITLE = '用户硬性协作流程'

/**
 * `meta` marker recording that the seed was offered once.
 *
 * Without it the seed would come back every time the table became empty, so a
 * user who deleted the block on purpose would find it resurrected on the next
 * start. With it, "empty table" is a real state: the prompt then falls back to
 * {@link RULES} (see plugin.js), which keeps the hard rules in the prompt while
 * still honouring the deletion.
 */
export const PROMPT_SEED_KEY = 'prompt_blocks_seeded'

/**
 * Longest single message worth extracting facts from.
 *
 * A conversational turn is a few hundred characters. Injected blocks — the
 * runtime snapshot, the skill catalog, a pasted file — are thousands, and their
 * sentences look exactly like facts, which is how they ended up stored as
 * world knowledge.
 */
export const MAX_TURN_CHARS = 1500

/**
 * Markers of an assembled block rather than a spoken turn.
 *
 * Belt-and-braces with {@link MAX_TURN_CHARS}: a short injected block would
 * pass the length guard, and these headers are what it would start with.
 */
export const LOOKS_INJECTED_RE =
  /(Current runtime context|available_skills|The following skills are available|This snapshot supersedes|system-reminder|# Tools\b|<skill_content>)/

/**
 * Ensure the memory root exists and return its resolved absolute path.
 *
 * The directory policy lives here rather than in the old `store.js`, so there
 * is exactly one place that decides where memory lives.
 *
 * @param memoryDir - configured memory root.
 * @returns The resolved, existing root.
 */
export function ensureRoot(memoryDir) {
  const root = path.resolve(memoryDir)
  fs.mkdirSync(root, { recursive: true })
  return root
}

/**
 * Open the memory service.
 *
 * @param options - `{ memoryDir, dbFile, engine, embedDims, logger, markdownMirror }`.
 * @returns A ready {@link MemoryService}.
 */
export async function openMemoryService(options = {}) {
  const memoryDir = ensureRoot(options.memoryDir ?? path.join(process.cwd(), 'memory'))
  const dbFile = options.dbFile ?? path.join(memoryDir, 'memory.db')
  const db = openDatabase(dbFile, { engine: options.engine })
  const service = new MemoryService({
    db,
    memoryDir,
    dbFile,
    embedDims: options.embedDims,
    logger: options.logger,
    markdownMirror: options.markdownMirror !== false,
    reflect: options.reflect,
    index: options.index
  })
  await service.migrate()
  return service
}

/** The memory service: schema owner, ingester, and mirror writer. */
export class MemoryService {
  constructor(init) {
    this.db = init.db
    this.memoryDir = init.memoryDir
    this.dbFile = init.dbFile
    this.engine = init.db.engine
    this.embedDims = Number(init.embedDims) > 0 ? Number(init.embedDims) : 256
    this.markdownMirror = init.markdownMirror !== false
    this.logger = init.logger ?? console
    /** Reflection tuning, taken from the resolved configuration. */
    this.reflectConfig = init.reflect ?? {}
    /**
     * Optional Markdown index kept in step with what this service writes.
     *
     * A reader that re-stats a file it just wrote can miss it (mtime and size
     * can both be unchanged within one millisecond), so the writer hands the
     * parsed record to the index directly.
     */
    this.index = init.index
    this._hashes = undefined
    this._gramCache = new Map()
    this.stats = { ingested: 0, duplicated: 0, relations: 0, mirrors: 0, verbatim: 0 }
  }

  /** Create the schema when missing, and record the schema fingerprint. */
  async migrate() {
    const hadTables = await this._tableExists('facts')
    await this.db.exec(SCHEMA_SQL)
    // Additive columns cannot arrive through `CREATE TABLE IF NOT EXISTS`: on an
    // existing database that statement is a no-op, so a column newly added to
    // the DDL is applied here instead. Each migration is idempotent, so this is
    // safe to run on every open.
    await this._addColumnIfMissing('facts', 'archived_at', 'TEXT', 'idx_facts_archived')
    // 作废 (archive) support for the Beliefs panel. Older stores only have the
    // automated consolidation rows and no way to withdraw one; the column is
    // additive, so every existing belief stays active until a person archives it.
    await this._addColumnIfMissing('beliefs', 'archived_at', 'TEXT', 'idx_beliefs_archived')
    // `priority` marks a belief that must be injected every turn regardless of
    // similarity ("global"), as opposed to one that competes for a slot
    // ("normal"). It lives on `beliefs`, not on `facts`: facts never carry
    // `layer = 'belief'` in this store — beliefs are their own table — so a
    // `facts.priority` column would only ever hold 'normal'.
    const priorityAdded = await this._addColumnIfMissing('beliefs', 'priority', 'TEXT', 'idx_beliefs_priority')
    // Backfill only when the column was just created: an unconditional UPDATE on
    // every open rewrites the table on each startup and locks the file under
    // concurrent opens (the doctor, the export tool, a second agent).
    if (priorityAdded) await this.db.run("UPDATE beliefs SET priority = 'normal' WHERE priority IS NULL")
    const row = await this.db.get('SELECT value FROM meta WHERE key = ?', ['schema_version'])
    if (row === undefined) {
      // `INSERT OR IGNORE`, not `INSERT`: two connections can open the same
      // fresh database at once (the host, plus `memory_export` or the doctor),
      // and a plain insert makes the loser of that race fail with
      // `UNIQUE constraint failed: meta.key` — on first startup, which is the
      // worst possible moment to be unable to store a memory.
      await this.db.run('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)', ['schema_version', SCHEMA_VERSION])
    } else if (row.value !== SCHEMA_VERSION) {
      // Additive-only evolution: the DDL above has already created anything new,
      // so record the fingerprint and continue. A destructive change would need
      // a real migration, and this branch is where it would be added.
      await this.db.run('UPDATE meta SET value = ? WHERE key = ?', [SCHEMA_VERSION, 'schema_version'])
      this.logger.warn?.(
        `memory: schema fingerprint changed (${row.value} -> ${SCHEMA_VERSION}); additive DDL applied`
      )
    }
    if (!hadTables) this.logger.info?.(`memory: initialized ${this.dbFile} (${this.engine})`)
    // The merged plugin owns the hard rules that used to be a separate bundle,
    // so a store that predates the merge gains its 提示词 row on this open.
    await this._seedPromptBlocks()
    this._hashes = undefined
    return this
  }

  /**
   * Offer the built-in 用户硬性协作流程 block once, on the first migration.
   *
   * Called from {@link migrate}, i.e. on every open, and therefore idempotent in
   * two ways: the `meta` marker means the offer happens once per store, and the
   * insert itself is `INSERT OR IGNORE` so a concurrent open (host +
   * `memory_export`, say) cannot fail on the primary key.
   *
   * Failure is contained on purpose. A seed problem must not stop the memory
   * service from opening: the injection path falls back to {@link RULES} when
   * the table is empty, so the hard rules stay in the prompt either way.
   *
   * @returns `true` when this call recorded the seed marker.
   */
  async _seedPromptBlocks() {
    try {
      const marker = await this.db.get('SELECT value FROM meta WHERE key = ?', [PROMPT_SEED_KEY])
      if (marker !== undefined) return false
      const counted = await this.db.get('SELECT COUNT(*) AS n FROM prompt_blocks', [])
      if (Number(counted?.n ?? 0) === 0) {
        const at = isoNow()
        await this.db.run(
          `INSERT OR IGNORE INTO prompt_blocks
             (id, title, body, position, enabled, created_at, updated_at)
           VALUES (?, ?, ?, 0, 1, ?, ?)`,
          [PROMPT_SEED_ID, PROMPT_SEED_TITLE, RULES, at, at]
        )
        this.logger.info?.(`memory: seeded prompt block ${PROMPT_SEED_ID} (${RULES.length} chars)`)
      }
      await this.db.run('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)', [PROMPT_SEED_KEY, isoNow()])
      return true
    } catch (error) {
      this.logger.warn?.(`memory: prompt seed skipped (non-fatal): ${String(error)}`)
      return false
    }
  }

  /**
   * Add one column when the table does not already have it.
   *
   * The column's index is created here rather than in the DDL: on an existing
   * database `CREATE INDEX ... (archived_at)` would run before the column
   * exists and fail, so the index has to follow the `ALTER TABLE`.
   *
   * @param table - table name.
   * @param column - column name.
   * @param definition - SQL type and constraints.
   * @param index - index name to create after the column exists.
   * @returns `true` when the column was added.
   */
  async _addColumnIfMissing(table, column, definition, index) {
    const info = await this.db.all(`PRAGMA table_info(${table})`, [])
    let added = false
    if (!info.some((entry) => entry.name === column)) {
      try {
        await this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
        added = true
        this.logger.info?.(`memory: migrated ${table}.${column}`)
      } catch (error) {
        // A concurrent open may have added it between the probe and the ALTER;
        // losing that race is not a failure, since the column now exists.
        const after = await this.db.all(`PRAGMA table_info(${table})`, [])
        if (!after.some((entry) => entry.name === column)) throw error
      }
    }
    if (typeof index === 'string' && index !== '') {
      await this.db.exec(`CREATE INDEX IF NOT EXISTS ${index} ON ${table} (${column})`)
    }
    return added
  }

  /** True when `table` exists in the database. */
  async _tableExists(table) {
    const row = await this.db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table])
    return row !== undefined
  }

  /** Close the database (flushing the in-memory engine first). */
  async close() {
    await this.db.close()
  }

  /** Persist pending writes for engines that keep the database in memory. */
  async flush() {
    return this.db.flush()
  }

  // -------------------------------------------------------------------------
  // Read helpers
  // -------------------------------------------------------------------------

  /** Every known content hash, used to make ingest idempotent. */
  async _knownHashes() {
    if (this._hashes !== undefined) return this._hashes
    // Archived facts are included on purpose: their content was already judged
    // worthless, so re-deriving it would only archive it again.
    const rows = await this.db.all('SELECT content FROM facts', [])
    const set = new Set()
    for (const row of rows) set.add(hashContent(row.content))
    this._hashes = set
    return set
  }

  /** Character bigrams of a text, memoised for the lifetime of the service. */
  gramsOf(text, n = 2) {
    const key = `${n}:${text}`
    let cached = this._gramCache.get(key)
    if (cached === undefined) {
      cached = new Set(n === 2 ? undefined : undefined)
      cached.clear()
      const value = normalizeText(text)
      if (value.length > 0) {
        if (value.length < n) cached.add(value)
        else for (let i = 0; i + n <= value.length; i += 1) cached.add(value.slice(i, i + n))
      }
      if (this._gramCache.size > 4096) this._gramCache.clear()
      this._gramCache.set(key, cached)
    }
    return cached
  }

  /** All facts, newest first, as decoded row objects. */
  async allFacts({ includeSuperseded = true } = {}) {
    const sql = includeSuperseded
      ? 'SELECT * FROM facts ORDER BY created_at DESC'
      : 'SELECT * FROM facts WHERE superseded_by IS NULL ORDER BY created_at DESC'
    return (await this.db.all(sql, [])).map(decodeFact)
  }

  /** Facts for one layer, newest first. */
  async factsByLayer(layer, { includeSuperseded = false } = {}) {
    const sql = includeSuperseded
      ? 'SELECT * FROM facts WHERE layer = ? ORDER BY created_at DESC'
      : 'SELECT * FROM facts WHERE layer = ? AND superseded_by IS NULL ORDER BY created_at DESC'
    return (await this.db.all(sql, [layer])).map(decodeFact)
  }

  /** Every relation edge. */
  async allRelations() {
    return this.db.all('SELECT * FROM relations ORDER BY created_at DESC', [])
  }

  /**
   * Beliefs, strongest first.
   *
   * Archived beliefs are excluded by default for the same reason archived facts
   * are: "作废" means "stop using it", not "forget it". Retrieval, consolidation
   * and the fact-to-belief annotation all take the default; only the Markdown
   * export asks for the full set so the audit trail stays complete.
   *
   * @param {{includeArchived?: boolean}} options - include withdrawn beliefs.
   * @returns Decoded belief rows.
   */
  async allBeliefs({ includeArchived = false } = {}) {
    const sql = includeArchived
      ? 'SELECT * FROM beliefs ORDER BY strength DESC, updated_at DESC'
      : 'SELECT * FROM beliefs WHERE archived_at IS NULL ORDER BY strength DESC, updated_at DESC'
    return (await this.db.all(sql, [])).map(decodeBelief)
  }

  /** Every standing answer, most recently verified first. */
  async allAnswers() {
    return (await this.db.all('SELECT * FROM answers ORDER BY last_verified DESC', [])).map(decodeAnswer)
  }

  /**
   * Beliefs that must be injected every turn, strongest first.
   *
   * Two things are deliberately *not* similarity-based here. A persona rule
   * ("no summary paragraphs", "lead with the conclusion") is a standing
   * condition on every answer, so it must appear even when the turn's wording
   * has nothing to do with it — which is precisely when similarity ranking drops
   * it. And the set is capped: past two or three pinned rules the model starts
   * reciting them instead of applying them, which is worse than injecting none.
   *
   * Selection: `priority = 'global'` beliefs above the confidence floor fill the
   * slots first; whatever is left is filled by the strongest ordinary belief, so
   * a store with no `global` rows still keeps its persona in view.
   *
   * @param slots - how many pinned beliefs to return (0 disables).
   * @param globalMax - hard cap on how many may come from `global`.
   * @param minStrength - floor for a `global` belief to be pinned.
   * @returns Decoded belief rows (at most `slots`).
   */
  async pinnedBeliefs(slots = 1, globalMax = 2, minStrength = 0.85) {
    const want = Math.max(0, Math.floor(Number(slots) || 0))
    if (want === 0) return []
    const rows = await this.allBeliefs()
    const globals = rows
      .filter((belief) => belief.priority === 'global' && belief.strength >= minStrength)
      .slice(0, Math.max(0, Math.floor(Number(globalMax) || 0)))
    const out = globals.slice(0, want)
    if (out.length < want) {
      const taken = new Set(out.map((belief) => belief.id))
      for (const belief of rows) {
        if (out.length >= want) break
        if (taken.has(belief.id)) continue
        out.push(belief)
      }
    }
    return out
  }

  /** Rows-per-table counts, for status output and self-checks. */
  async counts() {
    const out = {}
    for (const table of ['facts', 'beliefs', 'answers', 'relations', 'belief_revisions', 'reflections']) {
      const row = await this.db.get(`SELECT COUNT(*) AS n FROM ${table}`, [])
      out[table] = row ? Number(row.n) : 0
    }
    return out
  }

  /**
   * Load everything retrieval needs in one pass.
   *
   * The whole corpus is loaded rather than pushing the four search paths into
   * SQL: at the scale this store is designed for (tens of thousands of facts)
   * the in-memory pass is comparable to several round-trips, and it keeps the
   * graph and timeline walks expressible in one place instead of as recursive
   * CTEs. `_snapshot` caches the result and is invalidated by every write.
   */
  async snapshot() {
    if (this._snapshot !== undefined) return this._snapshot
    const [facts, beliefs, relations, answers] = await Promise.all([
      this.allFacts({ includeSuperseded: true }),
      this.allBeliefs(),
      this.allRelations(),
      this.allAnswers()
    ])
    this._snapshot = { facts, beliefs, relations, answers }
    return this._snapshot
  }

  /** Drop the cached snapshot (called by every write path). */
  invalidate() {
    this._snapshot = undefined
  }

  /**
   * Answer one query through the four-path retrieval.
   *
   * @param query - free-text query.
   * @param options - retrieval options (`limit`, `path*`, `answerShortcut`, …).
   * @param now - reference instant for time filters (injectable for tests).
   * @returns The `retrieve()` result, with standing-answer hits counted.
   */
  async retrieve(query, options = {}, now = new Date()) {
    const snapshot = await this.snapshot()
    const result = retrieveImpl(query, snapshot, options, now)
    if (result.answer !== undefined) await this.recordAnswerHit(result.answer.id)
    return result
  }

  /**
   * Look up a standing answer (`常设答案`) without running retrieval.
   *
   * This is the read path the recall injection consults first: a hit means the
   * turn is answered from cache, with no four-path pass and no model call.
   *
   * @param question - the user's question.
   * @param options - `{ threshold }`.
   * @returns The matched answer and its score, or `undefined`.
   */
  async findStandingAnswer(question, options = {}) {
    const snapshot = await this.snapshot()
    const hit = findAnswer(question, snapshot.answers, options)
    if (hit === undefined) return undefined
    await this.recordAnswerHit(hit.answer.id)
    return hit
  }

  /**
   * Ingest a batch of derived messages, newest state last.
   *
   * Messages are de-duplicated by their own content hash before extraction, so
   * feeding the same batch twice (or re-feeding a growing history) stores
   * nothing twice. This is what makes the per-turn hook restart-safe.
   *
   * @param messages - host `Message` values (or `{ role, content }` lookalikes).
   * @param options - `{ sessionId, createdAt, userChars, assistantChars, maxFactsPerTurn, minConfidence, includeAssistant }`.
   * @returns `{ turns, facts, duplicates, relations }`.
   */
  async ingestMessages(messages, options = {}) {
    const seen = options.seen ?? new Set()
    const turns = []
    let skipped = 0
    for (const message of Array.isArray(messages) ? messages : []) {
      const role = message && message.role
      if (role !== 'user' && role !== 'assistant') continue
      // The harness labels authorship in `source.kind`, and the label is the
      // only reliable way to tell a spoken turn from injected context that
      // happens to be short. A message with no `source` at all is accepted so
      // hand-built callers and fixtures still work.
      const sourceKind = message && message.source && message.source.kind
      if (sourceKind !== undefined && sourceKind !== null && !SPOKEN_SOURCE_KINDS.has(sourceKind)) {
        skipped += 1
        continue
      }
      const text = typeof message.text === 'string' ? message.text : messageText(message)
      if (squash(text) === '') continue
      const hash = sha256(`${role}\u0000${normalizeText(text)}`)
      if (seen.has(hash)) continue
      seen.add(hash)
      // A turn longer than MAX_TURN_CHARS is assembled context, not
      // conversation. The harness injects the runtime snapshot, the skill
      // catalog and file contents as `role: 'user'` messages, and extracting
      // those produced "facts" like "A skill is a reusable set of task-specific
      // instructions" and "Use when a DOCX file is an input or requested
      // deliverable". The guard measures the *raw* message, so clipping by
      // `captureUserChars` cannot re-admit it.
      if (text.length > MAX_TURN_CHARS || LOOKS_INJECTED_RE.test(text)) {
        skipped += 1
        continue
      }
      const limit = role === 'user' ? options.userChars : options.assistantChars
      turns.push({ role, text: clipText(text, limit), hash })
    }
    if (turns.length === 0) return { turns: 0, facts: [], duplicates: 0, relations: 0, skipped }
    const result = await this.ingestTurn(turns, {
      sessionId: options.sessionId,
      createdAt: options.createdAt,
      maxFactsPerTurn: options.maxFactsPerTurn,
      minConfidence: options.minConfidence,
      includeAssistant: options.includeAssistant,
      maxFactChars: options.maxFactChars
    })
    return { turns: turns.length, skipped, ...result }
  }

  // -------------------------------------------------------------------------
  // Write path
  // -------------------------------------------------------------------------

  /**
   * Store one already-extracted fact and its relation edges, atomically.
   *
   * @param fact - a candidate from `extractFacts`, or a hand-built equivalent.
   * @param options - `{ sessionId, createdAt, mirror }`.
   * @returns `{ stored, duplicate, relations }`.
   */
  async ingestFact(fact, options = {}) {
    const content = squash(fact.content)
    if (content === '') throw new TypeError('memory: a fact needs non-empty content')
    const hash = hashContent(content)
    const known = await this._knownHashes()
    if (known.has(hash)) {
      this.stats.duplicated += 1
      return { stored: undefined, duplicate: true, relations: 0 }
    }
    const createdAt = options.createdAt ?? fact.createdAt ?? isoNow()
    const sourceSession = options.sessionId ?? fact.sourceSession ?? null
    const layer = fact.layer === 'world' ? 'world' : fact.layer === 'experience' ? 'experience' : 'experience'
    const confidence = round(clamp(fact.confidence ?? 0.6, 0.01, 0.99, 0.6), 3)
    const tags = Array.isArray(fact.tags) ? fact.tags.map((t) => squash(t)).filter(Boolean).slice(0, 12) : []
    const vector = serializeVector(embed(content, this.embedDims))
    const id = fact.id ?? makeId('fact', `${layer}:${normalizeText(content)}`)

    const relations = Array.isArray(fact.relations) ? fact.relations : []
    await this.db.transaction(async () => {
      await this.db.run(
        `INSERT OR IGNORE INTO facts
           (id, content, source_session, created_at, layer, confidence, tags, raw_quote, origin, superseded_by, embedding, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        [
          id,
          content,
          sourceSession,
          createdAt,
          layer,
          confidence,
          JSON.stringify(tags),
          fact.rawQuote ? squash(fact.rawQuote) : null,
          fact.origin === 'user' || fact.origin === 'assistant' || fact.origin === 'manual' || fact.origin === 'reflect'
            ? fact.origin
            : 'assistant',
          vector,
          createdAt
        ]
      )
      await this._insertRelations(relations, id, createdAt, confidence)
    })
    known.add(hash)
    this.invalidate()
    this.stats.ingested += 1
    if (fact.verbatim) this.stats.verbatim += 1
    const stored = { id, content, layer, confidence, tags, createdAt, sourceSession }
    if (this.markdownMirror && options.mirror !== false) this.mirrorFact(stored)
    return { stored, duplicate: false, relations: relations.length }
  }

  /** Insert relation edges for one source fact, ignoring repeats. */
  async _insertRelations(relations, sourceFactId, createdAt, confidence) {
    let inserted = 0
    for (const relation of relations) {
      const subject = squash(relation && relation.subject)
      const predicate = squash(relation && relation.predicate)
      const object = squash(relation && relation.object)
      if (subject === '' || predicate === '' || object === '') continue
      const id = makeId('rel', `${subject}|${predicate}|${object}|${sourceFactId}`)
      await this.db.run(
        `INSERT OR IGNORE INTO relations
           (id, subject, predicate, "object", source_fact_id, created_at, confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, subject, predicate, object, sourceFactId, createdAt, round(confidence, 3)]
      )
      inserted += 1
    }
    this.stats.relations += inserted
    return inserted
  }

  /** Record a relation edge that is not derived from one fact (`memory_relate`). */
  async addRelation({ subject, predicate, object, confidence = 0.8 }, options = {}) {
    const s = squash(subject)
    const p = squash(predicate)
    const o = squash(object)
    if (s === '' || p === '' || o === '') throw new TypeError('memory: a relation needs subject, predicate and object')
    const createdAt = options.createdAt ?? isoNow()
    const id = makeId('rel', `${s}|${p}|${o}|manual`)
    await this.db.run(
      `INSERT OR IGNORE INTO relations
         (id, subject, predicate, "object", source_fact_id, created_at, confidence)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      [id, s, p, o, createdAt, round(clamp(confidence, 0.01, 1, 0.8), 3)]
    )
    this.stats.relations += 1
    this.invalidate()
    return { id, subject: s, predicate: p, object: o, createdAt }
  }

  /**
   * Ingest one turn of conversation: extract, then store.
   *
   * @param turns - `{ role, text }` turns.
   * @param options - extraction options plus `{ sessionId, createdAt }`.
   * @returns `{ facts, duplicates, relations, candidates }`.
   */
  async ingestTurn(turns, options = {}) {
    const candidates =
      Array.isArray(options.candidates) && options.candidates.length > 0
        ? options.candidates
        : extractFacts(turns, options)
    const stored = []
    let duplicates = 0
    let relations = 0
    for (const candidate of candidates) {
      const result = await this.ingestFact(candidate, {
        sessionId: options.sessionId,
        createdAt: options.createdAt,
        mirror: false
      })
      if (result.duplicate) duplicates += 1
      else {
        stored.push(result.stored)
        relations += result.relations
      }
    }
    if (this.markdownMirror && stored.length > 0) {
      this.mirrorTurn({ sessionId: options.sessionId, createdAt: options.createdAt, facts: stored })
    }
    return { facts: stored, duplicates, relations, candidates: candidates.length }
  }

  /**
   * Find the standing answer whose canonical phrasing is `question`.
   *
   * `question_pattern` holds the JSON array of *every* phrasing, so this cannot
   * be an equality test on the column: a bare question never equals its own
   * serialised array. Looking it up that way made every save insert a new row —
   * a stale answer could not be refreshed, and the earliest row kept winning the
   * read path. Compare against the decoded phrasings instead, and still accept a
   * legacy row that stored the bare question.
   */
  async findAnswerByQuestion(question) {
    const wanted = squash(question)
    if (wanted === '') return undefined
    const rows = await this.db.all('SELECT * FROM answers', [])
    return rows.find((row) => {
      const phrasings = parseJsonArray(row.question_pattern)
      if (phrasings.some((q) => squash(q) === wanted)) return true
      return phrasings.length === 0 && squash(row.question_pattern) === wanted
    })
  }

  /** Store or refresh a standing answer (`常设答案`). */
  async saveAnswer({ question, answer, questions, confidence, sourceFactIds }, options = {}) {
    const primary = squash(question)
    const body = squash(answer)
    if (primary === '' || body === '') throw new TypeError('memory: a standing answer needs a question and an answer')
    const patterns = [primary, ...(Array.isArray(questions) ? questions.map((q) => squash(q)) : [])].filter(Boolean)
    const now = options.now ?? isoNow()
    const existing = await this.findAnswerByQuestion(primary)
    const id = existing ? existing.id : makeId('ans', primary)
    const merged = [...new Set([...patterns, ...(existing ? parseJsonArray(existing.question_pattern) : [])])]
    if (existing) {
      await this.db.run(
        `UPDATE answers SET cached_answer = ?, last_verified = ?, question_pattern = ?, confidence = ?, source_fact_ids = ?
         WHERE id = ?`,
        [
          body,
          now,
          JSON.stringify(merged),
          round(clamp(confidence ?? existing.confidence, 0.01, 1, 0.9), 3),
          JSON.stringify(sourceFactIds ?? parseJsonArray(existing.source_fact_ids)),
          id
        ]
      )
    } else {
      await this.db.run(
        `INSERT INTO answers (id, question_pattern, cached_answer, last_verified, created_at, hits, confidence, source_fact_ids)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
        [
          id,
          JSON.stringify(merged),
          body,
          now,
          now,
          round(clamp(confidence ?? 0.9, 0.01, 1, 0.9), 3),
          JSON.stringify(sourceFactIds ?? [])
        ]
      )
    }
    if (this.markdownMirror) this.mirrorAnswer({ question: primary, answer: body, questions: merged, now })
    this.invalidate()
    return { id, question: primary, answer: body, questions: merged, updated: existing !== undefined }
  }

  /** Count one hit on a standing answer (read path bookkeeping). */
  async recordAnswerHit(id) {
    await this.db.run('UPDATE answers SET hits = hits + 1 WHERE id = ?', [id])
  }

  /** Read one `meta` value, or `undefined` when the key is absent. */
  async getMeta(key) {
    const row = await this.db.get('SELECT value FROM meta WHERE key = ?', [key])
    return row === undefined ? undefined : row.value
  }

  /**
   * Write one `meta` value.
   *
   * Used for the pipeline heartbeats: `heartbeat:turn-end` and `heartbeat:idle`
   * record how far ingestion got, which is the difference between "the event
   * never arrived", "the queue never flushed" and "extraction stored nothing".
   *
   * @param key - meta key.
   * @param value - meta value.
   */
  async setMeta(key, value) {
    await this.db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [String(key), String(value)])
  }

  /** Every `meta` row, for diagnostics. */
  async allMeta() {
    return this.db.all('SELECT key, value FROM meta ORDER BY key', [])
  }

  /** Record a completed consolidation run in `reflections`. */
  async recordReflection(row) {
    await this.db.run(
      `INSERT OR REPLACE INTO reflections
         (id, period_key, started_at, finished_at, kind, merged, overwritten, reinforced, scanned, topics, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.periodKey,
        row.startedAt,
        row.finishedAt ?? null,
        row.kind ?? 'scheduled',
        row.merged ?? 0,
        row.overwritten ?? 0,
        row.reinforced ?? 0,
        row.scanned ?? 0,
        row.topics ?? 0,
        row.notes ?? null
      ]
    )
  }

  /** True when a reflection already ran for `periodKey` (idempotence guard). */
  async reflectionRan(periodKey, kind = 'scheduled') {
    const row = await this.db.get('SELECT id FROM reflections WHERE period_key = ? AND kind = ?', [periodKey, kind])
    return row !== undefined
  }

  /** Every recorded consolidation run, newest first. */
  async reflections() {
    return this.db.all('SELECT * FROM reflections ORDER BY started_at DESC, period_key DESC', [])
  }

  /** Every archived belief revision, newest first. */
  async beliefRevisions(beliefId) {
    return beliefId === undefined
      ? this.db.all('SELECT * FROM belief_revisions ORDER BY created_at DESC', [])
      : this.db.all('SELECT * FROM belief_revisions WHERE belief_id = ? ORDER BY created_at DESC', [beliefId])
  }

  // -------------------------------------------------------------------------
  // Reflection (反思)
  // -------------------------------------------------------------------------

  /** Normalise the planner options from a resolved configuration. */
  reflectionOptions(overrides = {}) {
    const config = this.reflectConfig ?? {}
    // `reflectSkipPatterns` is user-owned configuration, so a broken regular
    // expression must not take the consolidation down: it is dropped with a
    // warning and the built-in gate still applies.
    const extraPatterns = []
    for (const raw of config.reflectSkipPatterns ?? []) {
      try {
        extraPatterns.push(new RegExp(raw))
      } catch (error) {
        this.logger.warn?.(`memory: invalid reflectSkipPatterns entry "${raw}" ignored: ${String(error)}`)
      }
    }
    return {
      minEvidence: Number(overrides.minEvidence) > 0 ? Number(overrides.minEvidence) : (config.reflectMinEvidence ?? 3),
      threshold:
        Number.isFinite(Number(overrides.topicThreshold)) ? Number(overrides.topicThreshold) : (config.reflectTopicThreshold ?? 0.34),
      qualityGate: overrides.qualityGate ?? config.reflectQualityGate ?? true,
      minChars: Number(overrides.minChars) > 0 ? Number(overrides.minChars) : (config.reflectMinChars ?? 12),
      skipPatterns: overrides.skipPatterns ?? extraPatterns,
      newFactIds: overrides.newFactIds,
      now: overrides.now
    }
  }

  /**
   * Plan and apply one consolidation run.
   *
   * @param options - `{ periodKey, kind, newFactIds, now, force }`.
   * @returns `{ periodKey, skipped, plan, applied }`.
   */
  async runReflection(options = {}) {
    const now = options.now instanceof Date ? options.now : new Date()
    const periodKey = options.periodKey ?? reflectImpl.periodKeyFor(now)
    const kind = options.kind ?? 'scheduled'
    if (options.force !== true && (await this.reflectionRan(periodKey, kind))) {
      return { periodKey, kind, skipped: true, ran: false, plan: undefined, applied: undefined }
    }
    const startedAt = isoNow(now)
    const snapshot = await this.snapshot()
    const plan = reflectImpl.reflect({ ...snapshot, allFacts: snapshot.facts }, this.reflectionOptions({ ...options, now }))
    const applied = await this.applyReflection(plan, { now })
    const row = {
      id: reflectImpl.reflectionId(periodKey, kind),
      periodKey,
      kind,
      startedAt,
      finishedAt: isoNow(new Date()),
      merged: plan.stats.merged,
      overwritten: plan.stats.overwritten,
      reinforced: plan.stats.reinforced,
      scanned: plan.scanned,
      topics: plan.clusters,
      notes: `created=${plan.stats.created} filtered=${plan.filtered}${options.phase === undefined ? '' : ` phase=${options.phase}`}`
    }
    await this.recordReflection(row)
    this.invalidate()
    if (this.markdownMirror && (plan.creates.length > 0 || plan.updates.length > 0)) {
      this.mirrorBeliefs({ plan, now })
    }
    return { periodKey, kind, skipped: false, ran: true, plan, applied, stats: plan.stats }
  }

  /**
   * Apply a reflection plan atomically.
   *
   * Every step is additive except the belief row itself: facts gain a
   * `superseded_by` pointer, a revision row is appended before a statement is
   * replaced, and no fact is ever deleted.
   *
   * @param plan - output of `reflect()`.
   * @param options - `{ now }`.
   * @returns Counters for the caller's log line.
   */
  async applyReflection(plan, options = {}) {
    const now = options.now instanceof Date ? options.now : new Date()
    const stamp = isoNow(now)
    const applied = { created: 0, merged: 0, reinforced: 0, overwritten: 0, revisions: 0, superseeded: 0 }
    await this.db.transaction(async () => {
      for (const create of plan.creates ?? []) {
        // The run stamp is part of the id so a new consolidation can never
        // replace an archived belief of the same topic. `INSERT OR REPLACE`
        // would otherwise clear the old row's `archived_at`, resurrecting a
        // belief the user deliberately withdrew.
        const id = makeId('belief', `${create.topic}:${stamp}`)
        await this.db.run(
          `INSERT OR REPLACE INTO beliefs
             (id, topic, statement, evidence_ids, evidence_count, strength, updated_at, created_at, layer, revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
          [
            id,
            create.topic,
            create.statement,
            JSON.stringify(create.evidenceIds ?? []),
            (create.evidenceIds ?? []).length,
            create.strength,
            stamp,
            stamp,
            create.layer === 'world' ? 'world' : 'experience'
          ]
        )
        applied.created += 1
        applied.superseeded += await this._supersedeEvidence(create.evidenceIds, create.representativeId, id)
      }
      for (const update of plan.updates ?? []) {
        const current = await this.db.get('SELECT * FROM beliefs WHERE id = ?', [update.id])
        if (current === undefined) continue
        const overwriting = update.action === 'overwrite'
        if (overwriting || update.previousStatement !== update.statement) {
          await this.db.run(
            `INSERT OR REPLACE INTO belief_revisions
               (id, belief_id, previous_statement, previous_strength, previous_evidence, reason, trigger_fact_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              makeId('rev', `${update.id}:${stamp}:${update.previousStatement}`),
              update.id,
              update.previousStatement,
              update.previousStrength,
              JSON.stringify(update.previousEvidence ?? []),
              update.reason,
              update.triggerFactId ?? null,
              stamp
            ]
          )
          applied.revisions += 1
        }
        await this.db.run(
          `UPDATE beliefs
              SET statement = ?, evidence_ids = ?, evidence_count = ?, strength = ?, updated_at = ?,
                  layer = ?, revision = revision + ?
            WHERE id = ?`,
          [
            overwriting ? update.statement : current.statement,
            JSON.stringify(update.evidenceIds ?? []),
            update.evidenceCount ?? (update.evidenceIds ?? []).length,
            update.strength,
            stamp,
            current.layer,
            overwriting ? 1 : 0,
            update.id
          ]
        )
        if (update.action === 'merge') applied.merged += 1
        else if (update.action === 'overwrite') applied.overwritten += 1
        else applied.reinforced += 1
        applied.superseeded += await this._supersedeEvidence(
          update.evidenceIds,
          update.representativeId,
          update.id
        )
      }
    })
    return applied
  }

  /**
   * Mark every evidence fact except the representative as folded into a belief.
   *
   * `archived_at IS NULL` is not optional. The two states are mutually
   * exclusive by definition (see tools/cleanup.mjs): `superseded` means the
   * observation was valid and a newer claim replaced it, while `archived` means
   * it was never a valid observation at all. Writing a `superseded_by` pointer
   * onto a withdrawn row makes the row claim both, which `tools/doctor.mjs`
   * reports as an integrity failure.
   */
  async _supersedeEvidence(evidenceIds, representativeId, beliefId) {
    let count = 0
    for (const factId of evidenceIds ?? []) {
      if (factId === representativeId) continue
      const result = await this.db.run(
        `UPDATE facts SET superseded_by = ?
          WHERE id = ? AND archived_at IS NULL
            AND (superseded_by IS NULL OR superseded_by = ?)`,
        [beliefId, factId, beliefId]
      )
      count += Number(result?.changes ?? 0)
    }
    return count
  }

  /** The beliefs a fact belongs to, for `memory_retrieve` annotation. */
  async beliefsForFact(factId) {
    return (await this.allBeliefs()).filter((belief) => (belief.evidenceIds ?? []).includes(factId))
  }

  /** Append a reflection summary and the affected beliefs to `beliefs.md`. */
  mirrorBeliefs({ plan, now }) {
    try {
      const file = path.join(this.memoryDir, 'beliefs.md')
      const lines = [
        `## 反思 ${isoNow(now)}`,
        '',
        `扫描 ${plan.scanned} 条事实 / ${plan.clusters} 个主题：新建 ${plan.stats.created}，合并 ${plan.stats.merged}，` +
          `加固 ${plan.stats.reinforced}，覆写 ${plan.stats.overwritten}。原始事实全部保留。`,
        '',
        ...plan.creates.map((create) => `- 新建信念：${create.statement}（证据 ${create.evidenceIds.length} 条）`),
        ...plan.updates.map((update) =>
          update.action === 'overwrite'
            ? `- 覆写信念：${update.previousStatement} → ${update.statement}（${update.reason}）`
            : `- ${update.action === 'merge' ? '合并' : '加固'}信念：${update.statement}（强度 ${update.strength}）`
        ),
        ''
      ]
      appendRaw(file, `${lines.join('\n')}\n`)
      return file
    } catch (error) {
      this.logger.warn?.(`memory: belief mirror failed (non-fatal): ${String(error)}`)
      return undefined
    }
  }

  /**
   * Is a 7-day consolidation owed right now?
   *
   * Judged from the most recent *scheduled* instant rather than from the wall
   * clock's own period: a machine that was off for all of the 8th must still
   * consolidate when it wakes on the 10th.
   *
   * @param now - reference instant.
   * @param options - `{ days, at }`.
   * @returns `{ due, periodKey, runAt }`.
   */
  async reflectionDue(now = new Date(), options = {}) {
    const config = this.reflectConfig
    const days =
      Array.isArray(options.days) && options.days.length > 0 ? options.days : (config.reflectDays ?? reflectImpl.PERIOD_DAYS)
    const at = options.at ?? config.reflectAt ?? '03:00'
    const previous = reflectImpl.previousRunAt(now, { days, at })
    if (previous === undefined) return { due: false, periodKey: undefined, runAt: undefined }
    const periodKey = reflectImpl.periodKeyFor(previous)
    const ran = await this.reflectionRan(periodKey, 'scheduled')
    return { due: !ran, periodKey, runAt: previous }
  }

  /**
   * Create (but do not start) the 7-day reflection timer.
   * @param overrides - `{ logger, now, setTimeout, clearTimeout, startupDelayMs }`.
   * @returns A `ReflectionScheduler`.
   */
  createScheduler(overrides = {}) {
    const config = this.reflectConfig
    return new reflectImpl.ReflectionScheduler({
      days: config.reflectDays ?? reflectImpl.PERIOD_DAYS,
      at: config.reflectAt ?? '03:00',
      startupDelayMs: overrides.startupDelayMs ?? 0,
      logger: overrides.logger ?? this.logger,
      now: overrides.now,
      setTimeout: overrides.setTimeout,
      clearTimeout: overrides.clearTimeout,
      isDue: (now) => this.reflectionDue(now),
      run: ({ periodKey, kind, phase }) => this.runReflection({ periodKey, kind, phase })
    })
  }

  // -------------------------------------------------------------------------
  // Markdown mirror (kept from v1: the files stay human-editable)
  // -------------------------------------------------------------------------

  /** Append one fact to today's day file. */
  mirrorFact(fact) {
    try {
      const stamp = fact.createdAt ?? isoNow()
      const file = mirrorFilePath(this.memoryDir, stamp)
      appendMirror(file, renderFactRecord(fact))
      this.stats.mirrors += 1
      this.index?.prepend?.({
        day: String(stamp).slice(0, 10),
        time: String(stamp).slice(11, 19) || '00:00:00',
        kind: fact.layer === 'world' ? 'world' : 'experience',
        body: `- **${fact.layer}** ${fact.content}`,
        tags: Array.isArray(fact.tags) ? fact.tags : []
      })
      return file
    } catch (error) {
      this.logger.warn?.(`memory: markdown mirror failed (non-fatal): ${String(error)}`)
      return undefined
    }
  }

  /** Append a whole turn's facts under one heading. */
  mirrorTurn({ sessionId, createdAt, facts }) {
    if (!Array.isArray(facts) || facts.length === 0) return undefined
    try {
      const stamp = createdAt ?? isoNow()
      const file = mirrorFilePath(this.memoryDir, stamp)
      const clock = stamp.slice(11, 19) || '00:00:00'
      const lines = [
        `### ${clock} — session 🗂`,
        '',
        `**Session**: \`${sessionId ?? 'unknown'}\` — ${facts.length} extracted fact(s)`,
        '',
        ...facts.map((fact) => renderFactRecord(fact).trimEnd()),
        '',
        '#session #auto',
        ''
      ]
      appendRaw(file, `${lines.join('\n')}\n`)
      this.stats.mirrors += 1
      this.index?.prepend?.({
        day: String(stamp).slice(0, 10),
        time: clock,
        kind: 'session',
        body: facts.map((fact) => `- **${fact.layer}** ${fact.content}`).join('\n'),
        tags: ['session', 'auto']
      })
      return file
    } catch (error) {
      this.logger.warn?.(`memory: markdown mirror failed (non-fatal): ${String(error)}`)
      return undefined
    }
  }

  /** Append one standing answer to `answers.md`. */
  mirrorAnswer({ question, answer, questions, now }) {
    try {
      const file = path.join(this.memoryDir, 'answers.md')
      appendRaw(file, `${renderAnswerRecord({ question, cachedAnswer: answer, questions, lastVerified: now })}\n`)
      return file
    } catch (error) {
      this.logger.warn?.(`memory: markdown mirror failed (non-fatal): ${String(error)}`)
      return undefined
    }
  }

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  /**
   * Regenerate the human-readable Markdown export.
   * @param options - `{ dir, now, includeSuperseded }`.
   * @returns `{ dir, files }`.
   */
  async exportMarkdown(options = {}) {
    const target = options.dir ?? this.memoryDir
    fs.mkdirSync(target, { recursive: true })
    const [facts, beliefs, answers, relations] = await Promise.all([
      this.allFacts({ includeSuperseded: options.includeSuperseded !== false }),
      // Archived beliefs are deliberate withdrawals, not deletions: include them
      // in the human-readable view so the audit trail shows both states.
      this.allBeliefs({ includeArchived: true }),
      this.allAnswers(),
      this.allRelations()
    ])
    const counts = await this.counts()
    const files = buildExport({
      dir: target,
      facts,
      beliefs,
      answers,
      relations,
      counts,
      engine: this.engine,
      dbFile: this.dbFile,
      now: options.now ?? new Date()
    })
    return { dir: target, files, counts }
  }
}

/** Decode a `facts` row into the shape the rest of the plugin uses. */
export function decodeFact(row) {
  return {
    id: row.id,
    content: row.content,
    layer: row.layer,
    confidence: Number(row.confidence),
    tags: parseJsonArray(row.tags),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sourceSession: row.source_session,
    origin: row.origin,
    rawQuote: row.raw_quote,
    supersededBy: row.superseded_by,
    archivedAt: row.archived_at,
    embedding: parseVector(row.embedding)
  }
}

/** Decode a `beliefs` row. */
export function decodeBelief(row) {
  return {
    id: row.id,
    topic: row.topic,
    statement: row.statement,
    evidenceIds: parseJsonArray(row.evidence_ids),
    evidenceCount: Number(row.evidence_count),
    strength: Number(row.strength),
    layer: row.layer,
    revision: Number(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? null,
    priority: row.priority ?? 'normal'
  }
}

/** Decode an `answers` row. */
export function decodeAnswer(row) {
  return {
    id: row.id,
    question: parseJsonArray(row.question_pattern)[0] ?? '',
    questions: parseJsonArray(row.question_pattern),
    answer: row.cached_answer,
    lastVerified: row.last_verified,
    createdAt: row.created_at,
    hits: Number(row.hits),
    confidence: Number(row.confidence),
    sourceFactIds: parseJsonArray(row.source_fact_ids)
  }
}

/** Stable content hash used for ingest-level de-duplication. */
export function hashContent(content) {
  return sha256(normalizeText(content))
}

/** Extract a message's display text, tolerating string or block content. */
export function messageText(message) {
  const content = message && message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
}

/** Truncate text to a character budget (`<= 0` disables truncation). */
function clipText(text, max) {
  const value = String(text ?? '')
  const limit = Number(max)
  if (!Number.isFinite(limit) || limit <= 0 || value.length <= limit) return value
  return `${value.slice(0, limit)}…(+${value.length - limit} chars)`
}

/** Create the memory directory if needed, then return the day file path. */
function mirrorFilePath(memoryDir, iso) {
  const day = String(iso).slice(0, 10)
  return path.join(memoryDir, `${day}.md`)
}

/** Append a rendered record with the standard blank-line framing. */
function appendMirror(file, record) {
  appendRaw(file, `${String(record).trimEnd()}\n\n`)
}

/** Append raw text to a file, creating the parent directory and header. */
function appendRaw(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  let existing = ''
  try {
    existing = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error
  }
  let prefix = existing
  if (prefix.length === 0) {
    const day = path.basename(file, '.md')
    prefix = `${MIRROR_HEADER} — ${day}\n\n`
  } else if (!prefix.endsWith('\n')) {
    prefix += '\n'
  }
  fs.writeFileSync(file, prefix + text, 'utf8')
}

/** Late-bound export of the Markdown renderers for external callers. */
export { renderAnswerRecord, renderBeliefRecord, renderFactRecord }
