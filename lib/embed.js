/*!
 * dsh-memory-rules — the semantic retrieval path's vector representation.
 *
 * Requirement: retrieval must simultaneously run a *semantic* path alongside
 * keyword, graph and timeline. A real embedding model is not an option here:
 * the plugin runs inside the host process, must stay synchronous and offline,
 * and cannot assume a model route. So this module implements a deterministic
 * feature-hashing embedding instead — the standard "hashing trick" over
 * character n-grams and word tokens, with a sign derived from the feature hash
 * (the same construction as a random-projection / SimHash sketch).
 *
 * What that buys, honestly stated: two texts that share vocabulary and phrasing
 * land close together even when they share no exact query term, because
 * *related* n-grams collide in the same buckets. It is a distributional sketch,
 * not a learned embedding — no synonym or paraphrase knowledge. The keyword
 * path remains the precise one; this path is the fuzzy one. Both are reported
 * separately by `retrieve` so the difference is visible rather than assumed.
 */

import { charNgrams, normalizeText, tokenize, wordTokens } from './util.js'

/** Feature-hash width, in bits, before folding into the vector. */
const HASH_BITS = 32

/** FNV-1a, 32-bit. Fast, dependency-free, and stable across processes. */
export function fnv1a(text) {
  let hash = 0x811c9dc5
  const value = String(text)
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    // hash * 16777619, kept in 32-bit range without Math.imul overflow.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return hash >>> 0
}

/** Derive a ±1 sign from a feature hash (independent of the bucket index). */
function signOf(hash) {
  const flipped = fnv1a(`${hash}#sign`)
  return flipped % 2 === 0 ? 1 : -1
}

/**
 * Every feature of a text: character n-grams (2 and 3) plus word tokens.
 * Bigrams dominate, which is what makes the sketch work on CJK text.
 * @param text - source text.
 * @returns Unique feature strings with their weights.
 */
export function featuresOf(text) {
  const weights = new Map()
  const bump = (feature, weight) => weights.set(feature, (weights.get(feature) ?? 0) + weight)
  for (const gram of charNgrams(text, 2)) bump(`b:${gram}`, 1)
  for (const gram of charNgrams(text, 3)) bump(`t:${gram}`, 0.5)
  for (const token of tokenize(text)) if (/^[a-z0-9_]+$/.test(token)) bump(`w:${token}`, 1.5)
  for (const token of wordTokens(text)) if (/^[a-z0-9_]+$/.test(token)) bump(`W:${token}`, 1)
  return weights
}

/**
 * Embed one text as an L2-normalised, unit-length vector.
 * @param text - source text.
 * @param dims - vector width (default 256).
 * @returns A plain array of `dims` numbers.
 */
export function embed(text, dims = 256) {
  const width = Number(dims) > 0 ? Math.floor(Number(dims)) : 256
  const vector = new Array(width).fill(0)
  if (normalizeText(text).length === 0) return vector
  for (const [feature, weight] of featuresOf(text)) {
    const hash = fnv1a(feature)
    const index = hash % width
    vector[index] += signOf(hash) * weight
  }
  return l2Normalize(vector)
}

/** Scale a vector to unit length; a zero vector is returned unchanged. */
export function l2Normalize(vector) {
  let sum = 0
  for (const value of vector) sum += value * value
  if (sum === 0) return vector
  const norm = Math.sqrt(sum)
  return vector.map((value) => value / norm)
}

/**
 * Cosine similarity of two vectors.
 * @param a - first vector.
 * @param b - second vector.
 * @returns A score in `[-1, 1]`.
 */
export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0
  const length = Math.min(a.length, b.length)
  if (length === 0) return 0
  let dot = 0
  for (let i = 0; i < length; i += 1) dot += a[i] * b[i]
  return dot
}

/**
 * Map a cosine score onto `[0, 1]`.
 * @param value - cosine similarity.
 * @returns A non-negative similarity score.
 */
export function toSimilarity(value) {
  const score = (Number(value) + 1) / 2
  return score < 0 ? 0 : score > 1 ? 1 : score
}

/** Serialise a vector for the `facts.embedding` column (rounded, compact). */
export function serializeVector(vector) {
  return JSON.stringify(vector.map((value) => Math.round(value * 10000) / 10000))
}

/** Parse an `embedding` column back into a vector, tolerating garbage. */
export function parseVector(value) {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string' || value.trim() === '') return undefined
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined
    return parsed.map((n) => Number(n) || 0)
  } catch {
    return undefined
  }
}
