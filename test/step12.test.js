/*!
 * dsh-memory-rules — Step 12: the standing-answer shortcut must not fire on a
 * two-character query.
 *
 * 自检目标（2026-11-01 修复）：
 *
 * `findAnswer` 原本用 `overlapScore`（包含率 = 共享 / 较小集合）给查询与问法打分，
 * 于是任意短查询只要被问法包含就是满分：「现在」只有 1 个 bigram，对
 * 「现在哪个区」得分 1.0，把那条答案打中了 78 次，每轮白注入两百字无关政策。
 *
 * 改成 Dice（共享 / 两边平均）后，短查询拿不到高分，真正的问法仍是 1.0。
 * 三条不变式：
 *   1. 一两个字的查询绝不命中；
 *   2. 原问法（含尾部语气词）仍然命中，且精确命中是满分；
 *   3. 无关长问句不命中——防止把阈值调死。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { findAnswer } from '../lib/retrieve.js'

/** One decoded `answers` row, shaped as `decodeAnswer` returns it. */
const zone = {
  id: 'answer_zone',
  questions: ['现在哪个区', '当前区是什么', '我这是哪个工作区', '现在粘在哪个区'],
  text: '不要再读 zone-state.json —— 技能区方案已删除。'
}

test('answers: a two-character query does not trigger a five-character question', () => {
  assert.equal(findAnswer('现在', [zone], {}), undefined, '「现在」 must not match 「现在哪个区」')
  assert.equal(findAnswer('现在清', [zone], {}), undefined)
  assert.equal(findAnswer('重启', [zone], {}), undefined)
})

test('answers: the exact phrasing still hits with a perfect score', () => {
  const hit = findAnswer('现在哪个区', [zone], {})
  assert.ok(hit, 'the stored phrasing must still hit')
  assert.equal(hit.score, 1)
  assert.equal(hit.matchedQuestion, '现在哪个区')
})

test('answers: a trailing particle does not break a real question', () => {
  const hit = findAnswer('我这是哪个工作区啊', [zone], {})
  assert.ok(hit, '「…啊」 must still match 「我这是哪个工作区」')
  assert.ok(hit.score >= 0.6, `expected a hit, got ${hit?.score}`)
})

test('answers: an unrelated question misses', () => {
  assert.equal(findAnswer('记忆插件的抽取门槛是多少', [zone], {}), undefined)
})
