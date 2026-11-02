/*!
 * dsh-memory-rules — reflection ("反思").
 *
 * Every seven days (the 1st, 8th, 15th, 22nd and 29th, local time — the
 * day-of-month meaning of a `0 3 1,8,15,22,29 * *` crontab) the background job
 * folds scattered facts about one topic into a single *belief*:
 *
 *   merge        several agreeing facts become one belief; `evidence_ids` keeps
 *                every one of them, and `strength` grows with the evidence
 *   reinforce    the same topic gains more evidence; only `strength` moves
 *   overwrite    new evidence contradicts the belief; the statement is replaced,
 *                the previous wording and evidence are appended to
 *                `belief_revisions`, and the replaced fact stays in `facts`
 *
 * Nothing is ever deleted, and the facts themselves are never rewritten: a fact
 * that has been folded into a belief only gains a `superseded_by` pointer, which
 * is what makes the belief auditable back to its raw evidence.
 *
 * The module is split in two on purpose: {@link reflect} is a pure planner over
 * a snapshot (fully testable without a database), and `MemoryService` applies
 * the plan inside one transaction.
 */

import { overlapScore, tokenize, charNgrams, makeId, normalizeText, round, clamp, squash } from './util.js'
import { extractRelation } from './extract.js'

/**
 * Days of the month the consolidation runs.
 *
 * This is the day-of-month expansion of a crontab day-of-month step of 7
 * (1, 8, 15, 22 and 29), not "a rolling seven-day interval".
 * The month boundary therefore gives a 3-day gap (29th -> 1st); if a strict
 * rolling cadence is ever required, it needs an anchored interval rather than a
 * day-of-month list.
 */
export const PERIOD_DAYS = [1, 8, 15, 22, 29]

/**
 * Facts that are runtime scaffolding, not observations.
 *
 * These sentences arrive as user-role context on almost every turn, so a
 * clustering pass that ignores them does not merely store noise: three
 * near-identical copies become a *belief* with high strength, and from then on
 * the recall block presents the boilerplate as a confident conclusion. Two such
 * beliefs reached 0.95 strength with 88 and 48 "evidence" pieces before this
 * gate existed.
 */
export const BOILERPLATE_PATTERNS = [
  /^time sampled while preparing/i,
  /^elapsed since the preceding/i,
  /^browser time zone for this request/i,
  /^current runtime context/i,
  /^this snapshot supersedes earlier runtime-context/i,
  /^recalled long-term memory/i,
  /a skill is a reusable set of task-specific instructions/i
]

/**
 * Opening words of a task instruction ("do X for me"), as opposed to a claim.
 *
 * Instructions describe what someone wanted done once; a belief is supposed to
 * be a conclusion that stays true. The list is deliberately short and
 * prefix-anchored, because a false negative is cheap (one bad belief) and a
 * false positive silently loses real evidence.
 */
export const TASK_PREFIXES = [
  '帮我',
  '请帮',
  '请把',
  '把',
  '先找出',
  '先帮',
  '重新写',
  '现在开始',
  '接下来',
  '给我',
  '下载',
  '生成一份',
  '写一份'
]

/** Default shortest content (characters) that can serve as evidence. */
export const MIN_CONSOLIDATION_CHARS = 12

/**
 * Task-instruction *shapes* that a prefix list cannot catch.
 *
 * The extractor rewrites a request in the third person ("帮用户检查…", "用户现在
 * 想把…"), so the instruction no longer starts with the verb the user typed.
 * Anchored patterns keep the rule from also blocking a genuine conclusion that
 * merely mentions a task.
 */
export const TASK_PATTERNS = [
  /^(还有|另外|然后|接着)?帮(用户|我|忙)/,
  /^用户(现在)?想/,
  /^已?完成(了)?/
]

/**
 * Directives: rules the user wants applied, not observations about the world.
 *
 * They have a canonical home — the 提示词 tab — and that home is injected into
 * the system prompt on every request. Letting them also become beliefs is what
 * produced a 1.00-strength "用户硬性协作流程…" belief that duplicated the block
 * word for word and then came straight back after deletion, because three
 * remaining rule facts re-clustered on the next pass.
 */
export const RULE_PATTERNS = [
  /^用户硬性/,
  /^以后(所有|每次|都|先|再|请|要|必须)/,
  /^(不要|别|务必|只做|只读[，,])/
]

