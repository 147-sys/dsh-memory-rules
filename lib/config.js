/*!
 * dsh-memory-rules — configuration resolution and path policy.
 *
 * Precedence, highest first:
 *   plugin config (cordis.patch.yml)  →  environment variable  →  built-in default
 *
 * The memory root holds both halves of the store:
 *
 *   ~/.dsh/memory/memory.db        SQLite database (facts/beliefs/answers/relations)
 *   ~/.dsh/memory/YYYY-MM-DD.md    Markdown export and the human-editable mirror
 *
 * The layout is unchanged from v1 (the Markdown files), so an existing install
 * keeps its history and only gains the database alongside it.
 */

import os from 'node:os'
import path from 'node:path'

import { DEFAULT_MAX_TOKENS, readEnvInt } from './util.js'

/** Default database file name inside the memory root. */
export const DEFAULT_DB_FILE = 'memory.db'

/** Parse a boolean environment switch. */
export function readEnvFlag(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback
  const text = String(raw).trim().toLowerCase()
  if (['0', 'false', 'no', 'off'].includes(text)) return false
  if (['1', 'true', 'yes', 'on'].includes(text)) return true
  return fallback
}

/** Expand a leading `~` to the user's home directory. */
export function expandHome(value) {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2))
  return value
}

/**
 * Resolve the memory root: config → DSH_MEMORY_DIR → $DSH_HOME/memory.
 * @param configDir - configured directory ('' means "not set here").
 * @returns The absolute memory root.
 */
export function resolveMemoryDir(configDir) {
  if (typeof configDir === 'string' && configDir.trim() !== '') {
    return path.resolve(expandHome(configDir.trim()))
  }
  const envDir = process.env.DSH_MEMORY_DIR
  if (typeof envDir === 'string' && envDir.trim() !== '') {
    return path.resolve(expandHome(envDir.trim()))
  }
  const dshHome = process.env.DSH_HOME
  const base =
    typeof dshHome === 'string' && dshHome.trim() !== ''
      ? dshHome.trim()
      : path.join(os.homedir(), '.dsh')
  return path.resolve(expandHome(base), 'memory')
}

/**
 * Resolve the database file: config → DSH_MEMORY_DB → `<memory root>/memory.db`.
 * A relative configured value is resolved inside the memory root, so the
 * database can never be pointed outside it by accident.
 * @param configFile - configured file ('' means "not set here").
 * @param memoryDir - resolved memory root.
 * @returns The absolute database path.
 */
export function resolveDbFile(configFile, memoryDir) {
  const candidate =
    typeof configFile === 'string' && configFile.trim() !== ''
      ? configFile.trim()
      : typeof process.env.DSH_MEMORY_DB === 'string' && process.env.DSH_MEMORY_DB.trim() !== ''
        ? process.env.DSH_MEMORY_DB.trim()
        : DEFAULT_DB_FILE
  const expanded = expandHome(candidate)
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(memoryDir, expanded)
}

/** Read an env value, or `undefined` when it is absent or blank. */
function envText(name) {
  const raw = process.env[name]
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined
}

/** Resolve the memory directory and database path without touching disk. */
export function resolvePaths(config) {
  const input = config && typeof config === 'object' ? config : {}
  const memoryDir = resolveMemoryDir(typeof input.memoryDir === 'string' ? input.memoryDir : '')
  const dbFile = resolveDbFile(typeof input.dbFile === 'string' ? input.dbFile : '', memoryDir)
  return { memoryDir, dbFile }
}

/**
 * Merge plugin config with environment overrides and defaults.
 * @param config - raw bundle configuration.
 * @returns The fully-resolved configuration object.
 */
