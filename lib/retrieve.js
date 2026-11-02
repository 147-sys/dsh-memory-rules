/*!
 * dsh-memory-rules — retrieval ("检索").
 *
 * One query runs down four independent paths at the same time, and only then
 * are the results merged:
 *
 *   semantic  hash-ngram vector cosine over `facts.embedding` (fuzzy, topic-level)
 *   keyword   token match with tag/title boosts (precise, term-level)
 *   graph     relation edges seeded from the query, walked one hop further
 *   timeline  date filters and recency ("上周", "2026-10-14", "最近")
 *
 * Merging is Reciprocal Rank Fusion over the paths that produced each fact, so
 * a fact found by two paths outranks one found by a single path at the same
 * rank, plus a confidence term, a layer prior and a recency prior. Every path
 * reports its own candidate list (`paths`), so a caller — or the self-check —
 * can see that each path actually contributed rather than trusting the blend.
 *
 * Standing answers are consulted before any of this: a hit is returned as-is,
 * with no retrieval and no model call.
 */

import { cosine, embed, parseVector, toSimilarity } from './embed.js'
import { charNgrams, dayKey, normalizeText, overlapScore, round, squash, tokenize } from './util.js'

/** Weights of each path in the fused score. */
const PATH_WEIGHT = { semantic: 1, keyword: 1, graph: 0.9, timeline: 0.8 }

/** Prior by layer: a consolidated belief is worth more than a raw episode. */
const LAYER_PRIOR = { belief: 1.12, world: 1.04, experience: 1, answer: 1.08 }

/** Relative day words that name exactly one day. */
const RELATIVE_DAYS = {
  今天: 0,
  今日: 0,
  昨天: -1,
  昨日: -1,
  前天: -2,
  明天: 1,
  后天: 2
}

/**
 * Relative words that name a span, resolved against a real calendar.
 *
 * Weeks are ISO weeks (Monday..Sunday) and months/years are calendar months and
 * years, because "上周" meaning "the seven days before today" would be wrong on
 * every day except Sunday.
 */
const RELATIVE_RANGES = [
  {
    words: ['上周', '上星期'],
    range: (now) => weekRange(now, -1)
  },
  {
    words: ['本周', '这周', '这星期', '本星期'],
    range: (now) => weekRange(now, 0)
  },
  {
    words: ['下周', '下星期'],
    range: (now) => weekRange(now, 1)
  },
  {
    words: ['上个月', '上月'],
    range: (now) => monthRange(now, -1)
  },
  {
    words: ['本月', '这个月', '当月'],
    range: (now) => dayRange(now)
  },
  {
    words: ['去年'],
    range: (now) => ({ from: `${now.getFullYear() - 1}-01-01`, to: `${now.getFullYear() - 1}-12-31` })
  },
  {
    words: ['今年'],
    range: (now) => ({ from: `${now.getFullYear()}-01-01`, to: `${now.getFullYear()}-12-31` })
  },
  {
    // Fuzzy lookback: "最近" is the last two weeks, tied to today rather than
    // to a calendar boundary.
    words: ['最近', '近期'],
    range: (now) => ({ from: dayKey(new Date(now.getTime() - 14 * 86400000)), to: dayKey(now) })
  },
  {
    words: ['前几天'],
    range: (now) => ({ from: dayKey(new Date(now.getTime() - 3 * 86400000)), to: dayKey(now) })
  }
]

/**
 * Monday..Sunday of the week `offset` weeks from `now`'s week.
 * @param now - reference instant.
 * @param offset - 0 for this week, -1 for last week.
 */
export function weekRange(now, offset = 0) {
  const day = now.getDay() // 0 = Sunday
  const sinceMonday = day === 0 ? 6 : day - 1
  const monday = new Date(now.getTime() - sinceMonday * 86400000 + offset * 7 * 86400000)
  const sunday = new Date(monday.getTime() + 6 * 86400000)
  return { from: dayKey(monday), to: dayKey(sunday) }
}

/** The whole calendar month `offset` months from `now`. */
export function monthRange(now, offset = 0) {
  const year = now.getFullYear()
  const month = now.getMonth() + offset
  const first = new Date(year, month, 1)
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0)
  return { from: dayKey(first), to: dayKey(last) }
}