/**
 * May this fact be used as belief evidence?
 *
 * A gate, not a filter on *retrieval*: a blocked fact stays readable and
 * searchable — it simply cannot vote in consolidation. The checks run on the
 * squashed content so leading whitespace or newlines cannot smuggle a
 * boilerplate sentence past them.
 *
 * @param fact - a fact row (`{ content, ... }`).
 * @param options - `{ qualityGate, minChars, taskPrefixes, skipPatterns }`.
 * @returns `true` when the fact may join a cluster and become evidence.
 */
export function isConsolidatable(fact, options = {}) {
  if (options.qualityGate === false) return true
  const content = squash(fact && fact.content)
  const minChars = Number(options.minChars) > 0 ? Number(options.minChars) : MIN_CONSOLIDATION_CHARS
  if (content.length < minChars) return false
  // A question is a request for an answer, not an answer.
  if (/[?？]\s*$/.test(content)) return false
  if (BOILERPLATE_PATTERNS.some((pattern) => pattern.test(content))) return false
  if (TASK_PATTERNS.some((pattern) => pattern.test(content))) return false
  if (RULE_PATTERNS.some((pattern) => pattern.test(content))) return false
  const extraPrefixes = Array.isArray(options.taskPrefixes) ? options.taskPrefixes : []
  if ([...TASK_PREFIXES, ...extraPrefixes].some((prefix) => content.startsWith(prefix))) return false
  const extraPatterns = Array.isArray(options.skipPatterns) ? options.skipPatterns : []
  if (extraPatterns.some((pattern) => pattern instanceof RegExp && pattern.test(content))) return false
  return true
}

/** Expressions that flip the meaning of a statement they appear in. */
const NEGATION_RE =
  /(不再|并不|并非|不是|没有|未能|无法|不再使用|不支持|不允许|不应该|不能|不会|未|无|非|not\b|never\b|no longer|isn't|aren't|doesn't|don't|won't|can't|cannot)/i

/** A statement that exists purely to replace an earlier belief. */
const REVERSAL_RE = /(改为|改成|换成|更新为|更正为|修正为|推翻|不再|不再是|不再使用|changed to|now uses|no longer)/i

/** Explicit antonym pairs: seeing both sides of a pair is a direct conflict. */
const ANTONYMS = [
  ['启用', '禁用'],
  ['开启', '关闭'],
  ['安装', '卸载'],
  ['新增', '删除'],
  ['升级', '降级'],
  ['支持', '不支持'],
  ['使用', '不使用'],
  ['使用', '放弃'],
  ['是', '不是'],
  ['有', '没有'],
  ['成功', '失败'],
  ['通过', '拒绝'],
  ['enable', 'disable'],
  ['install', 'uninstall'],
  ['add', 'remove'],
  ['use', 'avoid']
]

/**
 * Classify the relationship between two statements about one topic.
 *
 * The governing rule is that a *label* determines the outcome, so this returns
 * a severity rather than a boolean:
 *
 *   `none`   no contradiction detected — merge or reinforce
 *   `weak`   a negation appears somewhere but not on the differing part, or the
 *            two statements merely name different things (a cause and a
 *            consequence). Treated as disagreement: strength only.
 *   `strong` the difference *is* a negation or an antonym pair — the belief's
 *            conclusion is overwritten, with the previous wording archived.
 *
 * The mid-level check matters: "使用 SQLite" and "使用 PostgreSQL" score high on
 * overlap and name different things, so a naive "high overlap + any negation"
 * rule would archive a perfectly good belief. Requiring the negation to sit
 * near the point of divergence is what keeps this honest.
 *
 * @param a - the incumbent statement.
 * @param b - the candidate statement.
 * @param threshold - character-bigram overlap required before a conflict is claimed.
 * @returns `{ severity, type, detail }`.
 */
