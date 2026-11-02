/*!
 * dsh-memory-rules — Step 6 self-check: the consolidation quality gate.
 *
 * 自检目标：
 *   1. runtime scaffolding never becomes a belief, however often it repeats
 *   2. questions and one-off task instructions never become evidence
 *   3. an ordinary cluster still consolidates exactly as before
 *   4. the gate is reported (`stats.filtered`) and can be switched off
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { isConsolidatable, reflect } from '../lib/reflect.js'

let seq = 0

/** Build one snapshot fact with a deterministic id. */
function fact(content, layer = 'experience', confidence = 0.7) {
  seq += 1
  return {
    id: `fact_gate_${String(seq).padStart(3, '0')}`,
    content,
    layer,
    confidence,
    tags: [],
    createdAt: '2026-10-20T10:00:00+08:00',
    updatedAt: '2026-10-20T10:00:00+08:00'
  }
}

const SAMPLES = [
  'Time sampled while preparing turn 2, step 1: 2026-10-15T00:03:05+08:00[Asia/Shanghai]',
  'Time sampled while preparing turn 3, step 2: 2026-10-16T01:03:05+08:00[Asia/Shanghai]',
  'Time sampled while preparing turn 4, step 1: 2026-10-17T02:03:05+08:00[Asia/Shanghai]'
]

const QUESTIONS = [
  '这个功能到底应该怎么开启？',
  '为什么记忆库读取不到内容？',
  '现在到底该先做哪一步？'
]

const INSTRUCTIONS = [
  '帮我检查现有插件和 skills 是否都正常',
  '帮我把这几张表格转成 Excel 文件',
  '帮我整理一下桌面上的文献清单'
]

const CONCLUSIONS = [
  '记忆库使用 SQLite 数据库存储事实',
  '记忆库使用 SQLite 数据库存储信念',
  '记忆库使用 SQLite 数据库存储关系'
]

/** Plan a reflection over `facts` with only the gate under test varying. */
function plan(facts, options = {}) {
  return reflect({ facts, beliefs: [] }, { minEvidence: 3, ...options })
}

test('gate: runtime scaffolding never becomes a belief', () => {
  const result = plan(SAMPLES.map((content) => fact(content)))
  assert.equal(result.creates.length, 0)
  assert.equal(result.clusters, 0)
  assert.equal(result.filtered, 3)
  assert.equal(result.stats.filtered, 3)
})

test('gate: questions never become evidence', () => {
  const result = plan(QUESTIONS.map((content) => fact(content)))
  assert.equal(result.creates.length, 0)
  assert.equal(result.filtered, 3)
})

test('gate: task instructions never become evidence', () => {
  const result = plan(INSTRUCTIONS.map((content) => fact(content)))
  assert.equal(result.creates.length, 0)
  assert.equal(result.filtered, 3)
})

test('gate: an ordinary cluster still consolidates, unfiltered', () => {
  const result = plan(CONCLUSIONS.map((content) => fact(content)))
  assert.equal(result.creates.length, 1)
  assert.equal(result.filtered, 0)
  assert.equal(result.creates[0].evidenceIds.length, 3)
})

test('gate: blocked facts cannot join a real cluster', () => {
  const facts = [...CONCLUSIONS.map((content) => fact(content)), ...SAMPLES.map((content) => fact(content))]
  const result = plan(facts)
  assert.equal(result.creates.length, 1)
  assert.equal(result.filtered, 3)
  assert.equal(result.creates[0].evidenceIds.length, 3)
})

test('gate: switching it off restores the ungated behaviour', () => {
  const result = plan(SAMPLES.map((content) => fact(content)), { qualityGate: false })
  assert.equal(result.creates.length, 1)
  assert.equal(result.filtered, 0)
})

test('gate: rewritten task instructions and elapsed variants are blocked', () => {
  const facts = [
    fact('Elapsed since the preceding step context: 11m 47s.'),
    fact('还有帮用户整理并标出 skills 和插件清单'),
    fact('用户现在想把这个插件与记忆插件合并成一套'),
    fact('已完成 6 篇日文文献的中文概要（只读）')
  ]
  const result = plan(facts)
  assert.equal(result.creates.length, 0)
  assert.equal(result.filtered, 4)
})

test('gate: directives stay in the prompt block, not in a belief', () => {
  const facts = [
    fact('用户硬性协作流程（最高置信度）：任务先给计划再执行'),
    fact('用户硬性规则：交付文件前必须先确认'),
    fact('以后所有交付文件生成前先给用户确认'),
    fact('只读，不要修改任何文件。')
  ]
  const result = plan(facts)
  assert.equal(result.creates.length, 0)
  assert.equal(result.filtered, 4)
})

test('gate: a plain preference is still a belief candidate', () => {
  const result = plan([
    fact('用户偏好结论先行的表达方式'),
    fact('用户偏好结论先行的汇报方式'),
    fact('用户偏好结论先行的写作方式')
  ])
  assert.equal(result.filtered, 0)
  assert.equal(result.creates.length, 1)
})

test('isConsolidatable: the individual rules', () => {
  assert.equal(isConsolidatable({ content: '太短' }), false)
  assert.equal(isConsolidatable({ content: '这个插件为什么不起作用？' }), false)
  assert.equal(isConsolidatable({ content: '帮我检查一下现有插件是否都正常' }), false)
  assert.equal(isConsolidatable({ content: 'SQLite 是记忆库的存储引擎' }), true)
  assert.equal(isConsolidatable({ content: 'SQLite 是记忆库的存储引擎' }, { skipPatterns: [/记忆/] }), false)
  assert.equal(isConsolidatable({ content: '短句' }, { qualityGate: false }), true)
  assert.equal(isConsolidatable({ content: 'SQLite 是记忆库的存储引擎' }, { minChars: 40 }), false)
})