/** The single day `now` falls on, as a one-day range. */
export function dayRange(now) {
  const day = dayKey(now)
  return { from: day, to: day }
}

/**
 * Extract the date constraints a query states.
 *
 * Three shapes, kept separate because they mean different things: an exact day,
 * a month prefix, and a closed range (what a relative word like "上周" denotes).
 *
 * @param query - free-text query.
 * @param now - reference instant.
 * @returns `{ days, months, ranges, window }`.
 */
export function parseTimeFilter(query, now = new Date()) {
  const text = String(query ?? '')
  const days = new Set()
  const months = new Set()
  const ranges = []
  // 1. Absolute stamps, longest form first so "2026-10-14" is not also read as
  //    a month-only reference. "10月14日" (no year) means the current year.
  for (const m of text.matchAll(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?/g)) {
    days.add(`${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`)
  }
  for (const m of text.matchAll(/(?<!\d)(\d{1,2})月(\d{1,2})日/g)) {
    days.add(`${now.getFullYear()}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`)
  }
  for (const m of text.matchAll(/(\d{4})[-/年](\d{1,2})月?/g)) {
    const month = `${m[1]}-${String(m[2]).padStart(2, '0')}`
    // A full date also matches the month pattern; keep the month only when no
    // exact day in it was named, so `days` stays the precise constraint.
    if ([...days].some((day) => day.startsWith(`${month}-`))) continue
    months.add(month)
  }
  // 2. Relative spans, calendar-correct.
  for (const entry of RELATIVE_RANGES) {
    if (!entry.words.some((word) => text.includes(word))) continue
    ranges.push(entry.range(now))
  }
  // 3. Relative days.
  for (const [word, offset] of Object.entries(RELATIVE_DAYS)) {
    if (!text.includes(word)) continue
    days.add(dayKey(new Date(now.getTime() + offset * 86400000)))
  }
  return { days, months, ranges, window: days.size > 0 || months.size > 0 || ranges.length > 0 }
}

/**
 * Does a fact's timestamp satisfy a parsed time filter?
 * @param iso - the fact's `createdAt`.
 * @param filter - output of {@link parseTimeFilter}.
 */
export function matchesTimeFilter(iso, filter) {
  if (!filter || !filter.window) return false
  const day = String(iso ?? '').slice(0, 10)
  if (day === '') return false
  if (filter.days.has(day)) return true
  for (const month of filter.months) if (day.startsWith(`${month}-`)) return true
  for (const range of filter.ranges) if (day >= range.from && day <= range.to) return true
  return false
}

/** Path 1 — hash-ngram vector similarity over active facts. */
export function semanticPath(query, facts, options) {
  const dims = options.embedDims ?? 256
  const queryVector = embed(query, dims)
  const limit = options.pathLimit ?? 24
  /**
   * Similarity floor for a vector-only hit.
   *
   * Above zero because the hash-ngram sketch is a *topic* sketch: unrelated
   * short texts still collide into the 0.4–0.5 band purely by feature
   * collision, and this path runs on every turn, so that band would be
   * injected. The exact value is calibrated in `test/step4.test.js`
   * ("calibration"), which pins the measured band so a future embedding change
   * that widens it fails a test instead of silently injecting noise.
   */
  const minSimilarity = options.minSimilarity ?? 0.4
  const scored = []
  for (const fact of facts) {
    if (fact.supersededBy || fact.archivedAt) continue
    const vector = Array.isArray(fact.embedding) ? fact.embedding : parseVector(fact.embedding)
    if (!vector || vector.length === 0) continue
    const score = toSimilarity(cosine(queryVector, vector))
    if (score < minSimilarity) continue
    scored.push({ fact, score })
  }
  scored.sort((a, b) => b.score - a.score || String(b.fact.createdAt).localeCompare(String(a.fact.createdAt)))
  return scored.slice(0, limit)
}