export function detectConflict(a, b, threshold = 0.22) {
  const none = { severity: 'none', type: 'none', detail: '' }
  const left = squash(a)
  const right = squash(b)
  if (left === '' || right === '' || left === right) return none
  const shared = overlapScore(charNgrams(left, 2), charNgrams(right, 2))
  if (shared < threshold) return none

  // 1. An explicit reversal is the strongest signal there is.
  const reversal = REVERSAL_RE.exec(right) ?? REVERSAL_RE.exec(left)
  if (reversal !== null) {
    if (objectScope(left, right) === 'narrowed') {
      return { severity: 'weak', type: 'reversal-narrowed', detail: reversal[0] }
    }
    return { severity: 'strong', type: 'reversal', detail: reversal[0] }
  }

  // 2. An antonym pair split across the two statements.
  for (const [one, other] of ANTONYMS) {
    const forward = left.includes(one) && right.includes(other) && !left.includes(other)
    const backward = left.includes(other) && right.includes(one) && !right.includes(other)
    if (forward || backward) {
      return { severity: 'strong', type: 'antonym', detail: `${one} / ${other}` }
    }
  }

  // 3. A negation that the incumbent does not have.
  const leftNegated = NEGATION_RE.test(left)
  const rightNegated = NEGATION_RE.test(right)
  if (leftNegated !== rightNegated) {
    const negated = leftNegated ? left : right
    const incumbent = leftNegated ? right : left
    const point = divergencePoint(left, right)
    const window = 12
    const near = negated.slice(Math.max(0, point - window), point + window)
    if (!NEGATION_RE.test(near)) return { severity: 'weak', type: 'negation-elsewhere', detail: squash(negated) }
    // The negation sits on the divergence — but if it names a *narrower* object
    // than the incumbent's, it refutes a part, not the claim.
    if (objectScope(incumbent, negated) === 'narrowed') {
      return { severity: 'weak', type: 'negation-narrowed', detail: squash(near) }
    }
    return { severity: 'strong', type: 'negation', detail: squash(near) }
  }
  return none
}

/**
 * Compare the object phrase of a negated candidate against the incumbent's.
 *
 * The distinction that matters: "no longer uses SQLite" contradicts a belief
 * that the store uses SQLite, but "no longer uses SQLite's *backup interface*"
 * only contradicts a claim about the backup interface — the object has been
 * narrowed to a part of the old one. Escalating on the second case would let one
 * sentence about a subsystem archive a belief about the whole system, and every
 * later turn would then be told the wrong thing.
 *
 * @param incumbent - the stored statement.
 * @param candidate - the negated candidate.
 * @returns `'same'` | `'narrowed'` | `'unknown'`.
 */
export function objectScope(incumbent, candidate) {
  const left = extractRelation(incumbent)
  const right = extractRelation(candidate)
  if (left === undefined || right === undefined) return 'unknown'
  if (left.predicate !== right.predicate) return 'unknown'
  const a = normalizeText(left.object)
  const b = normalizeText(right.object)
  if (a === '' || b === '') return 'unknown'
  if (a === b) return 'same'
  // The candidate's object contains the incumbent's and is strictly longer:
  // the claim has been narrowed to a sub-part.
  if (b.length > a.length && b.includes(a)) return 'narrowed'
  return 'same'
}

/** Convenience boolean over {@link detectConflict}: is this a real contradiction? */
export function detectsConflict(a, b, threshold) {
  return detectConflict(a, b, threshold).severity === 'strong'
}

/** Index of the first differing character of two strings. */
export function divergencePoint(a, b) {
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i += 1) if (a[i] !== b[i]) return i
  return length
}

/**
 * Topic tokens of a fact: content grams plus tags, minus the layer words that
 * every fact of a layer shares.
 *
 * Bigrams are used rather than single characters because single Chinese
 * characters are far too common to group on.
 */
export function topicTokens(fact) {
  const tokens = new Set(tokenize(fact.content))
  for (const tag of fact.tags ?? []) {
    if (!['world', 'experience', 'relation', 'preference', 'decision', 'issue', 'fix', 'config'].includes(tag)) {
      for (const token of tokenize(tag)) tokens.add(token)
    }
  }
  return tokens
}

/**
 * Group facts into same-topic clusters.
 *
 * Greedy and first-fit: a fact joins the first cluster whose running token set
 * it overlaps enough with, otherwise it starts a new one. Deterministic for a
 * given input order (facts arrive newest first), which is what the self-check
 * and the audit trail rely on.
 *
 * @param facts - candidate facts with `topicTokens` computed.
 * @param options - `{ threshold }`.
 * @returns Clusters, each `{ facts, tokens }`.
 */
