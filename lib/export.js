/*!
 * dsh-memory-rules — Markdown export.
 *
 * The database is the system of record; these files are the human-readable
 * view. They are written by `memory_export` and by the automatic mirror that
 * runs alongside every write, and they are deliberately plain: headings, one
 * row per memory, and no information that is only recoverable from the
 * database. A person (or `grep`) should be able to answer "what does this agent
 * remember about X" from these files alone.
 */

import fs from 'node:fs'
import path from 'node:path'

import { isoNow, parseJsonArray } from './util.js'

/** Layer labels, bilingual so the file is readable either way. */
export const LAYER_LABEL = {
  world: '世界事实 world',
  experience: '自身经历 experience',
  belief: '观察信念 belief',
  answer: '常设答案 answer'
}

/**
 * One Markdown table cell: no cell separators, no newlines, bounded length.
 *
 * A pipe is replaced by the HTML entity `&#124;` rather than escaped with a
 * backslash: GFM does not treat `\|` as an escape, so a backslash-escaped pipe
 * still splits the cell and silently adds a column. The backslash itself is
 * entity-encoded too, so a literal `&#124;` in the source cannot be mistaken
 * for an encoded pipe.
 */
export function cell(value, max = 400) {
  const text = String(value ?? '')
    .replace(/\\/g, '&#92;')
    .replace(/\|/g, '&#124;')
    .replace(/\r?\n/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Render one fact as a Markdown bullet (used by the day-file mirror). */
export function renderFactRecord(fact) {
  const tags = Array.isArray(fact.tags) && fact.tags.length > 0 ? `  ${fact.tags.map((t) => `#${t}`).join(' ')}` : ''
  const confidence = fact.confidence === undefined ? '' : ` conf=${Number(fact.confidence).toFixed(2)}`
  const quote = fact.rawQuote ? `\n  - 原文: ${cell(fact.rawQuote, 240)}` : ''
  return `- **${fact.layer}**${confidence} ${cell(fact.content, 400)}${tags}${quote}`
}

/** Bilingual label for a belief's revision number. */
function revisionLabel(revision) {
  return revision === 0 ? '0（未修订过）' : `${revision}（已修订 ${revision} 次）`
}

/** Render one belief as a Markdown block (used by `beliefs.md` and the mirror). */
export function renderBeliefRecord(belief) {
  const evidence = parseJsonArray(belief.evidenceIds)
  return [
    `## ${cell(belief.statement, 240)}`,
    '',
    `- id: \`${belief.id}\``,
    `- 主题 topic: \`${cell(belief.topic, 120)}\``,
    `- 强度 strength: ${Number(belief.strength).toFixed(3)}（证据 ${belief.evidenceCount ?? evidence.length} 条）`,
    `- 层 layer: ${belief.layer}`,
    `- 修订 revision: ${revisionLabel(Number(belief.revision) || 0)}`,
    `- 证据 evidence: ${evidence.map((id) => `\`${id}\``).join(', ') || '—'}`,
    `- 状态 status: ${belief.archivedAt ? `已作废 archived at ${belief.archivedAt}（不参与检索）` : '未归档 active'}`,
    `- 更新时间 updated: ${belief.updatedAt}`,
    ''
  ].join('\n')
}

/** Render one standing answer for `answers.md`. */
export function renderAnswerRecord(answer) {
  const questions = parseJsonArray(answer.questions ?? answer.question_pattern)
  return [
    `## ${cell(questions[0] ?? answer.question, 200)}`,
    '',
    `- id: \`${answer.id}\``,
    `- 命中 hits: ${answer.hits ?? 0}　置信度 confidence: ${Number(answer.confidence ?? 0.9).toFixed(2)}`,
    `- 最近核验 last verified: ${answer.lastVerified}`,
    questions.length > 1 ? `- 其他问法 variants: ${questions.slice(1).map((q) => `“${cell(q, 80)}”`).join('、')}` : undefined,
    '',
    String(answer.answer ?? answer.cachedAnswer ?? '').trim(),
    ''
  ]
    .filter((line) => line !== undefined)
    .join('\n')
}

/** Truncate an id for display, keeping it recognisable. */
export function shortId(id) {
  const value = String(id ?? '')
  return value.length > 14 ? `${value.slice(0, 14)}…` : value
}