export function resolveConfig(config) {
  const input = config && typeof config === 'object' ? config : {}
  const envTokens = readEnvInt(process.env.DSH_MEMORY_MAX_TOKENS, 0)
  const configTokens = Number(input.maxTokens)
  const maxTokens =
    Number.isFinite(configTokens) && configTokens > 0
      ? Math.floor(configTokens)
      : envTokens > 0
        ? envTokens
        : DEFAULT_MAX_TOKENS
  const pickInt = (key, fallback) => {
    const value = Number(input[key])
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
  }
  const pickNum = (key, fallback) => {
    const value = Number(input[key])
    return Number.isFinite(value) ? value : fallback
  }
  const pickBool = (key, envName, fallback) =>
    typeof input[key] === 'boolean' ? input[key] : readEnvFlag(envName === undefined ? undefined : process.env[envName], fallback)
  const pickText = (key, envName, fallback) => {
    if (typeof input[key] === 'string' && input[key].trim() !== '') return input[key].trim()
    return envText(envName) ?? fallback
  }

  const { memoryDir, dbFile } = resolvePaths(input)

  const enabled = pickBool('enabled', 'DSH_MEMORY_ENABLED', true)
  const engine = pickText('dbEngine', 'DSH_MEMORY_DB_ENGINE', 'auto')

  return {
    enabled,
    // ---------------------------------------------------------------- storage
    memoryDir,
    dbFile,
    dbEngine: ['auto', 'node:sqlite', 'sql.js'].includes(engine) ? engine : 'auto',
    // ------------------------------------------------------------------ tools
    /** Token budget for the injected recall block (hard bound). */
    maxTokens,
    searchMaxResults: pickInt('searchMaxResults', 20),
    contextOrder: pickInt('contextOrder', 150),
    // ------------------------------------------------------- ingest (写入)
    captureEnabled: pickBool('captureEnabled', 'DSH_MEMORY_CAPTURE', true),
    captureUserChars: pickInt('captureUserChars', 4000),
    captureAssistantChars: pickInt('captureAssistantChars', 2000),
    captureRecentTurns: pickInt('captureRecentTurns', 40),
    captureMaxChars: pickInt('captureMaxChars', 0),
    captureMinTurns: pickInt('captureMinTurns', 1),
    // Per-turn fact extraction (the "写入" action).
    ingestEnabled: pickBool('ingestEnabled', 'DSH_MEMORY_INGEST', true),
    /** Longest single fact, in characters. Longer candidates are trimmed. */
    ingestMaxFactChars: pickInt('ingestMaxFactChars', 240),
    /** Candidates below this extraction confidence are dropped. */
    ingestMinConfidence: pickNum('ingestMinConfidence', 0.35),
    /** Most facts stored per turn; keeps one chatty turn from flooding the DB. */
    ingestMaxFactsPerTurn: pickInt('ingestMaxFactsPerTurn', 8),
    /**
     * Extract the assistant's own text as well as the user's.
     *
     * Off by default, and that default is a deliberate correction. With it on,
     * every explanatory reply became "facts" — fragments such as "如果还失败，
     * 说明用户的修复另有问题：" (a lead-in whose body was the next paragraph)
     * were stored and then occupied the recall budget on every later turn. The
     * assistant's genuinely durable conclusions are already captured explicitly
     * by `memory_write`; the automatic path is for what a human said.
     */
    ingestAssistant: pickBool('ingestAssistant', 'DSH_MEMORY_INGEST_ASSISTANT', false),
    /** Mirror every ingested fact into the Markdown day file. */
    markdownMirror: pickBool('markdownMirror', 'DSH_MEMORY_MIRROR', true),
    // ---------------------------------------------------- retrieve (检索)
    recallEnabled: pickBool('recallEnabled', 'DSH_MEMORY_RECALL', true),
    recallEntries: pickInt('recallEntries', 6),
    recallEntryChars: pickInt('recallEntryChars', 700),
    recallMinScore: pickInt('recallMinScore', 1),
    /**
     * "Most recent memories are always surfaced" — without it a brand-new
     * session whose first prompt shares no term with older records recalls
     * nothing.
     */
    recallRecencyTail: pickBool('recallRecencyTail', undefined, true),
    /** Which of the four retrieval paths run. */
    pathSemantic: pickBool('pathSemantic', undefined, true),
    pathKeyword: pickBool('pathKeyword', undefined, true),
    pathGraph: pickBool('pathGraph', undefined, true),
    pathTimeline: pickBool('pathTimeline', undefined, true),
    /** Candidates pulled per path before merging. */
    pathLimit: pickInt('pathLimit', 24),
    /** Embedding width of the hash-ngram semantic path. */
    embedDims: pickInt('embedDims', 256),
    /**
     * `[0,1]` — how much raw confidence counts against path agreement.
     *
     * Lowered from 0.35 to 0.20 on 2026-11-01. Confidence is *query-independent*
     * and its live distribution is 58% at the 0.72 default, so a large weight
     * just hands every old high-confidence row a fixed head start: the new,
     * relevant fact cannot outrank the stale, confident one. It is kept as a
     * tiebreaker rather than a term.
     */
    rankConfidenceWeight: pickNum('rankConfidenceWeight', 0.2),
    /** `[0,1]` — weight of the recency prior. rrf + confidence + recency sums to 1. */
    rankRecencyWeight: pickNum('rankRecencyWeight', 0.15),
    /**
     * How the fused RRF is scaled before weighting: `observed` divides by the
     * best score this query actually produced (so "four paths agree" outscores
     * "one path hit"), `single` restores the old constant (1/61) for A/B runs.
     */
    rankNormalize: pickText('rankNormalize', 'DSH_MEMORY_RANK_NORMALIZE', 'observed'),
    /** Half-life in days of the recency prior applied at re-rank time. */
    rankRecencyHalfLifeDays: pickNum('rankRecencyHalfLifeDays', 45),
    /**
     * Where the injected block goes relative to the turn's own words.
     * `'before-user'` keeps the three-part shape (rules → memory → the actual
     * question), which is also the only position where a trailing memory cannot
     * read as the newest instruction. `'after-user'` is the pre-3.2 behaviour.
     */
    recallPosition: pickText('recallPosition', 'DSH_MEMORY_RECALL_POSITION', 'before-user'),
    /**
     * Slots reserved for beliefs, which similarity alone will not surface often
     * enough to hold a persona. 0 disables the reservation.
     */
    recallBeliefSlot: pickInt('recallBeliefSlot', 1),
    /** Upper bound on how many `priority='global'` beliefs may fill those slots. */
    recallBeliefGlobalMax: pickInt('recallBeliefGlobalMax', 2),
    // ----------------------------------------------------- reflect (反思)
    reflectEnabled: pickBool('reflectEnabled', 'DSH_MEMORY_REFLECT', true),
    /** Days of the month the consolidation runs — day-of-month step 7 = 1,8,15,22,29. */
    reflectDays: Array.isArray(input.reflectDays)
      ? input.reflectDays.map((d) => Number(d)).filter((d) => Number.isFinite(d) && d >= 1 && d <= 31)
      : [1, 8, 15, 22, 29],
    /** Local wall-clock time of the run, `HH:MM`. */
    reflectAt: pickText('reflectAt', undefined, '03:00'),
    /** Minutes to wait after startup before the first catch-up check. */
    reflectStartupDelayMinutes: pickInt('reflectStartupDelayMinutes', 2),
    /** Minimum facts sharing a topic before they may be consolidated. */
    reflectMinEvidence: pickInt('reflectMinEvidence', 3),
    /** `[0,1]` topic-token overlap that makes two facts "same topic". */
    reflectTopicThreshold: pickNum('reflectTopicThreshold', 0.34),
    /**
     * Quality gate for consolidation: only conclusion-like statements may
     * become evidence. Runtime scaffolding ("Time sampled while preparing…"),
     * questions and one-off task instructions are blocked; the facts stay in
     * the store and in retrieval.
     */
    reflectQualityGate: pickBool('reflectQualityGate', 'DSH_MEMORY_REFLECT_QUALITY', true),
    /** Shortest fact (characters) eligible as belief evidence. */
    reflectMinChars: pickInt('reflectMinChars', 12),
    /** Extra regular expressions (as strings) that disqualify a fact. */
    reflectSkipPatterns: Array.isArray(input.reflectSkipPatterns)
      ? input.reflectSkipPatterns.filter((value) => typeof value === 'string' && value.trim() !== '')
      : [],
    /** Days before a standing answer is considered stale and re-verified. */
    answerStaleDays: pickInt('answerStaleDays', 60),
    /** Standing answers are consulted before retrieval; disable to force retrieval. */
    answerShortcut: pickBool('answerShortcut', undefined, true)
  }
}