export function clusterByTopic(facts, options = {}) {
  const threshold = Number.isFinite(Number(options.threshold)) ? Number(options.threshold) : 0.34
  const minEvidence = Number(options.minEvidence) > 0 ? Number(options.minEvidence) : 3
  const clusters = []
  for (const fact of facts) {
    let best
    let bestScore = 0
    for (const cluster of clusters) {
      const score = overlapScore(fact.topicTokens, cluster.tokens)
      if (score >= threshold && score > bestScore) {
        best = cluster
        bestScore = score
      }
    }
    if (best === undefined) clusters.push({ facts: [fact], tokens: new Set(fact.topicTokens) })
    else {
      best.facts.push(fact)
      for (const token of fact.topicTokens) best.tokens.add(token)
    }
  }
  return clusters.filter((cluster) => cluster.facts.length >= minEvidence)
}

/**
 * A short, human-readable topic label.
 *
 * A label is for a person scanning `beliefs.md`, so it must be *shared* by the
 * cluster. Two failure modes have to be avoided: ranking by raw frequency alone
 * lets the bigrams of a common phrase ("记忆", "据库") bury the distinctive term
 * ("sqlite"), while ranking purely by rarity surfaces bigrams that only one
 * member happens to contain ("并发", "备份") — which is the opposite of a topic.
 *
 * So tokens seen in fewer than half the members are dropped first (they are
 * incidental, not topical), and the survivors are ranked by coverage, then
 * length, then frequency. If nothing clears the bar, the most common tokens are
 * used rather than emitting an empty label.
 *
 * @param cluster - `{ facts, tokens }`.
 * @returns A label such as `记忆库·sqlite`.
 */
export function topicLabel(cluster) {
  const counts = new Map()
  for (const fact of cluster.facts) {
    for (const token of new Set(fact.topicTokens)) counts.set(token, (counts.get(token) ?? 0) + 1)
  }
  const total = Math.max(1, cluster.facts.length)
  const candidates = [...counts.entries()].filter(([token]) => token.length >= 2)
  const shared = candidates.filter(([, count]) => count / total >= 0.5)
  const pool = shared.length > 0 ? shared : candidates
  const ranked = pool
    .map(([token, count]) => ({ token, count, share: count / total }))
    .sort((a, b) => {
      if (b.share !== a.share) return b.share - a.share
      if (b.token.length !== a.token.length) return b.token.length - a.token.length
      if (b.count !== a.count) return b.count - a.count
      return a.token.localeCompare(b.token)
    })
    .slice(0, 3)
    .map((entry) => entry.token)
  return ranked.join('·') || '未命名主题'
}

/**
 * Pick the statement that best represents a cluster.
 *
 * Not simply the highest confidence: a longer statement carries more slots
 * (time, participant, result), so length is a weak additional signal. Ties go
 * to the newest fact, which keeps the belief current.
 *
 * @param facts - cluster members.
 * @returns The representative fact.
 */
export function representativeOf(facts) {
  const specificity = (fact) =>
    (Number(fact.confidence) || 0.5) * 2 + Math.min(1, String(fact.content).length / 80) * 0.5
  return [...facts].sort((a, b) => {
    const diff = specificity(b) - specificity(a)
    if (Math.abs(diff) > 1e-9) return diff
    return String(b.createdAt).localeCompare(String(a.createdAt))
  })[0]
}

/**
 * Strength from evidence count and agreement.
 *
 * Asymptotic on purpose: three facts already put a belief at ~0.62, ten at
 * ~0.93, and it never reaches certainty. Disagreement costs a fixed penalty
 * rather than resetting, because a conflicted belief is weak, not empty.
 *
 * @param evidenceCount - how many facts support the belief.
 * @param conflict - whether new evidence contradicted the belief.
 * @returns A value in `[0.05, 0.95]`.
 */
export function strengthFor(evidenceCount, conflict = false) {
  const count = Math.max(1, Number(evidenceCount) || 1)
  const base = 0.05 + 0.9 * (1 - Math.exp(-count / 3))
  return round(clamp(conflict ? base * 0.85 : base, 0.05, 0.95), 3)
}

/**
 * Plan the consolidation of one snapshot.
 *
 * @param snapshot - `{ facts, beliefs, answers }`.
 * @param options - `{ minEvidence, topicThreshold, newFactIds, now, qualityGate, minChars, taskPrefixes, skipPatterns }`.
 * @returns A plan: `{ creates, updates, clusters, scanned, filtered, stats }`.
 */
