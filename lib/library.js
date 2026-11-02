/*!
 * dsh-memory-rules — 记忆与规则 / host service behind the Web UI page.
 *
 * Two resources share one Typert Remote namespace (`memoryLibrary`), because
 * they share one database and one UI page:
 *
 *   beliefs 观察信念 (信念库 tab) — read, correct and delete what the background
 *           reflection consolidated. A person needs this because consolidation
 *           can infer a belief the user disagrees with; correcting the wording
 *           is the human-AI alignment step.
 *   prompts 提示词 (提示词 tab)   — the ordered blocks that are injected into the
 *           system prompt on every request, including the seeded
 *           `prompt_blocks.id='user-rules'` row that carries the user's hard
 *           collaboration rules (inherited from the retired `dsh-user-rules`
 *           bundle).
 *
 * Semantic rules, and why they differ between the two resources:
 *
 *  - a belief is never deleted by this plugin *automatically*; there is exactly
 *    one hard-delete path (`deleteBelief`) and it is reachable only from the
 *    user's click. The revisions behind a belief are audited, so the delete
 *    removes the belief row and its `belief_revisions` together (the revisions
 *    go through the existing `ON DELETE CASCADE`) while the `facts` rows that
 *    were cited as evidence stay untouched;
 *  - `create` and `archive` are deliberately no longer Remote methods: the
 *    信念库 tab has no "add" and no "作废/恢复" entry any more, and leaving the
 *    methods exported would keep two write paths alive that no UI owns;
 *  - a prompt block is data the user owns. Delete is a real DELETE (there is no
 *    history for it), and every successful write calls back into `plugin.js` so
 *    the in-memory injection cache is refreshed before the next request.
 *
 * Wire shapes (snake_case on fields that mirror the tables, so the UI can show
 * `created_at` unchanged):
 *
 *   belief  { id, content, confidence, layer: 'belief', evidence_count,
 *             revision_number, created_at, updated_at, archived_at, overwritten, topic }
 *   prompt  { id, title, body, position, enabled, chars, created_at, updated_at }
 *
 * The browser never touches SQLite; it calls these methods through the Host.
 */

import { RULES } from './rules.js'
import { clamp, isoNow, makeId, normalizeText, round, squash } from './util.js'

/** Marker key read by the Typert Gateway's SRC fallback. */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/** Longest accepted belief text, matching the capture budget. */
export const MAX_CONTENT_CHARS = 4000

/** Longest accepted prompt title. */
export const MAX_TITLE_CHARS = 80

/**
 * Longest accepted prompt body.
 *
 * Every injected character is paid for on every request, and the whole block
 * set is prepended to each prompt, so one block is capped rather than the sum.
 */
export const MAX_BODY_CHARS = 8000

/** Highest accepted `position`; the column only orders blocks. */
export const MAX_POSITION = 1000000

/** Distance between two auto-assigned positions, so a gap stays available. */
const POSITION_STEP = 10

const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100

/** Revision reasons produced by an automated overwrite (see reflect.js). */
const OVERWRITE_REASON_PREFIX = 'contradicted_by_new_evidence'

/** Name of the system-prompt context the blocks are injected through. */
export const PROMPT_CONTEXT_NAME = 'memory-rules'

/** Prompt order of that context: before the memory guidance (150). */
export const PROMPT_CONTEXT_ORDER = 120

/** The 提示词 methods, in the order the UI declares them. */
export const PROMPT_METHODS = Object.freeze(['listPrompts', 'createPrompt', 'updatePrompt', 'deletePrompt'])

/** The 信念 methods. `create`/`archive` are gone on purpose (see header). */
export const BELIEF_METHODS = Object.freeze(['list', 'update', 'deleteBelief'])

/** Everything exposed through the `memoryLibrary` Remote namespace. */
export const REMOTE_METHODS = Object.freeze([...BELIEF_METHODS, ...PROMPT_METHODS])

