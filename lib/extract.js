/*!
 * dsh-memory-rules — fact extraction ("写入").
 *
 * One turn of conversation goes in; a handful of *structured* facts come out,
 * each of the shape
 *
 *   { content, layer, confidence, tags, entities, relations, rawQuote, origin,
 *     timeRef, kind }
 *
 * The governing requirement is 不照搬原文: the extractor must not store the
 * transcript. It rewrites each candidate sentence into a compressed,
 * third-person statement, records the temporal / participant / event /
 * relation / conclusion slots it recognised, and keeps the *source sentence*
 * only in `rawQuote` so the rewrite stays auditable. A `verbatim` warning is
 * raised whenever a candidate is too close to its source to count as a rewrite,
 * and the extractor is pure: it never touches the database.
 *
 * Layer assignment (the four-layer model):
 *
 *   world      general, stable knowledge — definitions, norms, tool facts
 *   experience a concrete episode with a time, a participant, or an action
 *   conclusion marked by an inference connective (所以/因此/结论/建议…)
 *   belief     never produced here — beliefs only exist after `reflect`
 *   answer     never produced here — answers only exist after promotion
 */

import { charNgrams, clip, makeId, normalizeText, overlapScore, squash, clamp, round } from './util.js'

/** Rewrite rules: `[pattern, replacement]`, applied in order. */
const REWRITES = [
  [/\bI(?:'m| am)\b/gi, '用户是'],
  [/\bI(?:'ve| have)\b/gi, '用户已'],
  [/\bI\b/gi, '用户'],
  [/\bmy\b/gi, '用户的'],
  [/\bmine\b/gi, '用户的'],
  [/\bwe\b/gi, '我们'],
  [/\bour\b/gi, '我们的'],
  [/\byou\b/gi, '你'],
  [/\byour\b/gi, '你的']
]

/**
 * First-person tokens that must survive the "我 → 用户" rule.
 * `我` is a substring of `我们`, and a blind replace would corrupt it into
 * `用户们`, so the plural form is parked behind a sentinel first.
 */
const WE_SENTINEL = '\u0001WE\u0001'
const PLURAL_PRONOUNS = [
  [/我们/g, WE_SENTINEL],
  [/\bwe're\b/gi, WE_SENTINEL],
  [/\bwe've\b/gi, WE_SENTINEL],
  [/\bwe\b/gi, WE_SENTINEL]
]


/**
 * Filler that carries no fact and only pads a sentence.
 * Removing it is the main reason a stored fact is shorter than its source.
 */
const FILLERS = [
  /^(?:嗯|呃|哦|啊|诶|好|好的|行|可以|没问题|收到|明白|了解|谢谢|感谢|请|麻烦|那个|这个|就是说|也就是说|其实|反正|然后呢|那么)[，,、。！!\s]*/,
  /(?:请|麻烦)?(?:帮我|帮忙|给我|替我)/g,
  // Quantifiers are filler, but a demonstrative + quantifier ("这一点") is not:
  // the lookbehind keeps 这/那/哪 intact.
  /(?<![这那哪])一点(?!点)/g,
  /(?<![这那哪])一些/g,
  /(?<![这那哪])一下/g,
  /(?:吧|呢|啊|呀|嘛|哦|哈|咯|啦)(?=[。！？!?，,、\s]|$)/g,
  /\b(?:please|kindly|just|could you|would you|can you|i think|i guess|maybe|actually)\b/gi
]

/** Connectives that mark the sentence as a derived conclusion. */
const CONCLUSION_RE =
  /(所以|因此|因而|故而|可见|由此可见|综上|总之|结论|所以说|这意味着|表明|说明|建议|应当|应该|结论是|说明白|由此|归根结底|也就是说|thus|therefore|so that|in conclusion|we conclude|this means|suggests that)/i

/** Markers of general, time-stable knowledge. */
const WORLD_RE =
  /(是一种|属于|指的是|定义为|本质上|一般来说|通常情况下|总是|从不|永远|必须|不允许|规范是|标准是|is a |is an |are a |refers to|by definition|generally|always|never|must be|is defined as)/i

/**
 * Markers of a definitional clause: `<X> 是 <Y>`.
 *
 * Tested with `WORLD_SUBJECT_RE` rather than as one pattern. A single
 * alternation with an optional subject quantifier is ambiguous — the optional
 * group can absorb the `是` itself and then fail — so the two halves are
 * checked separately.
 */
const WORLD_PREDICATE_RE = /(是|属于|指的是|means|refers to|is a |is an |are a )/i

/** The clause opens with a participant or an inference, so it is not general. */
const WORLD_SUBJECT_RE = /^(?:用户|助手|我们|你|所以|因此|因而|综上|总之|结论|建议|这表明|这说明|这意味着|也就是说)/

/**
 * Markers that make a statement episodic (experience) rather than general.
 * The past-tense adverbs (`已经`) are deliberately NOT here: "TypeScript 已经
 * 成为…" is still general knowledge, while "用户已经装好了" is caught by the
 * participant and action-verb patterns instead.
 */
const EPISODIC_RE =
  /(昨天|今天|明天|前天|后天|上周|本周|下周|上个月|这个月|本月|去年|今年|刚刚|刚才|曾经|完成了|做完了|决定了|试了|遇到了|发现了|修复了|升级了|安装了|配置了|部署了|改用|改为|选择了|created|fixed|upgraded|installed|configured|deployed|decided|chose|renamed|migrated)/i

/** Words that can never be the subject of a real relation. */
const VAGUE_SUBJECT_RE = /^(?:所以|因此|因而|综上|总之|结论|建议|这表明|这说明|意味着|这意味着|也就是说|由此|可见|这|那)$/

/** Markers that make a statement an experience rather than general knowledge. */
const EXPERIENCE_RE =
  /(用户|助手|我们|昨天|今天|明天|前天|后天|上周|本周|下周|上个月|这个月|本月|去年|今年|已经|刚刚|刚才|曾经|完成了|做完了|决定了|试了|遇到了|发现了|修复了|升级了|安装了|配置了|部署了|改用|改为|选择了|发现|遇到|修复|升级|安装|配置|部署|created|fixed|upgraded|installed|configured|deployed|decided|chose|renamed|migrated)/i

/** Verbs that turn a sentence into an "event" candidate. */
const EVENT_VERB_RE =
  /(决定|选择|改用|改为|修复|升级|安装|配置|部署|创建|新建|删除|移除|替换|迁移|重命名|实现|完成|新增|添加|接入|接入到|放弃|采用|启用|禁用|关闭|开启|发现|遇到|确认|验证|优化|重构|整理|导出|导入|修正)/

/** Conjunctive markers of an explicit relation between two named things. */
const RELATION_TEMPLATES = [
  { re: /(.+?)(?:使用|采用|用的是|用的是)\s*(.+)/, predicate: 'uses' },
  { re: /(.+?)(?:依赖|基于)\s*(.+)/, predicate: 'depends_on' },
  { re: /(.+?)(?:放在|位于|保存在|存于|写到|写到目录|存储在)\s*(.+)/, predicate: 'located_at' },
  { re: /(.+?)(?:是|属于|等于)\s*(.+)/, predicate: 'is_a' },
  { re: /(.+?)(?:偏好|喜欢|倾向于)\s*(.+)/, predicate: 'prefers' },
  { re: /(.+?)(?:负责|拥有|持有|维护)\s*(.+)/, predicate: 'owns' },
  { re: /(.+?)(?:导致|引起|造成)\s*(.+)/, predicate: 'causes' },
  { re: /(.+?)(?:修复|解决了?)\s*(.+)/, predicate: 'fixes' },
  { re: /\b(.+?)\s+(?:uses|depends on|is a|is an|owns|maintains|prefers|fixes|causes|is located in)\s+(.+)/i, predicate: 'uses' }
]

/** Predicate map for the English template above. */
const EN_PREDICATE = [
  { re: /\buses\b/i, predicate: 'uses' },
  { re: /\bdepends on\b/i, predicate: 'depends_on' },
  { re: /\bis (?:a|an)\b/i, predicate: 'is_a' },
  { re: /\bowns\b|\bmaintains\b/i, predicate: 'owns' },
  { re: /\bprefers\b/i, predicate: 'prefers' },
  { re: /\bfixes\b|\bresolves\b/i, predicate: 'fixes' },
  { re: /\bcauses\b/i, predicate: 'causes' }
]

/** Absolute date and clock stamps. */
const DATE_RE = /(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?)|(\d{1,2}月\d{1,2}日)/g
const TIME_RE = /(\d{1,2}:\d{2}(?::\d{2})?)|(\d{1,2}\s*(?:点|时)\d{0,2}\s*分?)|(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/g

/** Relative day words, used when no absolute stamp is present. */
const RELATIVE_TIME = {
  今天: 0,
  今日: 0,
  昨天: -1,
  昨日: -1,
  前天: -2,
  明天: 1,
  后天: 2,
  上周: -7,
  本周: 0,
  这周: 0,
  下周: 7,
  上个月: -30,
  本月: 0,
  这个月: 0,
  去年: -365,
  今年: 0
}

/** Characters that terminate a candidate sentence. */
const SENTENCE_SPLIT_RE = /(?<=[。！？!?；;\n])|(?<=\.\s)/

/**
 * Whole lines that are harness scaffolding rather than anything a person said.
 *
 * The harness injects its runtime snapshot as `role: 'user'` messages, and on
 * this deployment it does so in *pieces*: the header line ("Current runtime
 * context…") arrives separately from the trailing lines ("Time sampled while
 * preparing turn N…"), so a message-level guard sees a short, innocent-looking
 * message. Between 2026-10-14 and 11-01 that produced 231 stored facts — 32.5%
 * of the store — each of which then competed for the recall budget on every
 * later turn.
 *
 * Matching is by line *prefix*, so a turn counter ("turn 19") or a timestamp
 * change cannot slip past it. The list is duplicated nowhere: `service.js`
 * keeps the message-level guard for assembled blocks, and this one handles the
 * pieces that guard cannot see.
 */
export const BOILERPLATE_LINE_RE =
  /^[ \t]*(?:Time sampled while preparing|Elapsed since the preceding|Current runtime context|Current working directory:|Current DSH file policy:|Approval policy:|Browser time zone for this request:|Tokens prefixed with @|Non-zero exits are reported|The following skills are available|This snapshot supersedes|Recalled long-term memory \(|Long-term memory is active for this deployment).*$/gm

/**
 * Sentences that open with a bare demonstrative.
 *
 * "该方案已废弃" is a perfectly good memory *in context* and a useless one out of
 * it: recalled three weeks later there is no way to know which plan. The guard
 * only fires when the sentence also carries no anchor at all (identifier,
 * quoted term, path, date, number) — with one, the referent is recoverable.
 */
const DANGLING_HEAD_RE = /^[「『（(\s]*(?:这|那|其|该|此|上述|刚才|上面|前面|另外)/
const ANCHOR_RE = /[`"'“”‘’/\\]|[A-Za-z0-9][A-Za-z0-9_.-]{3,}|\d{1,4}年|\d{1,2}月|\d{1,2}日|\d/

/**
 * Remove code, tables, inline markup and harness scaffolding from a message
 * before extraction.
 *
 * Code is where identifiers and paths live; keeping it would turn every code
 * block into a "fact" about variable names. Scaffolding is not the person's
 * words at all, and keeping it is worse than keeping code: it is *about* the
 * conversation, so it recalls as relevant to everything and nothing.
 *
 * @param text - raw message text.
 * @returns The prose part of the message.
 */
export function stripNoise(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    // Inline code keeps its payload: a backticked identifier is often the
    // subject of the sentence ("可 `grep` 的 Markdown", "`lib/store.js` 已被
    // 吸收"), and dropping it leaves a broken statement that still looks
    // fact-shaped. Only the delimiters go.
    .replace(/`([^`\n]*)`/g, ' $1 ')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/^\s*[-*+]\s+\[[ x]\]\s*/gm, ' ')
    .replace(BOILERPLATE_LINE_RE, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/**
 * Split prose into candidate sentences.
 * @param text - prose text.
 * @returns Trimmed, non-empty candidates.
 */
export function splitSentences(text) {
  return String(text ?? '')
    .split(SENTENCE_SPLIT_RE)
    .map((part) => squash(part).replace(/^[-*+\d.、)\]]+\s*/, '').trim())
    .filter((part) => part.length >= 4)
}

/**
 * Apply the pronoun/filler rewrites that turn a first-person remark into a
 * third-person statement.
 * @param sentence - source sentence.
 * @returns The rewritten statement.
 */
export function rewrite(sentence) {
  let value = squash(sentence)
  for (const [pattern, replacement] of PLURAL_PRONOUNS) value = value.replace(pattern, replacement)
  for (const [pattern, replacement] of REWRITES) value = value.replace(pattern, replacement)
  // Chinese first person: rewrite `我`, then restore the parked plural.
  value = value.replace(/我/g, '用户').replace(/本人/g, '用户')
  value = value.replace(new RegExp(WE_SENTINEL, 'g'), '我们')
  // Chinese second person addressed to the assistant.
  value = value.replace(/你(?!们)/g, '助手').replace(/你们/g, '你们')
  value = value.replace(/([。！？；，、])\1+/g, '$1')
  // Filler stripping only ever runs at the front, or on a whole-word basis, so
  // a meaningful substring is never removed from the middle of a statement.
  let changed = true
  while (changed) {
    changed = false
    for (const pattern of FILLERS) {
      const next = value.replace(pattern, '')
      if (next !== value) {
        value = next
        changed = true
      }
    }
  }
  const final = squash(value).replace(/^[，,、：:；;]+/, '').replace(/[，,、]+$/, '').trim()
  // 「把…收紧」是请求，不是已完成的事实。硬拒会丢掉真正的设计决定，直接存又会
  // 把指令伪装成事实，所以改写一层：保留内容，只把语气说清楚。
  if (/^把/.test(final)) return `用户要求${final}`
  return final
}

/**
 * Extract every explicit time reference in a sentence.
 * @param sentence - source sentence.
 * @param now - reference instant (for relative words).
 * @returns `{ absolute, relativeDays, timeOfDay }`.
 */
export function extractTimeRef(sentence, now = new Date()) {
  const text = String(sentence ?? '')
  const absolute = [...text.matchAll(DATE_RE)].map((m) => m[0])
  const clock = [...text.matchAll(TIME_RE)].map((m) => m[0])
  let relativeDays
  for (const [word, days] of Object.entries(RELATIVE_TIME)) {
    if (text.includes(word)) {
      relativeDays = days
      break
    }
  }
  const resolved = absolute.map((raw) => {
    const m = /(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/.exec(raw)
    if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`
    const md = /(\d{1,2})月(\d{1,2})日?/.exec(raw)
    if (md) return `${now.getFullYear()}-${String(md[1]).padStart(2, '0')}-${String(md[2]).padStart(2, '0')}`
    return raw
  })
  return {
    absolute: resolved,
    clock,
    relativeDays,
    resolvedDay:
      resolved[0] ??
      (relativeDays === undefined
        ? undefined
        : new Date(now.getTime() + relativeDays * 86400000).toISOString().slice(0, 10))
  }
}

/**
 * Extract the participants named in a sentence.
 * @param sentence - source sentence.
 * @param origin - `'user'` or `'assistant'`.
 * @returns De-duplicated entity names, most specific first.
 */
export function extractEntities(sentence, origin = 'user') {
  const text = String(sentence ?? '')
  const found = []
  const push = (value) => {
    const name = squash(value).replace(/^[的'"]+|[的'"]+$/g, '')
    if (name.length < 1 || name.length > 40) return
    if (!found.includes(name)) found.push(name)
  }
  // Quoted proper nouns are the strongest signal.
  for (const m of text.matchAll(/[「『“"']([^」』”"']{2,24})[」』”"']/g)) push(m[1])
  // Backticked identifiers survive stripNoise only as words; keep them anyway.
  for (const m of text.matchAll(/\b([A-Za-z][A-Za-z0-9_.\-]{2,30})\b/g)) {
    const word = m[1]
    if (/^(the|and|for|with|that|this|you|your|from|not|but|are|was|were|have|has|will|can|use|the|DSH)$/i.test(word)) continue
    if (/^[A-Z]/.test(word) || /[_\-.]/.test(word) || /(dsh|plugin|skill)/i.test(word)) push(word)
  }
  // Chinese proper nouns ending in 库/系统/插件/配置/文件/方案 and friends.
  // The prefix is bounded to 2..8 characters: an unbounded quantifier would
  // swallow a whole clause ("今天我把记忆插件的数据库") as one "entity".
  for (const m of text.matchAll(/([\u4e00-\u9fffA-Za-z0-9_.\-]{2,8}(?:插件|配置|数据库|目录|文件|脚本|方案|接口|服务|模型|工具|技能|项目|仓库|密钥))/g)) {
    push(m[1])
  }
  if (/\b(用户|我)\b|^用户|我(?!们)/.test(text)) push('用户')
  if (/助手/.test(text)) push('助手')
  return found.slice(0, 6)
}

/**
 * Extract one relation triple from a sentence, when it states one explicitly.
 * @param sentence - source sentence.
 * @param entities - entities already found (used as a fallback subject).
 * @returns `{ subject, predicate, object }` or `undefined`.
 */
export function extractRelation(sentence, entities = []) {
  const text = squash(sentence)
  for (const template of RELATION_TEMPLATES) {
    const m = template.re.exec(text)
    if (!m) continue
    const subject = cleanOperand(m[1], entities, 'subject')
    const object = cleanOperand(m[2], entities, 'object')
    if (subject === '' || object === '') continue
    if (VAGUE_SUBJECT_RE.test(subject)) continue
    // An operand that contains sentence punctuation or runs long is a clause,
    // not an entity: "结论是：检索要先走…，再走…" is a conclusion, not an edge.
    if (/[。！？!?；;：:]/.test(subject) || /[。！？!?；;：:]/.test(object)) continue
    if (subject === object) continue
    if (subject.length > 24 || object.length > 40) continue
    let predicate = template.predicate
    for (const en of EN_PREDICATE) if (en.re.test(text)) predicate = en.predicate
    return { subject, predicate, object }
  }
  return undefined
}

/** Trim a relation operand down to its head phrase. */
function cleanOperand(raw, entities, side) {
  let value = squash(raw)
  value = value.replace(/^[的了和与及、，,：:是]+/, '').replace(/[的了和与及、，,：:]+$/, '')
  value = value.replace(/[（(][^）)]*[）)]/g, '').trim()
  // A long operand is almost always a clause, not an entity: prefer the longest
  // entity already recognised inside it, else cut at the first separator.
  if (value.length > 24) {
    const inside = entities.filter((e) => value.includes(e)).sort((a, b) => b.length - a.length)[0]
    if (inside !== undefined) return squash(inside)
    value = squash(value.split(/[，,、；;。]/)[0])
  }
  if (value.length > 40) return squash(value.slice(0, 40))
  void side
  return value
}

/**
 * Harness-injected context that must never become a fact.
 *
 * The host stamps lines like `Time sampled while preparing turn 9, step 6: …` and
 * `Elapsed since the preceding model-visible message: …` into every turn. Before
 * this guard existed, 232 such rows were written and later had to be archived;
 * the archive cleaning was covering for a missing filter, not fixing it.
 *
 * This is a maintenance point, not a one-off fix: if the host renames its
 * preamble, update this pattern.
 */
export const HARNESS_NOISE_RE =
  /^(?:Time sampled while preparing|Elapsed since the preceding|The runtime context has|Current runtime context|Current working directory|Current DSH|Current DeepSeek Harness|Approval policy|Long-term memory is active|Web search results|External web content follows)/

/**
 * A directive addressed at the assistant ("帮用户…""请检查…"), not a fact.
 *
 * `把` is listed for callers that hand raw text to this gate, but the extraction
 * path never reaches it: `rewrite()` turns a leading `把…` into `用户要求把…`,
 * which is a request stated as a request instead of being dropped.
 */
export const IMPERATIVE_HEAD_RE = /^(?:帮|请|麻烦|给我|把|告诉我|让我们|试|看看)/

/** A question is what an answer is supposed to settle — not a memory of one. */
export const QUESTION_TAIL_RE = /(?:[？?]|吗|呢)\s*$/

/**
 * True when a rewritten candidate reads as a complete claim rather than as a
 * sentence cut mid-thought.
 *
 * This is the gate that keeps fragments out of the store. Real examples it
 * rejects, all of which used to be stored and then recalled: "如果还失败，说明
 * 用户的修复另有问题：" (ends on a colon), "现在核查用户上一轮标出的两处修复和
 * 唯一的遗留疑点：" (a lead-in with nothing after it), "同时发现一条漏网：".
 *
 * @param text - the rewritten statement.
 * @returns `true` when the statement is complete enough to store.
 */
export function isCompleteStatement(text) {
  const value = squash(text)
  if (value.length < MIN_STATEMENT_CHARS) return false
  // Host-injected preamble is context, never a user fact.
  if (HARNESS_NOISE_RE.test(value)) return false
  // An instruction is not a fact: "帮用户检查现有插件和skills是否都正常" is a task.
  if (IMPERATIVE_HEAD_RE.test(value)) return false
  // A question is not a fact: "错件已更换，助手还有问题吗？" is a question.
  if (QUESTION_TAIL_RE.test(value)) return false
  // A sentence that cannot survive being quoted out of its turn is not a
  // memory: it is a fragment of one. See `DANGLING_HEAD_RE`.
  if (DANGLING_HEAD_RE.test(value) && !ANCHOR_RE.test(value)) return false
  // A continuation marker at the end means the sentence was a lead-in whose
  // body was a code block, a list, or the next sentence.
  if (/[:：,，、;；\-—–]$/.test(value)) return false
  // A trailing conjunction is the same defect spelled differently.
  if (/(?:和|与|及|以及|并且|但是|因为|所以|如果|那么|and|or|but|because|that|which)$/i.test(value)) return false
  // Markdown emphasis that survived with an odd number of markers means the
  // stripper removed the span one of them wrapped.
  if ((value.match(/\*\*/g) ?? []).length % 2 === 1 && !value.includes('`')) return false
  return true
}

/**
 * Shortest statement worth remembering, after rewriting.
 *
 * Lowered from 20 to 12 on 2026-11-01: a Chinese statement carries far more
 * meaning per character than English, and 20 was rejecting complete sentences
 * such as 「用户要求所有回答都用中文。」(13) and 「工具注册是同步的、服务打开是异步的。」(18).
 * The fragment guards below (dangling head, trailing colon/conjunction, question
 * tail) are what actually keep cut-off sentences out — length alone never was.
 */
export const MIN_STATEMENT_CHARS = 12

/**
 * Decide which layer a candidate belongs to.
 * @param sentence - source sentence.
 * @param rewritten - rewritten statement.
 * @param timeRef - extracted time reference.
 * @returns `'world' | 'experience' | 'conclusion'`.
 */
export function classifyLayer(sentence, rewritten, timeRef) {
  const text = `${sentence}`
  const hasTime =
    timeRef.absolute.length > 0 || timeRef.relativeDays !== undefined || /^\d{4}-\d{2}-\d{2}/.test(rewritten)
  // Episodic evidence (a time, a participant, an action verb) beats the wording
  // patterns: "决定" is an action even when the sentence also says "是一种".
  const episodic =
    hasTime || EPISODIC_RE.test(text) || EVENT_VERB_RE.test(text) || EVENT_VERB_RE.test(rewritten)
  if (episodic) return 'experience'
  // An explicit inference is a conclusion even when it also states a general
  // truth ("所以结论是：优先用 node:sqlite").
  if (CONCLUSION_RE.test(text)) return 'conclusion'
  // A time-stable statement is world knowledge: an explicit marker, or a
  // definitional clause that does not open with a participant or an inference.
  if (WORLD_RE.test(text)) return 'world'
  if (WORLD_PREDICATE_RE.test(text) && !WORLD_SUBJECT_RE.test(squash(sentence))) return 'world'
  return 'experience'
}

/**
 * Score how confident the extractor is that a candidate is a real, useful fact.
 * @param parts - sentence, rewrite, layer, entities, relation.
 * @returns A score in `[0.05, 0.99]`.
 */
export function scoreCandidate(parts) {
  const { sentence, rewritten, layer, entities, relation, origin } = parts
  let score = 0.4
  const length = rewritten.length
  if (length >= 8 && length <= 120) score += 0.12
  if (entities.length > 0) score += 0.1
  if (relation !== undefined) score += 0.12
  if (layer === 'conclusion') score += 0.1
  if (layer === 'world') score += 0.05
  if (origin === 'user') score += 0.1
  if (EVENT_VERB_RE.test(sentence)) score += 0.08
  // Vague hedges (a bare question, a pure acknowledgement) are worth less.
  if (/(吗|呢|\?|？)\s*$/.test(sentence)) score -= 0.18
  if (/(可能|也许|大概|或许|似乎|好像|应该是)/.test(sentence)) score -= 0.12
  if (length < 6) score -= 0.25
  return round(clamp(score, 0.05, 0.99), 3)
}

/**
 * True when a stored statement is effectively the source sentence verbatim.
 * @param rewritten - candidate statement.
 * @param sentence - source sentence.
 * @returns `true` when the rewrite added no structure.
 */
export function isVerbatim(rewritten, sentence) {
  const a = normalizeText(rewritten)
  const b = normalizeText(sentence)
  if (a.length === 0 || b.length === 0) return false
  if (a === b) return true
  // Longer than the source, or barely shorter: nothing was abstracted away.
  return a.length >= b.length * 0.95
}

/** Short tags that make a fact retrievable by facet. */
function tagsFor(layer, sentence, entities, relation) {
  const tags = new Set([layer])
  if (relation !== undefined) tags.add('relation')
  if (/(用户|我|prefer|like|希望|偏好)/i.test(sentence)) tags.add('preference')
  if (/(决定|选择|确定|settle|decide|chose|决定用)/.test(sentence)) tags.add('decision')
  if (/(错误|失败|异常|bug|error|fail|broken|报错)/i.test(sentence)) tags.add('issue')
  if (/(修复|解决|fixed|resolved|搞定)/i.test(sentence)) tags.add('fix')
  if (/(配置|设置|config|setup|安装|install)/i.test(sentence)) tags.add('config')
  for (const entity of entities.slice(0, 3)) {
    const slug = normalizeText(entity).slice(0, 12)
    if (slug !== '') tags.add(slug)
  }
  return [...tags].slice(0, 8)
}

/**
 * Extract structured facts from one turn's messages.
 *
 * @param turns - `{ role, text }` turns (`'user'` or `'assistant'`).
 * @param options - extraction limits; see `resolveConfig`.
 * @returns Candidate fact objects, best-first, already de-duplicated.
 */
export function extractFacts(turns, options = {}) {
  const maxFacts = Number(options.maxFactsPerTurn) > 0 ? Number(options.maxFactsPerTurn) : 8
  const minConfidence = Number.isFinite(Number(options.minConfidence)) ? Number(options.minConfidence) : 0.35
  const maxChars = Number(options.maxFactChars) > 0 ? Number(options.maxFactChars) : 240
  const includeAssistant = options.includeAssistant !== false
  const now = options.now instanceof Date ? options.now : new Date()
  const sessionId = typeof options.sessionId === 'string' ? options.sessionId : undefined
  const createdAt = typeof options.createdAt === 'string' ? options.createdAt : undefined

  const candidates = []
  const seen = new Set()
  for (const turn of Array.isArray(turns) ? turns : []) {
    const role = turn && turn.role
    if (role !== 'user' && role !== 'assistant') continue
    if (role === 'assistant' && !includeAssistant) continue
    const prose = stripNoise(turn.text)
    for (const sentence of splitSentences(prose)) {
      if (sentence.length < 4 || sentence.length > 600) continue
      const rewritten = rewrite(sentence)
      if (rewritten.length < 4) continue
      if (/^(用户|助手)?(是|的|了|吗|呢|吧|啊)$/.test(rewritten)) continue
      // A sentence cut mid-thought must never become a memory: it recalls as
      // noise and costs context on every later turn.
      if (!isCompleteStatement(rewritten)) continue
      const timeRef = extractTimeRef(sentence, now)
      const entities = extractEntities(sentence, role)
      const relation = extractRelation(sentence, entities)
      const layer = classifyLayer(sentence, rewritten, timeRef)
      const confidence = scoreCandidate({ sentence, rewritten, layer, entities, relation, origin: role })
      const content = clip(rewritten, maxChars)
      const key = `${layer}:${normalizeText(content)}`
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push({
        id: makeId('fact', `${layer}:${normalizeText(content)}`),
        content,
        layer,
        confidence,
        tags: tagsFor(layer, sentence, entities, relation),
        entities,
        relations: relation === undefined ? [] : [relation],
        rawQuote: clip(squash(sentence), 400),
        origin: role,
        kind: relation !== undefined ? 'relation' : classifyKind(sentence),
        timeRef,
        createdAt: createdAt ?? undefined,
        sourceSession: sessionId,
        verbatim: isVerbatim(rewritten, sentence)
      })
    }
  }
  const kept = []
  const keptGrams = []
  for (const candidate of candidates.sort((a, b) => b.confidence - a.confidence)) {
    if (candidate.confidence < minConfidence) continue
    // Near-duplicate suppression: the same statement twice in one turn (for
    // example quoted and then restated) must not become two facts.
    const grams = charNgrams(candidate.content, 2)
    if (keptGrams.some((other) => overlapScore(grams, other) >= 0.9)) continue
    kept.push(candidate)
    keptGrams.push(grams)
    if (kept.length >= maxFacts) break
  }
  return kept
}

/** Classify a candidate as a time / participant / event / relation / conclusion row. */
function classifyKind(sentence) {
  if (EVENT_VERB_RE.test(sentence)) return 'event'
  if (CONCLUSION_RE.test(sentence)) return 'conclusion'
  if (WORLD_RE.test(sentence)) return 'world'
  return 'statement'
}