export function reflect(snapshot, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date()
  const newFactIds = new Set(options.newFactIds ?? [])
  const active = (snapshot.facts ?? []).filter((fact) => !fact.supersededBy)
  // The quality gate runs before clustering, so a blocked fact cannot seed a
  // cluster, be reinforced into one, or overwrite a belief. It stays in the
  // store and in retrieval — it simply has no vote here.
  const gate = {
    qualityGate: options.qualityGate,
    minChars: options.minChars,
    taskPrefixes: options.taskPrefixes,
    skipPatterns: options.skipPatterns
  }
  const candidates = active.filter((fact) => isConsolidatable(fact, gate))
  const filtered = active.length - candidates.length
  const withTokens = candidates.map((fact) => ({ ...fact, topicTokens: topicTokens(fact) }))
  // Superseded facts still matter: a belief cites them as evidence, so a
  // contradiction between a belief and one of its own evidence rows has to be
  // detectable even though the row no longer competes for a cluster.
  const evidencePool = (snapshot.allFacts ?? snapshot.facts ?? [])
    .filter((fact) => fact.topicTokens !== undefined || isConsolidatable(fact, gate))
    .map((fact) => (fact.topicTokens === undefined ? { ...fact, topicTokens: topicTokens(fact) } : fact))
  const clusters = clusterByTopic(withTokens, options)
  const beliefs = snapshot.beliefs ?? []
  const creates = []
  const planned = []
  const byTopicLabel = new Map(beliefs.map((belief) => [belief.topic, belief]))
  /** Belief ids already planned for an overwrite by the contradiction sweep. */
  const overwritten = new Set()
  /** Belief ids that an overwrite has been planned for (guards the later sweep). */
  const plannedOverwrites = new Set()

  for (const cluster of clusters) {
    const topic = topicLabel(cluster)
    const memberIds = cluster.facts.map((fact) => fact.id)
    // The belief that already covers this topic: either by label, or by sharing
    // evidence — the shared-evidence test is what makes a second run idempotent.
    const existing =
      byTopicLabel.get(topic) ??
      beliefs.find((belief) => (belief.evidenceIds ?? []).some((id) => memberIds.includes(id)))
    if (existing === undefined) {
      const representative = representativeOf(cluster.facts)
      creates.push({
        topic,
        statement: representative.content,
        layer: representative.layer,
        evidenceIds: memberIds,
        representativeId: representative.id,
        strength: strengthFor(memberIds.length, false),
        createdAt: now.toISOString()
      })
      byTopicLabel.set(topic, { topic, evidenceIds: memberIds })
      continue
    }

    const knownEvidence = new Set(existing.evidenceIds ?? [])
    const addedEvidence = memberIds.filter((id) => !knownEvidence.has(id))
    const evidenceIds = [...new Set([...knownEvidence, ...memberIds])]
    const claims = cluster.facts.map((fact) => ({ fact, conflict: detectConflict(existing.statement, fact.content) }))
    const strong = claims.filter((entry) => entry.conflict.severity === 'strong')
    const weak = claims.filter((entry) => entry.conflict.severity === 'weak')
    const strongFromNewEvidence = strong.filter((entry) => newFactIds.has(entry.fact.id))
    const representative = representativeOf(cluster.facts)
    const shared = overlapScore(charNgrams(existing.statement, 2), charNgrams(representative.content, 2))

    if (strongFromNewEvidence.length > 0) {
      // A genuinely new claim contradicts the belief: replace the conclusion and
      // archive the previous wording. The previous evidence stays in `facts`
      // and stays listed in `belief_revisions.previous_evidence`.
      const trigger = representativeOf(strongFromNewEvidence.map((entry) => entry.fact))
      const worst = strongFromNewEvidence.find((entry) => entry.fact.id === trigger.id)?.conflict
      overwritten.add(existing.id)
      planned.push({
        id: existing.id,
        topic,
        action: 'overwrite',
        statement: trigger.content,
        previousStatement: existing.statement,
        previousStrength: existing.strength,
        previousEvidence: existing.evidenceIds ?? [],
        triggerFactId: trigger.id,
        reason: `contradicted_by_new_evidence:${worst?.type ?? 'conflict'}`,
        evidenceIds,
        evidenceCount: evidenceIds.length,
        strength: strengthFor(evidenceIds.length, true),
        representativeId: trigger.id,
        createdAt: now.toISOString()
      })
    } else if (strong.length > 0) {
      // The contradiction is already inside the archived evidence: this is the
      // "same evidence, weaker belief" case, so only the strength moves.
      planned.push({
        id: existing.id,
        topic,
        action: 'reinforce',
        statement: existing.statement,
        previousStatement: existing.statement,
        previousStrength: existing.strength,
        previousEvidence: existing.evidenceIds ?? [],
        triggerFactId: strong[0].fact.id,
        reason: 'contradiction_already_in_evidence',
        evidenceIds,
        evidenceCount: evidenceIds.length,
        strength: strengthFor(evidenceIds.length, true),
        representativeId: undefined,
        createdAt: now.toISOString()
      })
    } else if (addedEvidence.length > 0) {
      // Reinforce or merge: the statement may be rewritten for specificity only
      // when the new facts agree with it.
      const restate = shared >= 0.6 && representative.content !== existing.statement
      planned.push({
        id: existing.id,
        topic,
        action: restate ? 'merge' : 'reinforce',
        statement: restate ? representative.content : existing.statement,
        previousStatement: existing.statement,
        previousStrength: existing.strength,
        previousEvidence: existing.evidenceIds ?? [],
        triggerFactId: representative.id,
        reason:
          weak.length > 0
            ? 'same_topic_with_soft_disagreement'
            : restate
              ? 'same_topic_more_specific'
              : 'additional_agreeing_evidence',
        evidenceIds,
        evidenceCount: evidenceIds.length,
        strength: strengthFor(evidenceIds.length, weak.length > 0),
        representativeId: restate ? representative.id : undefined,
        createdAt: now.toISOString()
      })
    }
    // No new evidence at all: nothing to do, which keeps repeated runs stable.
  }

  // A new fact can contradict a belief while landing in a *different* cluster:
  // the clustering threshold and the contradiction threshold answer different
  // questions ("same topic" vs "same claim, opposite"). Without this sweep the
  // most important case — a changed decision — would be the one that slipped
  // through, so contradictions are searched for globally, not per cluster.
  for (const belief of beliefs) {
    if (overwritten.has(belief.id)) continue
    const beliefTokens = charNgrams(belief.statement, 2)
    const candidates = withTokens.filter((fact) => newFactIds.has(fact.id))
    let best
    for (const fact of candidates) {
      const conflict = detectConflict(belief.statement, fact.content)
      if (conflict.severity !== 'strong') continue
      const affinity = overlapScore(fact.topicTokens, beliefTokens)
      if (best === undefined || affinity > best.affinity) best = { fact, conflict, affinity }
    }
    // Note the guard: a belief with no contradicting *new* fact must fall
    // through to the next sweep rather than being marked as handled here.
    if (best === undefined) continue
    const known = new Set(belief.evidenceIds ?? [])
    const evidenceIds = [...new Set([...known, best.fact.id])]
    overwritten.add(belief.id)
    plannedOverwrites.add(belief.id)
    planned.push({
      id: belief.id,
      topic: belief.topic,
      action: 'overwrite',
      statement: best.fact.content,
      previousStatement: belief.statement,
      previousStrength: belief.strength,
      previousEvidence: belief.evidenceIds ?? [],
      triggerFactId: best.fact.id,
      reason: `contradicted_by_new_evidence:${best.conflict.type}`,
      evidenceIds,
      evidenceCount: evidenceIds.length,
      strength: strengthFor(evidenceIds.length, true),
      representativeId: best.fact.id,
      createdAt: now.toISOString()
    })
  }

  // Third sweep: a contradiction that is *already* counted as evidence. The
  // belief's conclusion stands (that evidence was weighed when it was written),
  // but the strength must fall to reflect that its evidence disagrees — and
  // only the strength, never the statement.
  const byId = new Map(evidencePool.map((fact) => [fact.id, fact]))
  for (const belief of beliefs) {
    if (plannedOverwrites.has(belief.id) || overwritten.has(belief.id)) continue
    const evidenceFacts = (belief.evidenceIds ?? []).map((id) => byId.get(id)).filter(Boolean)
    const disagreeing = evidenceFacts.filter(
      (fact) => detectConflict(belief.statement, fact.content).severity === 'strong'
    )
    if (disagreeing.length === 0) continue
    planned.push({
      id: belief.id,
      topic: belief.topic,
      action: 'reinforce',
      statement: belief.statement,
      previousStatement: belief.statement,
      previousStrength: belief.strength,
      previousEvidence: belief.evidenceIds ?? [],
      triggerFactId: disagreeing[0].id,
      reason: 'contradiction_already_in_evidence',
      evidenceIds: [...new Set([...(belief.evidenceIds ?? []), ...disagreeing.map((fact) => fact.id)])],
      evidenceCount: (belief.evidenceIds ?? []).length,
      strength: strengthFor(Math.max(1, (belief.evidenceIds ?? []).length), true),
      representativeId: undefined,
      createdAt: now.toISOString()
    })
    overwritten.add(belief.id)
  }

  // One update per belief: an overwrite always wins over a softer action.
  const byBelief = new Map()
  const rank = { overwrite: 0, merge: 1, reinforce: 2 }
  for (const update of planned) {
    const current = byBelief.get(update.id)
    if (current === undefined || rank[update.action] < rank[current.action]) byBelief.set(update.id, update)
  }
  const updates = [...byBelief.values()].sort((a, b) => rank[a.action] - rank[b.action])


  return {
    creates,
    updates,
    clusters: clusters.length,
    scanned: active.length,
    filtered,
    stats: {
      merged: updates.filter((update) => update.action === 'merge').length,
      reinforced: updates.filter((update) => update.action === 'reinforce').length,
      overwritten: updates.filter((update) => update.action === 'overwrite').length,
      created: creates.length,
      filtered
    }
  }
}