/**
 * Join prompt rows into the exact text that enters the system prompt.
 *
 * One implementation, used by both halves of the injection path: the Host's
 * injection cache (`plugin.js`) and the UI's 注入预览 (`listPrompts`). That is
 * what makes the preview truthful instead of a re-implementation that could
 * drift — the fallback itself is applied by the caller.
 *
 * @param rows - rows carrying a `body`.
 * @returns The bodies joined by a blank line, in the order given.
 */
export function joinPromptBlocks(rows) {
  return (rows ?? [])
    .map((row) => (typeof row?.body === 'string' ? row.body : ''))
    .filter((body) => body.trim() !== '')
    .join('\n\n')
}

/**
 * Attach the SRC Remote markers so the gateway can expose these methods.
 *
 * @param prototype - service prototype.
 * @param methods - exported method names.
 * @returns {void}
 */
function markRemoteMethods(prototype, methods) {
  Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze(methods.map((method) => Object.freeze({
        method,
        invocation: Object.freeze({ kind: 'direct' })
      })))
    })
  })
}

/**
 * @param {unknown} value - candidate belief id.
 * @returns {string} validated belief id.
 */
function requireId(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('缺少信念 id')
  const id = value.trim()
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error('信念 id 格式不合法')
  return id
}

/**
 * @param {unknown} value - candidate prompt id.
 * @returns {string} validated prompt id.
 */
function requirePromptId(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('缺少提示词 id')
  const id = value.trim()
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error('提示词 id 格式不合法')
  return id
}

/**
 * @param {unknown} value - candidate belief text.
 * @returns {string} squashed, length-checked text.
 */
function requireContent(value) {
  if (typeof value !== 'string') throw new Error('信念内容不能为空')
  const content = squash(value)
  if (content === '') throw new Error('信念内容不能为空')
  if (content.length > MAX_CONTENT_CHARS) {
    throw new Error(`信念内容不能超过 ${MAX_CONTENT_CHARS} 个字符（当前 ${content.length}）`)
  }
  return content
}

/**
 * @param {unknown} value - candidate confidence.
 * @returns {number} a number in [0, 1], rounded to 3 decimals.
 */
function requireConfidence(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) throw new Error('置信度必须是 0 到 1 之间的数字')
  if (n < 0 || n > 1) throw new Error('置信度必须在 0.00 到 1.00 之间')
  return round(n, 3)
}

/**
 * A short human-readable topic label for an edited belief.
 *
 * Beliefs consolidated by `reflect` already carry a topic label; after a manual
 * correction the label is re-derived from the first clause. It is a
 * display/search label only — never an identity.
 *
 * @param {string} content - validated belief text.
 * @returns {string} topic label.
 */
function topicFor(content) {
  const compact = squash(content)
  return compact.length <= 40 ? compact : `${compact.slice(0, 40)}…`
}

/**
 * @param {unknown} value - candidate prompt title.
 * @returns {string} trimmed, length-checked title.
 */
function requireTitle(value) {
  if (typeof value !== 'string') throw new Error('标题不能为空')
  const title = squash(value)
  if (title === '') throw new Error('标题不能为空')
  if (title.length > MAX_TITLE_CHARS) {
    throw new Error(`标题不能超过 ${MAX_TITLE_CHARS} 个字符（当前 ${title.length}）`)
  }
  return title
}

/**
 * Validate one prompt body.
 *
 * The body is NOT squashed: newlines and indentation are part of what the user
 * wrote and part of what the model reads, so only the leading and trailing
 * whitespace is trimmed. The 8000-character cap matches the UI counter.
 *
 * @param {unknown} value - candidate body.
 * @returns {string} the body as it will be injected.
 */
function requireBody(value) {
  if (typeof value !== 'string') throw new Error('正文不能为空')
  const body = value.replace(/^\s+|\s+$/g, '')
  if (body === '') throw new Error('正文不能为空')
  if (body.length > MAX_BODY_CHARS) {
    throw new Error(`正文不能超过 ${MAX_BODY_CHARS} 个字符（当前 ${body.length}）`)
  }
  return body
}

/**
 * @param {unknown} value - candidate ordering position.
 * @returns {number} an integer in [0, MAX_POSITION].
 */