/** Path 2 — keyword scoring, with tag and lead-phrase boosts. */
export function keywordPath(query, facts, options) {
  const terms = tokenize(query)
  if (terms.length === 0) return []
  const limit = options.pathLimit ?? 24
  const minScore = options.minKeywordScore ?? 1
  const scored = []
  for (const fact of facts) {
    if (fact.supersededBy || fact.archivedAt) continue
    const content = normalizeText(fact.content)
    const tags = (fact.tags ?? []).map((t) => String(t).toLowerCase())
    let score = 0
    const matched = []
    for (const term of terms) {
      let hit = 0
      if (tags.some((tag) => tag.includes(term))) hit += 3
      const occurrences = content.split(term).length - 1
      if (occurrences > 0) hit += Math.min(occurrences, 4)
      if (hit > 0) {
        score += hit
        matched.push(term)
      }
    }
    if (score < minScore) continue
    scored.push({ fact, score: score / Math.max(1, terms.length), matched })
  }
  scored.sort((a, b) => b.score - a.score || String(b.fact.createdAt).localeCompare(String(a.fact.createdAt)))
  return scored.slice(0, limit)
}

/**
 * Path 3 — the relation graph.
 *
 * Seeds are the edges whose subject, predicate or object appears in the query
 * or in a fact that the keyword path already matched. One more hop is walked
 * from the seeds' endpoints, which is what makes this path able to answer a
 * query that names neither endpoint directly.
 */