// ---------------------------------------------------------------------------
// 7-day scheduling
// ---------------------------------------------------------------------------

/** Parse `'HH:MM'` into `{ hours, minutes }`, falling back to 03:00. */
export function parseClock(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim())
  if (m === null) return { hours: 3, minutes: 0 }
  const hours = Number(m[1])
  const minutes = Number(m[2])
  if (hours > 23 || minutes > 59) return { hours: 3, minutes: 0 }
  return { hours, minutes }
}

/** Local calendar day key without importing `util`'s date helpers again. */
function dayKeyLocal(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * The idempotence key of one scheduled run: its local day.
 *
 * A 7-day schedule fires four to five times a month, so a half-month bucket
 * would collapse the 8th into the 1st (and the 22nd/29th into the 15th) and
 * silently skip three of the five runs. Keying by the actual run day gives each
 * scheduled run its own `reflections.period_key`, which keeps the
 * "never consolidate the same run twice" guarantee while allowing every run.
 *
 * @param date - any instant inside the run.
 * @returns `YYYY-MM-DD` of that local day.
 */
export function periodKeyFor(date) {
  return dayKeyLocal(date)
}

/**
 * Every scheduled run instant in `[from, to]`, inclusive.
 * @param from - window start.
 * @param to - window end.
 * @param options - `{ days, at }`.
 * @returns Instants, ascending.
 */
export function scheduledRunsBetween(from, to, options = {}) {
  const days = Array.isArray(options.days) && options.days.length > 0 ? options.days : PERIOD_DAYS
  const { hours, minutes } = parseClock(options.at)
  const out = []
  const cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate(), 0, 0, 0, 0)
  while (cursor.getTime() <= to.getTime()) {
    if (days.includes(cursor.getDate())) {
      const run = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), hours, minutes, 0, 0)
      if (run.getTime() >= from.getTime() && run.getTime() <= to.getTime()) out.push(run)
    }
    cursor.setDate(cursor.getDate() + 1)
  }
  return out
}