function requirePosition(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > MAX_POSITION) {
    throw new Error(`排序必须是 0 到 ${MAX_POSITION} 之间的整数`)
  }
  return n
}

/**
 * @param {unknown} value - candidate enabled flag.
 * @param {boolean} fallback - value used when the field is absent.
 * @returns {boolean} the flag.
 */
function requireEnabled(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1' || value === 'true') return true
  if (value === 0 || value === '0' || value === 'false') return false
  throw new Error('启用状态必须是布尔值')
}

/**
 * Map a `beliefs` row to the wire shape.
 *
 * @param {object} row - row from `beliefs` (optionally with `overwrite_reason`).
 * @returns {object} the UI-facing belief.
 */
function toBeliefItem(row) {
  const reason = typeof row.overwrite_reason === 'string' ? row.overwrite_reason : ''
  return {
    id: row.id,
    content: row.statement,
    confidence: round(Number(row.strength), 3),
    layer: 'belief',
    evidence_count: Number(row.evidence_count),
    revision_number: Number(row.revision),
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at ?? null,
    overwritten: reason.startsWith(OVERWRITE_REASON_PREFIX),
    topic: row.topic
  }
}

/**
 * Map a `prompt_blocks` row to the wire shape.
 *
 * @param {object} row - row from `prompt_blocks`.
 * @returns {object} the UI-facing prompt block.
 */
