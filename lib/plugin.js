/*!
 * dsh-memory-rules v3.0.0 — host half.
 *
 * A DeepSeek Harness bundle plugin implementing a local memory service plus the
 * user's standing prompt blocks on top of SQLite. Five things happen here:
 *
 *  1. WRITE (写入) — on every `turn/end` the turn's derived messages are
 *     extracted into structured facts and stored. Extraction is buffered per
 *     session and flushed when the agent goes idle, so a long turn pays for one
 *     write rather than one per step.
 *  2. RETRIEVE (检索) — on `agent/pre-step`, once per turn, the four-path
 *     retrieval (semantic / keyword / graph / timeline) is merged and injected
 *     as a model-visible user message. A standing answer short-circuits it.
 *  3. REFLECT (反思) — a background timer consolidates same-topic facts into
 *     beliefs every 7 days (days 1,8,15,22,29 at 03:00), catching up on a missed run at startup.
 *  4. PROMPT BLOCKS (提示词) — the `prompt_blocks` rows are injected as the
 *     `memory-rules` system-prompt context at order 120. That is where the
 *     user's hard collaboration rules now live (the retired `dsh-user-rules`
 *     bundle used the `user-rules` context name, which must stay free so the
 *     two plugins never collide during a transition).
 *  5. TOOLS — `memory_write`, `memory_retrieve`, `memory_answer`,
 *     `memory_reflect`, `memory_relate`, `memory_export`, `memory_search`.
 *
 * Configuration precedence, highest first:
 *   plugin config (cordis.patch.yml)  →  environment variable  →  default
 *
 * Everything the plugin does is failure-contained: a memory fault must never
 * break a turn, and every entry point catches and logs instead of throwing.
 */

import path from 'node:path'

import { resolveConfig } from './config.js'
import {
  joinPromptBlocks,
  MemoryLibraryService,
  PROMPT_CONTEXT_NAME,
  PROMPT_CONTEXT_ORDER
} from './library.js'
import { buildRecallBlock, MEMORY_GUIDANCE } from './recall.js'
import { RULES } from './rules.js'
import { MemoryIndex, search as keywordSearch } from './search.js'
import { openMemoryService } from './service.js'
import {
  createMemoryAnswerTool,
  createMemoryExportTool,
  createMemoryReflectTool,
  createMemoryRelateTool,
  createMemoryRetrieveTool,
  createMemorySearchTool,
  createMemoryWriteTool
} from './tools.js'
import { MEMORY_CONTEXT_NAME, PLUGIN_NAME, isoNow, sha256, squash } from './util.js'

export { MEMORY_GUIDANCE, buildRecallBlock } from './recall.js'
export { resolveConfig, resolveDbFile, resolveMemoryDir, resolvePaths } from './config.js'
export {
  joinPromptBlocks,
  MemoryLibraryService,
  PROMPT_CONTEXT_NAME,
  PROMPT_CONTEXT_ORDER
} from './library.js'
export { RULES } from './rules.js'
export { openMemoryService } from './service.js'

export const name = PLUGIN_NAME

/** Services this plugin reads. */
export const inject = ['tools', 'systemPrompt']

/** The source kind that carries the person's own words, as opposed to an injected block. */
const USER_SOURCE_KIND = 'user'
/** The source kind of the assistant's own words. */
const ASSISTANT_SOURCE_KIND = 'assistant'

/** The declared source kind of a message, when it has one. */
function sourceKindOf(message) {
  const source = message && message.source
  return source && typeof source === 'object' ? source.kind : undefined
}

/** The text of one message, or `''` when it carries none. */
function messageText(message) {
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (part && part.type === 'text' && typeof part.text === 'string') parts.push(part.text)
  }
  return parts.join('\n')
}

/**
 * Messages whose text is somebody's own words, with a legacy fallback.
 *
 * The harness delivers the runtime snapshot, the skill catalog, the time block
 * and this plugin's own recall block as `role: 'user'` messages too. They are
 * distinguishable only by `source.kind`, and the distinction has to be made in
 * *one* place: `collectUserText` (what the query is built from) and `toTurns`
 * (what becomes a memory) must agree, or the plugin ends up remembering the
 * scaffolding it just injected — which is exactly what 231 stored facts were.
 *
 * Preference order: declared speakers first; if no message declares itself,
 * undeclared messages are used (an older client that does not set `source`); an
 * empty list means the caller falls back to its own rule.
 *
 * @param messages - derived messages for one step or turn.
 * @returns The messages worth reading, in their original order.
 */