/**
 * The most recent scheduled run at or before `now`, or `undefined`.
 * @param now - reference instant.
 * @param options - `{ days, at }`.
 */
export function previousRunAt(now, options = {}) {
  const from = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0)
  const runs = scheduledRunsBetween(from, now, options)
  return runs.length > 0 ? runs[runs.length - 1] : undefined
}

/**
 * The next scheduled run strictly after `now`.
 *
 * Searches a bounded window (62 days) so a misconfigured `days` list cannot
 * loop forever; the caller treats `undefined` as "nothing to schedule".
 *
 * @param now - reference instant.
 * @param options - `{ days, at }`.
 */
export function nextRunAfter(now, options = {}) {
  const from = new Date(now.getTime() + 1000)
  const to = new Date(now.getTime() + 62 * 86400000)
  const runs = scheduledRunsBetween(from, to, options)
  return runs.length > 0 ? runs[0] : undefined
}

/**
 * Milliseconds until the next check, capped so a long wait still wakes daily.
 *
 * The cap is the point: a process that sleeps until the 1st would miss that
 * run entirely if the machine was off on the day. Waking at least once a day
 * lets {@link ReflectionScheduler} notice and catch up.
 *
 * @param now - reference instant.
 * @param options - `{ days, at, maxHours }`.
 * @returns A positive delay in milliseconds.
 */
