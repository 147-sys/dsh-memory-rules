/*!
 * dsh-memory-rules — shared constants, path policy, and text utilities.
 *
 * Path policy (the plugin's central safety property): every read and write is
 * resolved against the memory root through {@link resolveInsideRoot}. A
 * candidate path that escapes the root — via `..`, an absolute path, or a
 * symlink-free traversal — is rejected instead of clamped. The `memory://`
 * scheme is a *virtual* namespace handled only by
 * {@link parseMemoryVirtualPath}; it is never turned into a filesystem path.
 */

import crypto from 'node:crypto'
import path from 'node:path'

/** Stable plugin name; also the `source.kind` of messages this plugin injects. */
export const PLUGIN_NAME = 'memory'

/** Tool names registered into the `tools` registry. */
export const TOOL_MEMORY_WRITE = 'memory_write'
export const TOOL_MEMORY_SEARCH = 'memory_search'
export const TOOL_MEMORY_RETRIEVE = 'memory_retrieve'
export const TOOL_MEMORY_ANSWER = 'memory_answer'
export const TOOL_MEMORY_REFLECT = 'memory_reflect'
export const TOOL_MEMORY_EXPORT = 'memory_export'
export const TOOL_MEMORY_RELATE = 'memory_relate'

/** The tool-name table, keyed by purpose so callers never repeat literals. */
export const TOOL_NAMES = {
  write: TOOL_MEMORY_WRITE,
  search: TOOL_MEMORY_SEARCH,
  retrieve: TOOL_MEMORY_RETRIEVE,
  answer: TOOL_MEMORY_ANSWER,
  reflect: TOOL_MEMORY_REFLECT,
  export: TOOL_MEMORY_EXPORT,
  relate: TOOL_MEMORY_RELATE
}

/** Every tool this plugin registers, in registration order. */
export const ALL_TOOL_NAMES = Object.values(TOOL_NAMES)

/** The four memory layers. World/experience live in `facts`; belief in
 * `beliefs` (its evidence stays in `facts`); answer in `answers`. */
export const LAYERS = ['world', 'experience', 'belief', 'answer']

/** Prompt-context entry name for the recalled-memory injection. */
export const MEMORY_CONTEXT_NAME = 'memory:recall'

/** Virtual-path scheme. Reserved: never a local filesystem path. */
export const MEMORY_SCHEME = 'memory://'

/** Memory file names are strictly `YYYY-MM-DD.md`. */
export const DAY_FILE_RE = /^(\d{4})-(\d{2})-(\d{2})\.md$/

/**
 * Entry heading inside a day file: `### HH:MM:SS — kind`.
 *
 * The dash class is written as `[-\u2013\u2014]`: putting `-` anywhere but the
 * end would build an accidental range (`—–-` would span U+2014..U+002D) and
 * silently stop matching every heading.
 */
export const ENTRY_HEADING_RE = /^###\s+(\d{2}):(\d{2}):(\d{2})\s+[-\u2013\u2014]\s*(\S+)/

export const DEFAULT_MAX_TOKENS = 1200

// ---------------------------------------------------------------------------
// Environment configuration
// ---------------------------------------------------------------------------

/**
 * Read a non-negative integer from the environment.
 * @param raw - raw environment value.
 * @param fallback - value used when absent, blank, or unparsable.
 * @returns The parsed integer, or `fallback`.
 */
export function readEnvInt(raw, fallback) {
  if (raw === undefined || raw === null) return fallback
  const text = String(raw).trim()
  if (text === '') return fallback
  const value = Number(text)
  if (!Number.isFinite(value) || value < 0) return fallback
  return Math.floor(value)
}

// ---------------------------------------------------------------------------
// Text utilities
// ---------------------------------------------------------------------------

/**
 * Collapse all whitespace runs into single spaces and trim.
 * @param text - arbitrary text.
 * @returns The normalised single-line form.
 */
export function squash(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Truncate to a character budget, marking that elision happened.
 * @param text - source text.
 * @param max - maximum characters to keep (<= 0 disables truncation).
 * @returns The possibly-elided text.
 */
export function clip(text, max) {
  const value = String(text ?? '')
  if (!Number.isFinite(max) || max <= 0 || value.length <= max) return value
  return `${value.slice(0, max)}…(+${value.length - max} chars)`
}

/**
 * Estimate tokens for mixed CJK/Latin text without bundling a tokenizer.
 * CJK codepoints count ~1 token each; other runs count ~1 token per 4 chars.
 * @param text - text to estimate.
 * @returns A non-negative token estimate.
 */
export function estimateTokens(text) {
  const value = String(text ?? '')
  if (value.length === 0) return 0
  let cjk = 0
  let other = 0
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    const isCjk =
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef)
    if (isCjk) cjk += 1
    else other += 1
  }
  if (other === 0) return cjk
  return cjk + Math.ceil(other / 4)
}