function toPromptItem(row) {
  const body = typeof row.body === 'string' ? row.body : ''
  return {
    id: row.id,
    title: row.title,
    body,
    position: Number(row.position),
    enabled: Number(row.enabled) === 1,
    chars: body.length,
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}

/** 记忆与规则 host service: the 信念库 and 提示词 resources of one store. */
export class MemoryLibraryService {
  /**
   * @param {{ready: Promise<object>, logger?: object,
   *   onPromptsChanged?: () => void}} options - the shared
   *   {@link import('./service.js').MemoryService} promise, a logger, and the
   *   injection-cache refresh hook called after every successful prompt write.
   */
  constructor(options) {
    this.ready = options.ready
    this.logger = options.logger ?? console
    this.onPromptsChanged = options.onPromptsChanged
  }

  /** @returns {Promise<object>} the opened memory service. */
  async service() {
    return await this.ready
  }

  /**
   * Tell the Host half that the injected text may have changed.
   *
   * Runs outside the request path and never throws: a cache refresh failure
   * must not turn a saved edit into an error reply, and the worst case is that
   * the previous (still valid) text keeps being injected until the next write.
   *
   * @returns {void}
   */
  _promptsChanged() {
    const hook = this.onPromptsChanged
    if (typeof hook !== 'function') return
    try {
      void Promise.resolve(hook()).catch((error) => {
        this.logger.warn?.(`memory: prompt cache refresh failed (non-fatal): ${String(error)}`)
      })
    } catch (error) {
      this.logger.warn?.(`memory: prompt cache refresh failed (non-fatal): ${String(error)}`)
    }
  }

  // ------------------------------------------------------------ beliefs 信念库

  /**
   * One page of beliefs, most recently updated first.
   *
   * @param {{query?: string, scope?: 'active'|'archived'|'all',
   *   page?: number, pageSize?: number}} payload - list request.
   * @returns {Promise<object>} `{ kind: 'beliefs', items, total, page, pages, pageSize, counts }`.
   */
  async list(payload) {
    const input = payload !== null && typeof payload === 'object' ? payload : {}
    const service = await this.service()
    const pageSize = Math.trunc(clamp(input.pageSize ?? DEFAULT_PAGE_SIZE, 5, MAX_PAGE_SIZE))
    const scope = input.scope === 'archived' || input.scope === 'all' ? input.scope : 'active'
    const query = typeof input.query === 'string' ? squash(input.query).slice(0, 200) : ''

    const where = []
    const params = []
    if (scope === 'active') where.push('b.archived_at IS NULL')
    else if (scope === 'archived') where.push('b.archived_at IS NOT NULL')
    if (query !== '') {
      where.push('instr(lower(b.statement), lower(?)) > 0')
      params.push(query)
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

    const totalRow = await service.db.get(`SELECT COUNT(*) AS n FROM beliefs b ${clause}`, params)
    const total = Number(totalRow?.n ?? 0)
    const pages = Math.max(1, Math.ceil(total / pageSize))
    const page = Math.min(Math.max(1, Math.trunc(Number(input.page) || 1)), pages)

    // `overwrite_reason` is what makes the "该信念因与新事实冲突已被系统重写"
    // tooltip truthful: it is a contradiction that replaced the statement, not
    // just any revision (a manual correction also increments `revision`).
    const rows = await service.db.all(
      `SELECT b.*,
              (SELECT r.reason FROM belief_revisions r
                WHERE r.belief_id = b.id AND r.reason LIKE 'contradicted_by_new_evidence%'
                ORDER BY r.created_at DESC LIMIT 1) AS overwrite_reason
         FROM beliefs b ${clause}
        ORDER BY b.updated_at DESC, b.rowid DESC
        LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize]
    )
    const countsRow = await service.db.get(
      'SELECT SUM(CASE WHEN archived_at IS NULL THEN 1 ELSE 0 END) AS active, ' +
        'SUM(CASE WHEN archived_at IS NOT NULL THEN 1 ELSE 0 END) AS archived FROM beliefs',
      []
    )

    return {
      // A version marker the browser half checks before rendering. Without it
      // a stale Host (pre-2.2.0, facts-only) would silently feed fact rows into
      // the beliefs table, so the client shows "restart DSH" instead.
      kind: 'beliefs',
      items: rows.map(toBeliefItem),
      total,
      page,
      pages,
      pageSize,
      counts: {
        active: Number(countsRow?.active ?? 0),
        archived: Number(countsRow?.archived ?? 0)
      }
    }
  }

  /**
   * Correct one belief's wording and/or confidence.
   *
   * Every real change is a revision: the previous statement, strength and
   * evidence list are appended to `belief_revisions` (reason `manual_edit`)
   * *before* the row is updated, and `revision` is incremented by one. A
   * no-op save returns the row untouched rather than inflating the revision
   * number.
   *
   * @param {{id: string, content?: string, statement?: string,
   *   confidence?: number, strength?: number}} payload - edit.
   * @returns {Promise<{item: object}>} the updated belief.
   */
  async update(payload) {
    const input = payload !== null && typeof payload === 'object' ? payload : {}
    const service = await this.service()
    const id = requireId(input.id)
    const row = await service.db.get('SELECT * FROM beliefs WHERE id = ?', [id])
    if (row === undefined) throw new Error('这条信念不存在，可能已从存储中移除')
    if (row.archived_at !== null && row.archived_at !== undefined) {
      throw new Error('这条信念已作废，无法编辑；如需清除请直接删除')
    }

    const content =
      input.content === undefined && input.statement === undefined
        ? row.statement
        : requireContent(input.content ?? input.statement)
    const confidence =
      input.confidence === undefined && input.strength === undefined
        ? round(Number(row.strength), 3)
        : requireConfidence(input.confidence ?? input.strength)

    if (content !== row.statement) {
      const clash = await service.db.get('SELECT id FROM beliefs WHERE statement = ? AND id <> ? LIMIT 1', [
        content,
        id
      ])
      if (clash !== undefined) throw new Error('另一条信念已使用相同内容，请修改后再保存')
    }

    if (content !== row.statement || confidence !== round(Number(row.strength), 3)) {
      const updatedAt = isoNow()
      await service.db.transaction(async () => {
        await service.db.run(
          `INSERT INTO belief_revisions
             (id, belief_id, previous_statement, previous_strength, previous_evidence, reason, trigger_fact_id, created_at)
           VALUES (?, ?, ?, ?, ?, 'manual_edit', NULL, ?)`,
          [
            makeId('rev', `${id}:${updatedAt}:${row.statement}`),
            id,
            row.statement,
            Number(row.strength),
            row.evidence_ids ?? '[]',
            updatedAt
          ]
        )
        await service.db.run(
          'UPDATE beliefs SET statement = ?, topic = ?, strength = ?, updated_at = ?, revision = revision + 1 WHERE id = ?',
          [content, topicFor(content), confidence, updatedAt, id]
        )
      })
      service.invalidate()
    }

    const after = await service.db.get('SELECT * FROM beliefs WHERE id = ?', [id])
    return { item: toBeliefItem(after) }
  }

  /**
   * Delete one belief — the only hard delete in this plugin.
   *
   * Reachable only from the 信念库 tab's delete dialog, which states that the
   * row cannot be recovered. What happens, exactly:
   *
   *   - the `beliefs` row is removed;
   *   - its `belief_revisions` go with it through the existing foreign key
   *     (`REFERENCES beliefs (id) ON DELETE CASCADE`), which is why the schema
   *     enables `PRAGMA foreign_keys = ON` on every open;
   *   - the `facts` rows that were cited as evidence are NOT touched. Evidence
   *     belongs to the people who said it, and retrieval still serves it.
   *
   * No background flow (ingest, reflection, export, this service's own list
   * path) calls this method; that is a deliberate invariant, not an oversight.
   *
   * @param {{id: string}} payload - the belief to delete.
   * @returns {Promise<{item: {id: string, content: string, deleted_revisions: number}}>}
   */
  async deleteBelief(payload) {
    const input = payload !== null && typeof payload === 'object' ? payload : {}
    const service = await this.service()
    const id = requireId(input.id)
    const row = await service.db.get('SELECT * FROM beliefs WHERE id = ?', [id])
    if (row === undefined) throw new Error('这条信念不存在，可能已被删除')

    const revisions = await service.db.get('SELECT COUNT(*) AS n FROM belief_revisions WHERE belief_id = ?', [id])
    const deletedRevisions = Number(revisions?.n ?? 0)

    await service.db.transaction(async () => {
      await service.db.run('DELETE FROM beliefs WHERE id = ?', [id])
    })
    service.invalidate()

    return {
      item: {
        id,
        content: row.statement,
        deleted_revisions: deletedRevisions
      }
    }
  }

  // --------------------------------------------------------- prompts 提示词

  /**
   * Every prompt block, plus the exact text that will be injected.
   *
   * The list is small by nature (a handful of blocks), so it is not paginated;
   * the 注入预览 needs the whole set anyway. `preview.text` is produced by the
   * same join the injection cache uses, and already contains the fallback, so
   * what the user reads here is what the model receives.
   *
   * @returns {Promise<object>} `{ kind: 'prompts', items, total, enabled, chars, maxBodyChars, preview }`.
   */
  async listPrompts(payload) {
    // `payload` is accepted and ignored: the Remote gateway derives the wire
    // arguments from the signature, and every method on this namespace is
    // declared as one-payload so the browser half can call them uniformly.
    void payload
    const service = await this.service()
    const rows = await service.db.all(
      'SELECT * FROM prompt_blocks ORDER BY position ASC, created_at ASC, id ASC',
      []
    )
    const items = rows.map(toPromptItem)
    const enabledRows = rows.filter((row) => Number(row.enabled) === 1)
    const joined = joinPromptBlocks(enabledRows)
    const fallback = joined === ''
    const text = fallback ? RULES : joined

    return {
      // The browser half checks this marker before rendering prompts, so a
      // stale Host (no prompt_blocks table) asks for a restart instead.
      kind: 'prompts',
      items,
      total: items.length,
      enabled: enabledRows.length,
      chars: enabledRows.reduce((sum, row) => sum + String(row.body ?? '').length, 0),
      maxBodyChars: MAX_BODY_CHARS,
      preview: {
        name: PROMPT_CONTEXT_NAME,
        order: PROMPT_CONTEXT_ORDER,
        // The memory guidance context is order 150 (see recall.js); repeated
        // here so the UI can say "before the memory guidance" without a second
        // round trip.
        memoryGuidanceOrder: 150,
        fallback,
        chars: text.length,
        text
      }
    }
  }

  /**
   * Next free ordering position for an appended block.
   *
   * @param {object} service - the open memory service.
   * @returns {Promise<number>} `max(position) + 10`, or 0 on an empty table.
   */
  async _nextPromptPosition(service) {
    const row = await service.db.get('SELECT COALESCE(MAX(position), -10) AS max FROM prompt_blocks', [])
    const max = Number(row?.max ?? 0)
    return Math.min(MAX_POSITION, Math.max(0, max + POSITION_STEP))
  }

  /**
   * Add one prompt block.
   *
   * @param {{title?: string, body?: string, position?: number, enabled?: boolean}} payload
   * @returns {Promise<{item: object}>} the stored block.
   */
  async createPrompt(payload) {
    const input = payload !== null && typeof payload === 'object' ? payload : {}
    const service = await this.service()
    const title = requireTitle(input.title)
    const body = requireBody(input.body)
    const enabled = requireEnabled(input.enabled, true)
    const position =
      input.position === undefined || input.position === null || input.position === ''
        ? await this._nextPromptPosition(service)
        : requirePosition(input.position)

    const at = isoNow()
    const id = makeId('prompt', `${normalizeText(title)}:${at}:${body.slice(0, 64)}`)
    await service.db.run(
      `INSERT INTO prompt_blocks (id, title, body, position, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, title, body, position, enabled ? 1 : 0, at, at]
    )
    this._promptsChanged()

    const row = await service.db.get('SELECT * FROM prompt_blocks WHERE id = ?', [id])
    return { item: toPromptItem(row) }
  }

  /**
   * Edit one prompt block. Absent fields keep their stored value.
   *
   * Only a real change bumps `updated_at` and refreshes the injection cache; a
   * no-op save returns the row as it was.
   *
   * @param {{id: string, title?: string, body?: string, position?: number,
   *   enabled?: boolean}} payload - edit.
   * @returns {Promise<{item: object}>} the updated block.
   */
  async updatePrompt(payload) {
    const input = payload !== null && typeof payload === 'object' ? payload : {}
    const service = await this.service()
    const id = requirePromptId(input.id)
    const row = await service.db.get('SELECT * FROM prompt_blocks WHERE id = ?', [id])
    if (row === undefined) throw new Error('这条提示词不存在，可能已被删除')

    const title = input.title === undefined ? row.title : requireTitle(input.title)
    const body = input.body === undefined ? row.body : requireBody(input.body)
    const position = input.position === undefined ? Number(row.position) : requirePosition(input.position)
    const enabled = requireEnabled(input.enabled, Number(row.enabled) === 1)

    const changed =
      title !== row.title ||
      body !== row.body ||
      position !== Number(row.position) ||
      enabled !== (Number(row.enabled) === 1)

    if (changed) {
      await service.db.run(
        'UPDATE prompt_blocks SET title = ?, body = ?, position = ?, enabled = ?, updated_at = ? WHERE id = ?',
        [title, body, position, enabled ? 1 : 0, isoNow(), id]
      )
      this._promptsChanged()
    }

    const after = await service.db.get('SELECT * FROM prompt_blocks WHERE id = ?', [id])
    return { item: toPromptItem(after) }
  }

  /**
   * Delete one prompt block.
   *
   * A real DELETE: a hint that was wrong should not linger as a hidden row that
   * still occupies a position. The injection falls back to {@link RULES} when
   * the last enabled block is gone, so the hard rules stay in the prompt even
   * if every block is removed.
   *
   * @param {{id: string}} payload - the block to delete.
   * @returns {Promise<{item: {id: string, title: string}}>} the removed block.
   */
  async deletePrompt(payload) {
    const input = payload !== null && typeof payload === 'object' ? payload : {}
    const service = await this.service()
    const id = requirePromptId(input.id)
    const row = await service.db.get('SELECT * FROM prompt_blocks WHERE id = ?', [id])
    if (row === undefined) throw new Error('这条提示词不存在，可能已被删除')

    await service.db.run('DELETE FROM prompt_blocks WHERE id = ?', [id])
    this._promptsChanged()
    return { item: { id, title: row.title } }
  }
}

markRemoteMethods(MemoryLibraryService.prototype, REMOTE_METHODS)