export function msUntilNextCheck(now, options = {}) {
  const maxHours = Number(options.maxHours) > 0 ? Number(options.maxHours) : 24
  const next = nextRunAfter(now, options)
  const target = next === undefined ? now.getTime() + maxHours * 3600000 : next.getTime()
  return Math.max(1000, Math.min(target - now.getTime(), maxHours * 3600000))
}

/**
 * Decide whether a catch-up run is owed at startup.
 *
 * @param now - reference instant.
 * @param options - `{ days, at, lastPeriodKey }`.
 * @returns `{ due, periodKey, runAt }`.
 */
export function catchUpDecision(now, options = {}) {
  const previous = previousRunAt(now, options)
  if (previous === undefined) return { due: false, periodKey: undefined, runAt: undefined }
  const periodKey = periodKeyFor(previous)
  return { due: options.lastPeriodKey !== periodKey, periodKey, runAt: previous }
}

/**
 * The 7-day reflection timer.
 *
 * A plain `setTimeout` chain rather than a cron expression, because the plugin
 * owns its own lifecycle and must not depend on cordis' optional timer service.
 * Every dependency that makes a test non-deterministic (clock and timer
 * functions) is injectable.
 */
export class ReflectionScheduler {
  /**
   * @param deps - `{ run, isDue, logger, days, at, maxHours, startupDelayMs }`.
   */
  constructor(deps) {
    this.run = deps.run
    this.isDue = deps.isDue
    this.logger = deps.logger ?? console
    this.options = { days: deps.days, at: deps.at, maxHours: deps.maxHours }
    this.startupDelayMs = Number.isFinite(Number(deps.startupDelayMs)) ? Number(deps.startupDelayMs) : 0
    this.now = typeof deps.now === 'function' ? deps.now : () => new Date()
    this.setTimer = typeof deps.setTimeout === 'function' ? deps.setTimeout : setTimeout
    this.clearTimer = typeof deps.clearTimeout === 'function' ? deps.clearTimeout : clearTimeout
    this.timer = undefined
    this.stopped = false
    this.runs = 0
  }

  /** Start the chain: startup catch-up check, then the periodic check. */
  start() {
    if (this.stopped) return this
    if (this.startupDelayMs > 0) {
      this.timer = this.setTimer(() => {
        this.timer = undefined
        void this.check('startup')
      }, this.startupDelayMs)
    } else {
      void this.check('startup')
    }
    this.timer = this.timer ?? this.setTimer(() => void this.check('scheduled'), msUntilNextCheck(this.now(), this.options))
    this.timer?.unref?.()
    return this
  }

  /** Run one due check. `phase` only affects logging. */
  async check(phase = 'scheduled') {
    if (this.stopped) return { ran: false }
    let result = { ran: false }
    try {
      const due = await this.isDue(this.now())
      if (due && due.due !== false) {
        // The trigger phase is *not* the run kind: a startup catch-up is still a
        // scheduled consolidation, and recording it as `kind: 'startup'` would
        // hide it from the very guard that decides whether it is still owed.
        result = await this.run({ periodKey: due.periodKey, kind: 'scheduled', phase })
        this.runs += 1
        this.logger.info?.(
          `memory: reflection ${result?.periodKey ?? due.periodKey ?? ''} (${phase}) ` +
            `scanned=${result?.scanned ?? 0} created=${result?.stats?.created ?? 0} ` +
            `merged=${result?.stats?.merged ?? 0} reinforced=${result?.stats?.reinforced ?? 0} ` +
            `overwritten=${result?.stats?.overwritten ?? 0}`
        )
      } else if (phase === 'startup') {
        this.logger.debug?.(`memory: reflection not due at startup (${due?.periodKey ?? 'no period'})`)
      }
    } catch (error) {
      this.logger.warn?.(`memory: reflection failed (non-fatal): ${String(error)}`)
    } finally {
      if (!this.stopped) {
        this.timer = this.setTimer(
          () => void this.check('scheduled'),
          msUntilNextCheck(this.now(), this.options)
        )
        this.timer?.unref?.()
      }
    }
    return result
  }

  /** Stop the chain and clear any pending timer. */
  stop() {
    this.stopped = true
    if (this.timer !== undefined) {
      this.clearTimer(this.timer)
      this.timer = undefined
    }
  }
}

/** Deterministic id for a reflection row. */
export function reflectionId(periodKey, kind = 'scheduled') {
  return makeId('refl', `${periodKey}:${kind}`)
}