export function selectSpokenMessages(messages) {
  const declared = []
  const undeclared = []
  for (const message of messages ?? []) {
    if (!message) continue
    const kind = sourceKindOf(message)
    if (kind === USER_SOURCE_KIND || kind === ASSISTANT_SOURCE_KIND) declared.push(message)
    else if (kind === undefined) undeclared.push(message)
  }
  return declared.length > 0 ? declared : undeclared
}

/**
 * Concatenate the user text already present in one step's message list.
 *
 * Retrieval is only as good as this query, so it must be the person's words and
 * nothing else: a plain role filter once handed the ranker the tail of an
 * injected block, which is how a request to summarise documents retrieved
 * unrelated troubleshooting facts and missed the standing rules entirely.
 *
 * Only the tail is kept, because a turn's earlier steps already carry their own
 * history.
 *
 * @param messages - the step's message list.
 * @returns The query text (possibly `''`).
 */
export function collectUserText(messages) {
  const textOf = (list) =>
    (list ?? [])
      .filter((message) => message && message.role === 'user')
      .map((message) => messageText(message))
      .filter((text) => text !== '')
  const declaredUser = (messages ?? []).filter(
    (message) => message && message.role === 'user' && sourceKindOf(message) === USER_SOURCE_KIND
  )
  const chosen = declaredUser.length > 0 ? declaredUser : selectSpokenMessages(messages)
  const text = textOf(chosen)
  if (text.length > 0) return text.join('\n').slice(-2000)
  // Last resort: an older client with no source at all on any message.
  return textOf(messages).join('\n').slice(-2000)
}

/** True when a derived message was injected by this plugin (never re-ingest it). */
export function isSelfInjected(message, sourceKind = PLUGIN_NAME) {
  const source = message && message.source
  return Boolean(source) && typeof source === 'object' && source.kind === sourceKind
}

/** Index of the turn's own words, for placing the recall block in front of them. */
export function lastSpokenUserIndex(messages) {
  let at = -1
  ;(messages ?? []).forEach((message, index) => {
    if (message && message.role === 'user' && sourceKindOf(message) === USER_SOURCE_KIND) at = index
  })
  return at
}

/**
 * Place the injected block relative to the turn's own words.
 *
 * `before-user` keeps the three-part shape the design asks for: the standing
 * rules are already in the system prompt, the memory sits in the middle, and
 * the actual question stays last. Appending instead (`after-user`, the
 * pre-3.2 behaviour) leaves a page of background text in the position where a
 * model looks for the newest instruction — the one place a recalled memory
 * must never appear.
 *
 * Any failure to locate the turn's words falls back to appending: injecting in
 * the wrong place is better than not injecting, because the block is tagged as
 * advisory either way.
 *
 * @param messages - the decision's message list.
 * @param injected - the recall message.
 * @param position - `'before-user'` or anything else for append.
 * @returns A new array; the input is never mutated.
 */
export function placeInjection(messages, injected, position) {
  if (!Array.isArray(messages)) return [injected]
  if (position !== 'before-user') return [...messages, injected]
  const at = lastSpokenUserIndex(messages)
  if (at < 0) return [...messages, injected]
  return [...messages.slice(0, at), injected, ...messages.slice(at)]
}

/** Extract `{ role, text }` turns from derived messages, skipping scaffolding. */
export function toTurns(messages, sourceKind = PLUGIN_NAME) {
  const turns = []
  for (const message of selectSpokenMessages(messages)) {
    if (!message || isSelfInjected(message, sourceKind)) continue
    const role = message.role
    if (role !== 'user' && role !== 'assistant') continue
    const content = message.content
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
              .map((part) => part.text)
              .join('\n')
          : ''
    if (squash(text) === '') continue
    turns.push({ role, text })
  }
  return turns
}

/**
 * The turn identity of a pre-step payload, used for the once-per-turn guard.
 * @param payload - the `agent/pre-step` payload.
 * @returns A stable per-turn key.
 */
export function turnKeyFor(payload) {
  const agent = payload && payload.agent
  const session = agent && agent.session
  const sessionId = session && typeof session.id === 'string' ? session.id : 'unknown'
  const turn = Number(payload && payload.turn)
  return `${sessionId}#${Number.isFinite(turn) ? turn : 'na'}`
}