/** Local-time day key (`YYYY-MM-DD`). */
export function dayKey(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Render one memory file path for `YYYY-MM-DD`.
 * @param root - absolute memory root.
 * @param day - day key.
 * @returns The absolute file path (inside the root by construction).
 */
export function fileForDay(root, day) {
  return path.join(root, `${day}.md`)
}

// ---------------------------------------------------------------------------
// Path policy
// ---------------------------------------------------------------------------

/** True when `child` is `root` itself or lives underneath it. */
export function isInsideRoot(root, child) {
  const rel = path.relative(root, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Resolve a candidate path and require that it stays inside the memory root.
 * @param root - absolute memory root.
 * @param candidate - absolute or root-relative candidate.
 * @returns The resolved absolute path.
 * @throws TypeError when the candidate escapes the root.
 */
export function resolveInsideRoot(root, candidate) {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw new TypeError('memory path must be a non-empty string')
  }
  const resolved = path.resolve(root, candidate)
  if (!isInsideRoot(root, resolved)) {
    throw new TypeError(`memory path escapes the memory directory: ${candidate}`)
  }
  return resolved
}

/**
 * Parse a `memory://` virtual path.
 *
 * The scheme is a *namespace*, not a filesystem location: it names a memory
 * record (`memory://2026-10-13/3`) or a day (`memory://2026-10-13`). Callers
 * must never pass the result to a filesystem API directly; use
 * {@link fileForDay} to obtain a real path inside the root.
 *
 * @param value - candidate string.
 * @returns A parsed descriptor, or `undefined` when `value` is not virtual.
 * @throws TypeError when the scheme is used with a malformed body.
 */
export function parseMemoryVirtualPath(value) {
  if (typeof value !== 'string' || !value.startsWith(MEMORY_SCHEME)) return undefined
  const body = value.slice(MEMORY_SCHEME.length).replace(/\/+$/, '')
  if (body === '') return { kind: 'root', day: undefined, index: undefined, raw: value }
  const parts = body.split('/')
  if (parts.length > 2) throw new TypeError(`malformed memory virtual path: ${value}`)
  const day = parts[0]
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new TypeError(`memory virtual path must name a YYYY-MM-DD day: ${value}`)
  }
  if (parts.length === 1) return { kind: 'day', day, index: undefined, raw: value }
  if (!/^\d+$/.test(parts[1])) {
    throw new TypeError(`memory virtual path record index must be a positive integer: ${value}`)
  }
  return { kind: 'entry', day, index: Number(parts[1]), raw: value }
}

// ---------------------------------------------------------------------------
// Identity and structured-value helpers
// ---------------------------------------------------------------------------

/** Hex sha256 of a string, full length. */
export function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex')
}

/** Short, stable, prefixed identifier (`<prefix>_<10 hex>`). */
export function makeId(prefix, seed) {
  const digest = sha256(`${prefix}\u0000${seed}`).slice(0, 10)
  return `${prefix}_${digest}`
}

/** ISO-8601 timestamp with the local offset, second precision. */
export function isoNow(date = new Date()) {
  const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, '0')
  const off = -date.getTimezoneOffset()
  const sign = off < 0 ? '-' : '+'
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`
  )
}

/** Parse a JSON array column, tolerating a NULL, a scalar, or invalid JSON. */
export function parseJsonArray(value) {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string' || value.trim() === '') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** Clamp a number into `[min, max]`, falling back when it is not finite. */
export function clamp(value, min, max, fallback = min) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** Round to `digits` decimals, avoiding 0.30000000000000004-style noise. */
export function round(value, digits = 3) {
  const factor = 10 ** digits
  return Math.round(Number(value) * factor) / factor
}

// ---------------------------------------------------------------------------
// Text similarity primitives (shared by extraction, retrieval and reflection)
// ---------------------------------------------------------------------------

/** Normalise text for comparison: lowercase, strip punctuation and spacing. */
export function normalizeText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。！？；：、"'`'""''（）()\[\]{}<>《》【】,.;:!?'"~@#$%^&*+=|\\/_-]+/g, '')
}

/**
 * Character n-grams of the normalised text.
 *
 * CJK text has no word delimiters, so bigrams are the smallest unit that still
 * carries meaning; Latin runs are kept whole by {@link wordTokens}.
 * @param text - source text.
 * @param n - gram width (1 for unigrams).
 * @returns De-duplicated grams.
 */
export function charNgrams(text, n = 2) {
  const value = normalizeText(text)
  const grams = new Set()
  if (value.length === 0) return grams
  if (value.length < n) {
    grams.add(value)
    return grams
  }
  for (let i = 0; i + n <= value.length; i += 1) grams.add(value.slice(i, i + n))
  return grams
}

/** CJK ideographs (plus kana) as one token stream, Latin/digit words as another. */
export function wordTokens(text) {
  const runs = String(text ?? '')
    .toLowerCase()
    .match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|[a-z0-9_]{2,}/gu)
  return runs ?? []
}

/** Tokenise for keyword scoring: CJK bigrams plus Latin words. */
export function tokenize(text) {
  const terms = new Set()
  for (const run of wordTokens(text)) {
    if (/^[a-z0-9_]+$/.test(run)) {
      terms.add(run)
      continue
    }
    if (run.length === 1) {
      terms.add(run)
      continue
    }
    for (let i = 0; i + 2 <= run.length; i += 1) terms.add(run.slice(i, i + 2))
  }
  return [...terms]
}

/**
 * Overlap of two token sets, expressed as `|A ∩ B| / min(|A|, |B|)`.
 *
 * Dividing by the smaller set (rather than the union) is deliberate: it answers
 * "is the shorter text about the same thing as the longer one", which is the
 * question topic grouping and conflict detection actually ask.
 * @param a - first token set or array.
 * @param b - second token set or array.
 * @returns A score in `[0, 1]`.
 */
export function overlapScore(a, b) {
  const left = a instanceof Set ? a : new Set(a ?? [])
  const right = b instanceof Set ? b : new Set(b ?? [])
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  const [small, large] = left.size <= right.size ? [left, right] : [right, left]
  for (const term of small) if (large.has(term)) shared += 1
  return shared / small.size
}