/** Render the `facts.md` document: a per-layer table plus the newest rows. */
export function renderFactsDoc(facts, counts, now = new Date()) {
  const byLayer = new Map()
  for (const fact of facts) {
    if (!byLayer.has(fact.layer)) byLayer.set(fact.layer, [])
    byLayer.get(fact.layer).push(fact)
  }
  const lines = [
    '# 记忆事实 facts',
    '',
    `导出时间 exported: ${isoNow(now)}　共 ${facts.length} 条（facts 表 ${counts?.facts ?? facts.length} 行）`,
    '',
    '| 层 layer | 条数 rows |',
    '| --- | --- |',
    ...['world', 'experience'].map((layer) => `| ${LAYER_LABEL[layer]} | ${(byLayer.get(layer) ?? []).length} |`),
    ''
  ]
  for (const layer of ['world', 'experience']) {
    const rows = byLayer.get(layer) ?? []
    lines.push(`## ${LAYER_LABEL[layer]}（${rows.length}）`, '')
    if (rows.length === 0) {
      lines.push('_（暂无）_', '')
      continue
    }
    lines.push('| id | 时间 created | 置信度 | 内容 content | 标签 tags | 来源 session | 原文 raw quote |')
    lines.push('| --- | --- | --- | --- | --- | --- | --- |')
    for (const fact of rows) {
      // The id is truncated but present: it is how a reader traces an exported
      // row back to `facts`, and how a belief's `evidence_ids` are resolved.
      lines.push(
        `| \`${cell(shortId(fact.id), 20)}\` | ${cell(fact.createdAt, 19)} | ` +
          `${fact.confidence === undefined ? '' : Number(fact.confidence).toFixed(2)} | ` +
          `${cell(fact.content, 240)} | ${(fact.tags ?? []).map((t) => `#${cell(t, 24)}`).join(' ')} | ` +
          `${cell(fact.sourceSession ?? '—', 40)} | ${cell(fact.rawQuote ?? '—', 160)} |`
      )
    }
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/** Render the `beliefs.md` document. */
export function renderBeliefsDoc(beliefs, now = new Date()) {
  const lines = [
    '# 观察信念 beliefs',
    '',
    `导出时间 exported: ${isoNow(now)}　共 ${beliefs.length} 条。信念由每 7 天一次的 consolidate 任务把同主题事实合并而成；`,
    '原始事实一并保留在 `facts.md`，信念只调整强度或覆写结论，从不删除证据。已作废的信念仍会列出，但不再参与检索。',
    ''
  ]
  if (beliefs.length === 0) {
    lines.push('_（暂无：尚未有主题累积到合并阈值。）_', '')
  } else {
    lines.push('| 主题 topic | 强度 | 证据数 | 修订 | 状态 | 更新时间 |', '| --- | --- | --- | --- | --- | --- |')
    for (const belief of beliefs) {
      lines.push(
        `| ${cell(belief.topic, 40)} | ${Number(belief.strength).toFixed(3)} | ${belief.evidenceCount} | ` +
          `${belief.revision} | ${belief.archivedAt ? '已作废' : '未归档'} | ${cell(belief.updatedAt, 19)} |`
      )
    }
    lines.push('')
    for (const belief of beliefs) lines.push(renderBeliefRecord(belief), '')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/** Render the `answers.md` document. */
export function renderAnswersDoc(answers, now = new Date()) {
  const lines = [
    '# 常设答案 answers',
    '',
    `导出时间 exported: ${isoNow(now)}　共 ${answers.length} 条。命中常设答案时直接返回缓存内容：不检索、不跑模型。`,
    ''
  ]
  if (answers.length === 0) {
    lines.push('_（暂无）_', '')
  } else {
    lines.push('| 问题 question | 置信度 | 命中 | 最近核验 |', '| --- | --- | --- | --- |')
    for (const answer of answers) {
      lines.push(
        `| ${cell(answer.questions?.[0] ?? answer.question, 60)} | ${Number(answer.confidence).toFixed(2)} | ` +
          `${answer.hits} | ${cell(answer.lastVerified, 19)} |`
      )
    }
    lines.push('')
    for (const answer of answers) lines.push(renderAnswerRecord(answer), '')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/** Render the `relations.md` document, grouped by subject. */
export function renderRelationsDoc(relations, now = new Date()) {
  const lines = [
    '# 关系图 relations',
    '',
    `导出时间 exported: ${isoNow(now)}　共 ${relations.length} 条边。每条边都回溯到断言它的原始事实（\`source_fact_id\`）。`,
    ''
  ]
  if (relations.length === 0) {
    lines.push('_（暂无）_', '')
    return `${lines.join('\n').trimEnd()}\n`
  }
  lines.push('| 主语 subject | 谓词 predicate | 宾语 object | 置信度 | 来源事实 | 时间 |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  for (const relation of relations) {
    lines.push(
      `| ${cell(relation.subject, 60)} | ${cell(relation.predicate, 40)} | ${cell(relation.object, 60)} | ` +
        `${Number(relation.confidence).toFixed(2)} | ${cell(relation.source_fact_id ?? '手动声明', 24)} | ` +
        `${cell(relation.created_at, 19)} |`
    )
  }
  lines.push('')
  return `${lines.join('\n').trimEnd()}\n`
}

/** Render the `timeline.md` document: every dated row in time order. */
export function renderTimelineDoc(facts, now = new Date()) {
  const dated = facts.filter((fact) => /^\d{4}-\d{2}-\d{2}/.test(String(fact.createdAt ?? '')))
  const byDay = new Map()
  for (const fact of dated) {
    const day = String(fact.createdAt).slice(0, 10)
    if (!byDay.has(day)) byDay.set(day, [])
    byDay.get(day).push(fact)
  }
  const days = [...byDay.keys()].sort().reverse()
  const lines = ['# 时间线 timeline', '', `导出时间 exported: ${isoNow(now)}　覆盖 ${days.length} 天，${dated.length} 条事实。`, '']
  for (const day of days) {
    lines.push(`## ${day}`, '')
    for (const fact of byDay.get(day).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))) {
      lines.push(`- \`${String(fact.createdAt).slice(11, 19)}\` **${fact.layer}** ${cell(fact.content, 240)}`)
    }
    lines.push('')
  }
  if (days.length === 0) lines.push('_（暂无）_', '')
  return `${lines.join('\n').trimEnd()}\n`
}

/** Render the `README.md` index with live counts. */
export function renderIndexDoc({ counts, engine, dbFile, exportedAt, files }) {
  const layerCounts = counts.layers ?? {}
  return `${[
    '# 本地记忆库 local memory',
    '',
    `导出时间 exported: ${isoNow(new Date(exportedAt))}`,
    `存储 store: \`${dbFile}\`（engine \`${engine}\`）`,
    '',
    '| 表 table | 行数 rows |',
    '| --- | --- |',
    `| facts（世界事实 + 自身经历） | ${counts.facts ?? 0} |`,
    `| beliefs（观察信念） | ${counts.beliefs ?? 0} |`,
    `| answers（常设答案） | ${counts.answers ?? 0} |`,
    `| relations（关系图） | ${counts.relations ?? 0} |`,
    `| belief_revisions（覆写审计） | ${counts.belief_revisions ?? 0} |`,
    `| reflections（反思记录） | ${counts.reflections ?? 0} |`,
    '',
    '| 层 layer | 活跃条数 |',
    '| --- | --- |',
    `| 世界事实 world | ${layerCounts.world ?? 0} |`,
    `| 自身经历 experience | ${layerCounts.experience ?? 0} |`,
    `| 观察信念 belief | ${counts.beliefs ?? 0} |`,
    `| 常设答案 answer | ${counts.answers ?? 0} |`,
    '',
    '> 「活跃条数」只算未被并入信念的事实；已并入的事实仍保留在 `facts.md` 与所在信念的证据链里，',
    '> 所以 `facts.md` 的分层计数会大于这里的活跃计数。',
    '',
    '## 文件 files',
    '',
    ...['README.md', ...files.map((file) => path.basename(file))].map(
      (name) => `- [\`${name}\`](./${name})`
    ),
    '- `YYYY-MM-DD.md` — 每日镜像（会话级自动写入，可手工编辑）',
    '',
    '> 数据库是唯一事实来源；本目录的 Markdown 是给人看的视图，随时可由 `memory_export` 重建。'
  ].join('\n')}\n`
}

/**
 * Write the whole Markdown export into `dir`.
 *
 * @param options - `{ dir, facts, beliefs, answers, relations, counts, engine, dbFile, now }`.
 * @returns The written file paths.
 */
export function buildExport(options) {
  const dir = options.dir
  const files = []
  const write = (name, contents) => {
    const file = path.join(dir, name)
    fs.writeFileSync(file, contents, 'utf8')
    files.push(file)
    return file
  }
  const counts = { ...(options.counts ?? {}) }
  const layers = {}
  for (const fact of options.facts ?? []) {
    if (fact.supersededBy) continue
    layers[fact.layer] = (layers[fact.layer] ?? 0) + 1
  }
  counts.layers = layers

  const names = ['facts.md', 'beliefs.md', 'answers.md', 'relations.md', 'timeline.md']
  const now = options.now ?? new Date()
  write(names[0], renderFactsDoc(options.facts ?? [], counts, now))
  write(names[1], renderBeliefsDoc(options.beliefs ?? [], now))
  write(names[2], renderAnswersDoc(options.answers ?? [], now))
  write(names[3], renderRelationsDoc(options.relations ?? [], now))
  write(names[4], renderTimelineDoc(options.facts ?? [], now))
  write(
    'README.md',
    renderIndexDoc({
      counts,
      engine: options.engine ?? 'unknown',
      dbFile: options.dbFile ?? '',
      exportedAt: now,
      files: names.map((name) => path.join(dir, name))
    })
  )
  return files
}