/**
 * Cordis plugin entry.
 * @param ctx - plugin context.
 * @param config - bundle configuration.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const logger = ctx.logger ?? console
  if (!resolved.enabled) {
    logger.info?.('memory: disabled by configuration')
    return
  }

  // The service opens asynchronously (the `sql.js` fallback needs it), so the
  // hooks are installed immediately and await this promise before their first
  // read or write. Nothing here may throw during `apply`.
  const markdownIndex = new MemoryIndex(resolved.memoryDir)
  const ready = openMemoryService({
    memoryDir: resolved.memoryDir,
    dbFile: resolved.dbFile,
    engine: resolved.dbEngine,
    embedDims: resolved.embedDims,
    logger,
    markdownMirror: resolved.markdownMirror,
    reflect: resolved,
    index: markdownIndex
  })
  ready.catch((error) => {
    logger.error?.(`memory: service failed to open: ${String(error)}`)
  })

  const index = markdownIndex
  const injectedTurns = new Set()
  /** Per-session ingest bookkeeping: message hashes already offered. */
  const ingestSeen = new Map()
  /** Per-session pending derived history, flushed when the agent goes idle. */
  const pending = new Map()
  const disposers = []


  /** Run `fn` with the service, logging rather than throwing on any failure. */
  const withService = async (fn) => {
    try {
      return await fn(await ready)
    } catch (error) {
      logger.warn?.(`memory: ${String(error)}`)
      return undefined
    }
  }

  // ------------------------------------------------- prompt blocks 提示词
  // The 「提示词」 tab edits the blocks injected here. Two facts shape this:
  //
  //   * the harness may call a context's `text()` once per prompt assembly
  //     (PromptContext.text accepts a provider), so an edit can reach the very
  //     next request — but `text()` is synchronous and must not hit SQLite;
  //   * reading every request would also make the store a hot path.
  //
  // So the injected text is a cache: refreshed after open, and refreshed again
  // by the library service after every successful write. It is "all enabled
  // blocks, position ascending, joined by a blank line"; when that is empty
  // (everything disabled, or the table cleared) the provider falls back to the
  // built-in RULES, so emptying the table cannot drop the hard rules.
  let promptCache = ''
  /** Fingerprint of the last text handed to the prompt, for the heartbeat. */
  let promptHash = ''
  let promptBeatAt = 0

  const effectivePrompt = () => (promptCache !== '' ? promptCache : RULES)

  /**
   * Record what the recall path actually injected, at most once per change or
   * per minute.
   *
   * The prompt-rules heartbeat proves "the block I own was rendered"; this one
   * proves "the memory I retrieved reached the turn". They fail independently:
   * a stale prompt shows the same 275 characters forever, while a broken
   * retrieval shows nothing at all, and the two look identical from outside.
   */
  let recallHash = ''
  let recallBeatAt = 0
  const beatRecall = (payload) => {
    const now = Date.now()
    if (payload.hash === recallHash && now - recallBeatAt < 60000) return
    recallHash = payload.hash
    recallBeatAt = now
    void withService((service) => service.setMeta('heartbeat:recall', JSON.stringify(payload)))
  }

  /**
   * Record what the provider actually returned, at most once per change or per
   * minute. This is the only observable proof, from outside the host process,
   * that a saved edit reached the prompt on the next request rather than on the
   * next restart.
   */
  const beatPromptEval = (text) => {
    const hash = sha256(text).slice(0, 16)
    const now = Date.now()
    if (hash === promptHash && now - promptBeatAt < 60000) return
    promptHash = hash
    promptBeatAt = now
    void withService((service) =>
      service.setMeta(
        'heartbeat:prompt-rules',
        JSON.stringify({
          name: PROMPT_CONTEXT_NAME,
          order: PROMPT_CONTEXT_ORDER,
          chars: text.length,
          hash,
          fallback: promptCache === '',
          at: isoNow()
        })
      )
    )
  }

  /** Re-read the enabled blocks into {@link promptCache}. Never throws. */
  const refreshPrompts = async () => {
    const service = await ready
    const rows = await service.db.all(
      'SELECT body FROM prompt_blocks WHERE enabled = 1 ORDER BY position ASC, created_at ASC, id ASC',
      []
    )
    promptCache = joinPromptBlocks(rows)
  }

  refreshPrompts().catch((error) => {
    logger.warn?.(`memory: prompt cache warm-up failed (non-fatal): ${String(error)}`)
  })

  // ------------------------------------------------------ memory library UI
  // The Web UI's 「记忆与规则」 page reaches this service through the Typert
  // Remote SRC channel (`memoryLibrary`). It shares the same `ready` promise as
  // the hooks below, so the page never opens a second writer to the database.
  const library = new MemoryLibraryService({
    ready,
    logger,
    // A save must not fail because a cache refresh did: the hook is
    // fire-and-forget, and the worst case is one more request served from the
    // previous (still valid) text.
    onPromptsChanged: () => refreshPrompts()
  })
  library.typertRemote = Object.freeze({
    service: library,
    serviceKey: 'memoryLibrary',
    namespace: 'memoryLibrary'
  })
  ctx.provide('memoryLibrary', library)

  // ---------------------------------------------------------------- tools
  // The registry is synchronous, so tools receive a promise-backed facade: the
  // methods resolve the service on first use instead of at registration time.
  //
  // Every facade method is wrapped so a rejection becomes a plain result the
  // tool can report. Without this a failure surfaces as the host's generic
  // "value is not lossless JSON" or "tool body rejected", which says nothing
  // about which call failed or why.
  const method = (name) => async (...args) => {
    try {
      const service = await ready
      return await service[name](...args)
    } catch (error) {
      logger.warn?.(`memory: ${name} failed: ${String(error)}`)
      return { error: `memory ${name} failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
  const serviceProxy = {
    ingestFact: method('ingestFact'),
    ingestTurn: method('ingestTurn'),
    retrieve: method('retrieve'),
    saveAnswer: method('saveAnswer'),
    runReflection: method('runReflection'),
    addRelation: method('addRelation'),
    exportMarkdown: method('exportMarkdown')
  }

  const registrations = [
    createMemoryWriteTool({ service: serviceProxy, config: resolved }),
    createMemoryRetrieveTool({ service: serviceProxy, config: resolved }),
    createMemoryAnswerTool({ service: serviceProxy, config: resolved }),
    createMemoryReflectTool({ service: serviceProxy, config: resolved }),
    createMemoryRelateTool({ service: serviceProxy, config: resolved }),
    createMemoryExportTool({ service: serviceProxy, config: resolved }),
    createMemorySearchTool({ index, config: resolved, search: keywordSearch })
  ]
  for (const tool of registrations) {
    try {
      disposers.push(ctx.tools.register(tool))
    } catch (error) {
      logger.warn?.(`memory: could not register ${tool.name}: ${String(error)}`)
    }
  }

  // -------------------------------------------------------- system prompt
  // Two contexts, and the order is the point: the hard rules (120) read as the
  // frame, the memory guidance (150) as an appendage. The rules' name is
  // `memory-rules`, NOT `user-rules` — the retired dsh-user-rules bundle owns
  // that name, and during a transition both plugins are loaded at once.
  disposers.push(
    ctx.systemPrompt.context({
      name: PROMPT_CONTEXT_NAME,
      order: PROMPT_CONTEXT_ORDER,
      text: () => {
        const text = effectivePrompt()
        beatPromptEval(text)
        return text
      }
    })
  )
  disposers.push(
    ctx.systemPrompt.context({
      name: MEMORY_CONTEXT_NAME,
      order: resolved.contextOrder,
      text: () =>
        resolved.recallEnabled
          ? MEMORY_GUIDANCE
          : 'Long-term memory is configured but recall injection is disabled. ' + MEMORY_GUIDANCE
    })
  )

  // ------------------------------------------------------------- ingest
  /** Queue derived messages for one session; the flush does the extraction. */
  const enqueue = (sessionId, messages) => {
    if (!resolved.ingestEnabled || !Array.isArray(messages) || messages.length === 0) return
    const current = pending.get(sessionId)
    if (current === undefined) pending.set(sessionId, messages.slice())
    else current.push(...messages)
    if (pending.size > 64) {
      // Bounded: an unbounded map here would hold whole conversations forever.
      const oldest = pending.keys().next().value
      if (oldest !== sessionId) pending.delete(oldest)
    }
  }

  /** Extract and store everything queued for one session. */
  const flush = async (sessionId, reason) => {
    const messages = pending.get(sessionId)
    pending.delete(sessionId)
    if (!Array.isArray(messages) || messages.length === 0) return
    // Drop this plugin's own injected recall block *before* the service sees it.
    // The service can only filter by role, and an injection is a `user` message,
    // so without this the recall block is re-extracted as facts about memory —
    // a self-feeding loop in which the store grows from its own output.
    const turns = toTurns(messages)
    if (turns.length === 0) return
    const seen = ingestSeen.get(sessionId) ?? new Set()
    ingestSeen.set(sessionId, seen)
    await withService(async (service) => {
      const result = await service.ingestMessages(turns, {
        sessionId,
        seen,
        userChars: resolved.captureUserChars,
        assistantChars: resolved.captureAssistantChars,
        maxFactsPerTurn: resolved.ingestMaxFactsPerTurn,
        minConfidence: resolved.ingestMinConfidence,
        maxFactChars: resolved.ingestMaxFactChars,
        includeAssistant: resolved.ingestAssistant
      })
      if (result.facts.length > 0 || result.duplicates > 0) {
        logger.info?.(
          `memory: ${reason} ingest ${sessionId} — ${result.turns} new message(s), ` +
            `${result.skipped} assembled block(s) skipped, ${result.facts.length} fact(s) stored, ` +
            `${result.duplicates} duplicate(s), ${result.relations} relation(s)`
        )
      }
    })
  }

  /** Flush every session with pending work. */
  const flushAll = async (reason) => {
    for (const sessionId of [...pending.keys()]) await flush(sessionId, reason)
  }

  // On turn end: derive the messages and queue them. Deriving on demand means
  // the hook never depends on a step's local batch, and the per-session hash
  // set makes a repeated derivation a no-op.
  //
  // The `meta` heartbeats below are not decoration: when ingestion is silent
  // there are three indistinguishable explanations (the event never arrived,
  // the queue never flushed, or extraction stored nothing), and each has a
  // different remedy. Recording where the pipeline reached makes the difference
  // observable from outside the host process.
  const beat = (key) => {
    void withService((service) => service.setMeta(`heartbeat:${key}`, isoNow()))
  }
  disposers.push(
    ctx.on(
      'session/event',
      (session, event) => {
        try {
          if (!event || event.type !== 'turn/end') return
          if (!session || typeof session.id !== 'string') return
          beat('turn-end')
          const messages = typeof session.deriveMessages === 'function' ? session.deriveMessages() : []
          if (!Array.isArray(messages) || messages.length === 0) beat('turn-end-empty-history')
          enqueue(session.id, messages)
        } catch (error) {
          logger.debug?.(`memory: turn/end capture failed (non-fatal): ${String(error)}`)
        }
      },
      { global: true }
    )
  )

  // On idle: write what the turn produced. Idle is the earliest safe point —
  // the model is not waiting on us and the session has settled.
  disposers.push(
    ctx.on(
      'agent/status',
      (payload) => {
        void (async () => {
          try {
            const agent = payload && (payload.agent ?? payload.subject)
            const session = agent && agent.session
            const status = payload && (payload.status ?? payload.phase)
            if (status !== 'idle' || !session || typeof session.id !== 'string') return
            beat('idle')
            await flush(session.id, 'idle')
          } catch (error) {
            logger.debug?.(`memory: idle flush failed (non-fatal): ${String(error)}`)
          }
        })()
      },
      { global: true }
    )
  )

  // A session that ends while a flush is still owed must not lose its turn.
  disposers.push(
    ctx.on(
      'session/disposed',
      (session) => {
        const sessionId = session && typeof session.id === 'string' ? session.id : undefined
        void (async () => {
          try {
            if (sessionId === undefined) return
            const messages = typeof session.deriveMessages === 'function' ? session.deriveMessages() : []
            enqueue(sessionId, messages)
            await flush(sessionId, 'disposed')
            ingestSeen.delete(sessionId)
          } catch (error) {
            logger.debug?.(`memory: dispose flush failed (non-fatal): ${String(error)}`)
          }
        })()
      },
      { global: true }
    )
  )

  // ------------------------------------------------------------- retrieve
  disposers.push(
    ctx.on(
      'agent/pre-step',
      async (payload, next) => {
        const decision = await next()
        try {
          if (!decision || decision.kind === 'reject') return decision
          if (!resolved.recallEnabled || !Array.isArray(decision.messages)) return decision
          // Inject once per turn, at its first step, before any tool callback:
          // repeating the block on later steps only burns tokens.
          if (Number(payload && payload.step) !== 1) return decision
          const key = turnKeyFor(payload)
          if (injectedTurns.has(key)) return decision
          injectedTurns.add(key)
          if (injectedTurns.size > 500) injectedTurns.clear()

          const query = collectUserText(decision.messages)
          const today = isoNow(new Date()).slice(0, 10)
          const recall = await withService(async (service) => {
            const result = await service.retrieve(query, {
              limit: Math.max(resolved.recallEntries, 4),
              pathSemantic: resolved.pathSemantic,
              pathKeyword: resolved.pathKeyword,
              pathGraph: resolved.pathGraph,
              pathTimeline: resolved.pathTimeline,
              pathLimit: resolved.pathLimit,
              embedDims: resolved.embedDims,
              rankConfidenceWeight: resolved.rankConfidenceWeight,
              rankRecencyWeight: resolved.rankRecencyWeight,
              rankNormalize: resolved.rankNormalize,
              rankRecencyHalfLifeDays: resolved.rankRecencyHalfLifeDays,
              answerShortcut: resolved.answerShortcut
            })
            const pinned = await service.pinnedBeliefs(
              resolved.recallBeliefSlot,
              resolved.recallBeliefGlobalMax
            )
            return { result, pinned }
          })
          if (recall === undefined) return decision

          // Memory is the only source: the knowledge layer was cut out of this
          // package on 2026-11-01, so there is no second ranking to fuse — just
          // the top N entries.
          const selected = recall.result.results.slice(0, resolved.recallEntries)
          const pinnedEntries = recall.pinned.map((belief) => ({
            id: belief.id,
            content: belief.statement,
            layer: 'belief',
            confidence: belief.strength,
            createdAt: belief.createdAt,
            foundBy: [],
            pinned: true
          }))
          const block = buildRecallBlock(
            { ...recall.result, results: selected },
            {
              maxEntries: resolved.recallEntries,
              entryChars: resolved.recallEntryChars,
              maxTokens: resolved.maxTokens,
              today,
              now: isoNow(new Date()),
              pinned: pinnedEntries
            }
          )
          if (!block) return decision

          const injected = {
            role: 'user',
            content: [{ type: 'text', text: block }],
            // `form: 'snapshot'` is a host convention (grouping in the
            // transcript) and is left alone on purpose. What marks this message
            // as ours is `kind`, which is what `isSelfInjected` checks — the
            // anti-self-feed guard never depended on `form`.
            source: {
              kind: PLUGIN_NAME,
              form: 'snapshot',
              recall: 'memory',
              entries: selected.length + pinnedEntries.length,
              chars: block.length
            }
          }
          const messages = placeInjection(decision.messages, injected, resolved.recallPosition)
          beatRecall({
            entries: selected.length,
            pinned: pinnedEntries.length,
            chars: block.length,
            hash: sha256(block).slice(0, 16),
            position: resolved.recallPosition,
            at: isoNow()
          })
          return { ...decision, messages }
        } catch (error) {
          logger.warn?.(`memory: recall injection failed (non-fatal): ${String(error)}`)
          return decision
        }
      },
      { prepend: true }
    )
  )

  // -------------------------------------------------------------- reflect
  let scheduler
  if (resolved.reflectEnabled) {
    ready
      .then((service) => {
        scheduler = service.createScheduler({
          startupDelayMs: resolved.reflectStartupDelayMinutes * 60000,
          logger
        })
        scheduler.start()
        logger.info?.(
          `memory: reflection scheduled every 7 days on day(s) ${(resolved.reflectDays ?? [1, 8, 15, 22, 29]).join(', ')} at ${resolved.reflectAt}`
        )
      })
      .catch((error) => logger.warn?.(`memory: reflection scheduler unavailable: ${String(error)}`))
  }

  // --------------------------------------------------------------- teardown
  ctx.effect(
    () => () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch (error) {
          logger.debug?.(`memory: disposer failed (non-fatal): ${String(error)}`)
        }
      }
      try {
        scheduler?.stop()
      } catch (error) {
        logger.debug?.(`memory: scheduler stop failed (non-fatal): ${String(error)}`)
      }
      const outstanding = [...pending.keys()]
      injectedTurns.clear()
      ingestSeen.clear()
      // Flush what is still owed, then close the database.
      void (async () => {
        for (const sessionId of outstanding) {
          try {
            await flush(sessionId, 'shutdown')
          } catch {
            /* best effort at teardown */
          }
        }
        pending.clear()
        try {
          const service = await ready
          await service.close()
        } catch {
          /* the service may never have opened */
        }
      })()
    },
    'memory: dispose registrations'
  )

  logger.info?.(
    `memory: root=${resolved.memoryDir} db=${path.basename(resolved.dbFile)} engine=${resolved.dbEngine} ` +
      `recall=${resolved.recallEnabled} ingest=${resolved.ingestEnabled} reflect=${resolved.reflectEnabled}`
  )
}