export function graphPath(query, facts, relations, options, seeds = []) {
  const limit = options.pathLimit ?? 24
  const queryNorms = new Set(tokenize(query))
  const seedIds = new Set(seeds.map((entry) => entry.fact.id))
  const nodes = new Set()
  const candidates = new Map()
  const addNode = (value) => {
    const name = squash(value).toLowerCase()
    if (name.length > 0) nodes.add(name)
  }
  // A query term seeds a node when it appears inside the edge's endpoints.
  for (const edge of relations) {
    const haystack = `${edge.subject} ${edge.predicate} ${edge.object}`.toLowerCase()
    for (const term of queryNorms) if (haystack.includes(term)) addNode(edge.subject)
  }
  // Facts that already matched by keyword seed their own relation endpoints.
  const seedTexts = facts.filter((fact) => seedIds.has(fact.id)).map((fact) => fact.content)
  for (const edge of relations) {
    for (const text of seedTexts) {
      if (text.includes(edge.subject) || text.includes(edge.object)) {
        addNode(edge.subject)
        addNode(edge.object)
      }
    }
  }
  if (nodes.size === 0) return []

  const direct = []
  const neighbours = new Set()
  for (const edge of relations) {
    const subject = edge.subject.toLowerCase()
    const object = edge.object.toLowerCase()
    const hitsFrom = nodes.has(subject) || nodes.has(object)
    const hitsTo = nodes.has(subject) && nodes.has(object)
    if (hitsFrom) {
      direct.push(edge)
      neighbours.add(subject)
      neighbours.add(object)
    }
    if (hitsTo) direct.push(edge)
  }
  const hop2 = relations.filter((edge) => {
    if (direct.includes(edge)) return false
    return neighbours.has(edge.subject.toLowerCase()) || neighbours.has(edge.object.toLowerCase())
  })

  const bump = (factId, score, via) => {
    if (factId === null || factId === undefined) return
    const current = candidates.get(factId) ?? { factId, score: 0, via: [] }
    current.score = Math.max(current.score, score)
    if (via !== undefined && !current.via.includes(via)) current.via.push(via)
    candidates.set(factId, current)
  }
  for (const edge of direct) {
    bump(
      edge.source_fact_id,
      1,
      `${edge.subject} —${edge.predicate}→ ${edge.object}`
    )
  }
  for (const edge of hop2) {
    bump(
      edge.source_fact_id,
      0.5,
      `${edge.subject} —${edge.predicate}→ ${edge.object}`
    )
  }
  const byId = new Map(facts.map((fact) => [fact.id, fact]))
  const scored = []
  for (const entry of candidates.values()) {
    const fact = byId.get(entry.factId)
    if (fact === undefined || fact.supersededBy || fact.archivedAt) continue
    scored.push({ fact, score: entry.score, via: entry.via })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

/**
 * Path 4 — the timeline.
 *
 * Two ways in: an explicit date filter (both directions — the query names a
 * day, or the fact is recent), and participant/time recall, which surfaces the
 * most recent facts at all so a brand-new conversation still gets context.
 */
export function timelinePath(query, facts, options, now = new Date()) {
  const limit = options.pathLimit ?? 24
  const filter = parseTimeFilter(query, now)
  const active = facts.filter((fact) => !fact.supersededBy && !fact.archivedAt)
  const scored = []
  if (filter.window) {
    const labels = [
      ...filter.days,
      ...[...filter.months].map((month) => `${month}-*`),
      ...filter.ranges.map((range) => `${range.from}..${range.to}`)
    ]
    for (const fact of active) {
      if (!matchesTimeFilter(fact.createdAt, filter)) continue
      const age = ageInDays(fact.createdAt, now)
      scored.push({ fact, score: round(1 / (1 + Math.max(0, age)), 4), matched: labels })
    }
  }
  if (!filter.window || scored.length === 0) {
    // Recency tail: the newest facts, scored by age so a fresh one always wins.
    const tail = [...active].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, limit)
    const present = new Set(scored.map((entry) => entry.fact.id))
    for (const fact of tail) {
      if (present.has(fact.id)) continue
      const age = ageInDays(fact.createdAt, now)
      scored.push({ fact, score: round(0.5 / (1 + Math.max(0, age) / 7), 4), matched: ['recency'] })
    }
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

/** Whole days between an ISO stamp and `now` (0 when unparsable or future). */
export function ageInDays(iso, now = new Date()) {
  const time = Date.parse(String(iso ?? ''))
  if (!Number.isFinite(time)) return 0
  return Math.max(0, (now.getTime() - time) / 86400000)
}

/**
 * Reciprocal-rank-fusion merge of the four paths, then re-rank.
 *
 * @param paths - `{ semantic, keyword, graph, timeline }` scored lists.
 * @param options - ranking options (`rankConfidenceWeight`, `rankRecencyHalfLifeDays`).
 * @param now - reference instant for the recency prior.
 * @returns Ranked candidates with their `found_by`, `score` and `confidence`.
 */
export function mergeAndRank(paths, options = {}, now = new Date()) {
  const confidenceWeight =
    Number.isFinite(Number(options.rankConfidenceWeight)) ? Number(options.rankConfidenceWeight) : 0.2
  const recencyWeight =
    Number.isFinite(Number(options.rankRecencyWeight)) ? Number(options.rankRecencyWeight) : 0.15
  const halfLife = Number(options.rankRecencyHalfLifeDays) > 0 ? Number(options.rankRecencyHalfLifeDays) : 45
  const merged = new Map()
  for (const [path, list] of Object.entries(paths ?? {})) {
    if (!Array.isArray(list)) continue
    const weight = PATH_WEIGHT[path] ?? 1
    list.forEach((entry, index) => {
      if (!entry || !entry.fact) return
      const id = entry.fact.id
      const current = merged.get(id) ?? {
        fact: entry.fact,
        rrf: 0,
        paths: {},
        bestPathScore: 0,
        matched: new Set()
      }
      current.rrf += weight / (60 + index + 1)
      current.paths[path] = Math.max(current.paths[path] ?? 0, Number(entry.score) || 0)
      current.bestPathScore = Math.max(current.bestPathScore, Number(entry.score) || 0)
      for (const term of entry.matched ?? []) current.matched.add(term)
      if (Array.isArray(entry.via)) for (const via of entry.via) current.matched.add(via)
      merged.set(id, current)
    })
  }
  // Normalise by the *observed* best, not by the theoretical single-path best.
  //
  // Dividing by `1 / 61` made every entry found at rank 0 by one path score a
  // flat 1.0, so "all four paths agree" and "one path only" were identical
  // before the confidence term — the agreement signal was thrown away exactly
  // when it carried the most information. The theoretical floor is kept as a
  // lower bound so a single weak candidate cannot become a 1.0 by default.
  const observedMax = Math.max(1 / 61, ...[...merged.values()].map((entry) => entry.rrf))
  // `single` restores the pre-3.2 normalisation so an A/B run can attribute a
  // ranking change to the weights rather than to both changes at once.
  const scale = options.rankNormalize === 'single' ? 1 / 61 : observedMax
  const ranked = []
  for (const entry of merged.values()) {
    const fact = entry.fact
    const rrfNorm = Math.min(1, entry.rrf / scale)
    const age = ageInDays(fact.createdAt, now)
    const recency = halfLife > 0 ? 0.5 ** (age / halfLife) : 1
    const confidence = Number(fact.confidence) || 0.5
    const prior = LAYER_PRIOR[fact.layer] ?? 1
    const agreement = Math.max(0, 1 - confidenceWeight - recencyWeight)
    const score = agreement * rrfNorm + confidenceWeight * confidence + recencyWeight * recency
    ranked.push({
      id: fact.id,
      fact,
      layer: fact.layer,
      content: fact.content,
      confidence,
      createdAt: fact.createdAt,
      tags: fact.tags ?? [],
      score: round(score * prior, 6),
      rrf: round(entry.rrf, 6),
      foundBy: Object.keys(entry.paths).sort(),
      pathScores: entry.paths,
      matched: [...entry.matched],
      ageDays: round(age, 2)
    })
  }
  ranked.sort((a, b) => b.score - a.score || String(b.createdAt).localeCompare(String(a.createdAt)))
  return ranked
}

/**
 * Look up a standing answer (`常设答案`).
 *
 * A hit is returned directly: no retrieval pass, no model call. Matching is
 * normalised-token overlap against every stored question phrasing, so wording
 * differences that do not change the question still hit.
 *
 * @param query - the user's question.
 * @param answers - decoded `answers` rows.
 * @param options - `{ threshold }`.
 * @returns `{ answer, score, matchedQuestion }` or `undefined`.
 */
export function findAnswer(query, answers, options = {}) {
  const threshold = Number.isFinite(Number(options.threshold)) ? Number(options.threshold) : 0.6
  const grams = charNgrams(query, 2)
  if (grams.size === 0) return undefined
  let best
  for (const answer of answers ?? []) {
    for (const phrasing of answer.questions ?? []) {
      const phrasingGrams = charNgrams(phrasing, 2)
      if (phrasingGrams.size === 0) continue
      // `overlapScore` is containment (shared / smaller set), which a short query
      // maxes out trivially: 「现在」is one bigram, so it scored 1.0 against
      // 「现在哪个区」 and fired that standing answer 78 times. Score with Dice
      // (shared / mean of both sizes) instead, so a query has to cover the
      // phrasing, not merely be covered by it.
      const shared = overlapScore(grams, phrasingGrams) * Math.min(grams.size, phrasingGrams.size)
      const score = (2 * shared) / (grams.size + phrasingGrams.size)
      if (score >= threshold && (best === undefined || score > best.score)) {
        best = { answer, score: round(score, 4), matchedQuestion: phrasing }
      }
    }
  }
  return best
}

/**
 * Run all four paths, attach belief rows, and return the fused ranking.
 *
 * @param query - free-text query.
 * @param snapshot - `{ facts, beliefs, relations, answers }`.
 * @param options - retrieval options.
 * @param now - reference instant (injectable for tests).
 * @returns `{ query, answer, results, paths, stats }`.
 */
export function retrieve(query, snapshot, options = {}, now = new Date()) {
  const text = squash(query)
  const beliefs = (snapshot.beliefs ?? []).filter((belief) => !belief.archivedAt)
  // A hand-written belief may have no evidence ids at all (the panel lets a
  // person state a conclusion directly, without citing facts). Such a belief
  // would otherwise be invisible to retrieval, because the normal path only
  // attaches a belief to the facts it cites. Synthesising one read-only
  // candidate per unanchored belief lets it compete on its own text while
  // leaving the facts table untouched; beliefs that do cite evidence keep the
  // existing "attach to the evidence fact" behaviour.
  const beliefFacts = beliefs
    .filter((belief) => (belief.evidenceIds ?? []).length === 0)
    .map((belief) => ({
      id: belief.id,
      content: belief.statement,
      layer: 'belief',
      confidence: belief.strength,
      tags: [],
      createdAt: belief.createdAt,
      updatedAt: belief.updatedAt,
      archivedAt: null,
      supersededBy: null,
      belief
    }))
  const facts = [...(snapshot.facts ?? []), ...beliefFacts]
  const relations = snapshot.relations ?? []
  const answers = snapshot.answers ?? []

  // Standing answers win outright: nothing else is even consulted.
  if (options.answerShortcut !== false && text !== '') {
    const hit = findAnswer(text, answers, options)
    if (hit !== undefined) {
      return {
        query: text,
        answer: {
          id: hit.answer.id,
          question: hit.matchedQuestion,
          text: hit.answer.answer,
          confidence: hit.answer.confidence,
          lastVerified: hit.answer.lastVerified,
          hits: hit.answer.hits,
          score: hit.score
        },
        results: [],
        paths: { semantic: [], keyword: [], graph: [], timeline: [] },
        stats: { scanned: facts.length, merged: 0, fromAnswer: true }
      }
    }
  }

  const semantic = options.pathSemantic === false ? [] : semanticPath(text, facts, options)
  const keyword = options.pathKeyword === false ? [] : keywordPath(text, facts, options)
  const graph = options.pathGraph === false ? [] : graphPath(text, facts, relations, options, keyword)
  const timeline = options.pathTimeline === false ? [] : timelinePath(text, facts, options, now)

  const paths = { semantic, keyword, graph, timeline }
  const ranked = mergeAndRank(paths, options, now)

  // The timeline path is a *fallback*, and the recency tail deliberately
  // ignores the query, so an entry the turn has nothing to do with must not
  // ride along. Three signals are available and they answer different questions:
  //
  //   `relevance`  vector cosine   — "same topic?" (broad, collides in 0.4–0.5)
  //   `coverage`   n-gram share    — "does the memory literally contain this?"
  //   `keyword`    exact token     — unambiguous, always accepted
  //
  // A paraphrase scores high on relevance and ~0 on coverage; a one-token query
  // scores high on coverage and can be near-random on relevance. So neither is
  // sufficient alone, and the rule is a disjunction of conjunctions rather than
  // one blended score: strong on either axis, or moderate on both.
  const floor = Number.isFinite(Number(options.relevanceFloor)) ? Number(options.relevanceFloor) : 0.5
  const strong = Number.isFinite(Number(options.strongSimilarity)) ? Number(options.strongSimilarity) : 0.6
  const queryVector = embed(text, options.embedDims ?? 256)
  const relevanceOf = (entry) => {
    const vector = entry.fact.embedding ?? embed(entry.fact.content, options.embedDims ?? 256)
    return toSimilarity(cosine(queryVector, vector))
  }
  const queryGrams = charNgrams(text, 2)
  const coverage = (entry) => {
    if (queryGrams.size === 0) return 0
    const entryGrams = charNgrams(entry.fact.content, 2)
    let shared = 0
    for (const gram of queryGrams) if (entryGrams.has(gram)) shared += 1
    return shared / queryGrams.size
  }
  const filtered =
    text === ''
      ? ranked
      : ranked.filter((entry) => {
          if (entry.pathScores.keyword !== undefined) return true
          const semantic = entry.pathScores.semantic
          if (semantic !== undefined && semantic >= strong) return true
          if (entry.pathScores.semantic !== undefined || entry.pathScores.keyword !== undefined) {
            // A weak vector-only hit still has to look like the same subject.
            return relevanceOf(entry) >= floor && coverage(entry) >= 0.3
          }
          // Graph- or timeline-only: no content-bearing path matched at all.
          return relevanceOf(entry) >= floor && coverage(entry) >= 0.3
        })

  const limit = Number(options.limit) > 0 ? Number(options.limit) : 0
  const results = limit > 0 ? filtered.slice(0, limit) : filtered

  // Belief rows are attached to the facts they cite, so one result can render
  // as the consolidated belief while still pointing at its raw evidence.
  const beliefByFact = new Map()
  const beliefById = new Map(beliefs.map((belief) => [belief.id, belief]))
  for (const belief of beliefs) {
    for (const factId of belief.evidenceIds ?? []) {
      if (!beliefByFact.has(factId)) beliefByFact.set(factId, belief)
    }
  }
  for (const result of results) {
    const belief = beliefByFact.get(result.id) ?? (result.layer === 'belief' ? beliefById.get(result.id) : undefined)
    if (belief !== undefined) result.belief = belief
  }

  return {
    query: text,
    answer: undefined,
    results,
    paths,
    stats: {
      scanned: facts.length,
      merged: ranked.length,
      fromAnswer: false,
      pathCounts: {
        semantic: semantic.length,
        keyword: keyword.length,
        graph: graph.length,
        timeline: timeline.length
      }
    }
  }
}
