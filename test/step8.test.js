/*!
 * dsh-memory-rules — Step 8: the write gate.
 *
 * 自检目标（2026-11-01 升级 P0-5'）：
 *
 * 改造前 707 条 facts 里有 231 条（32.5%）是运行时样板 ——
 *
 *   Time sampled while preparing turn 19, step 1: 2026-11-01T13:38:29+08:00[…]
 *   Elapsed since the preceding model-visible message: unavailable
 *
 * 它们不是"抽错了"，而是"根本没人说过"。harness 把运行时快照当作 role:'user'
 * 的消息下发，而且是**分片**下发：头部一行、尾部几行各自成为一个短消息，所以
 * `service.js` 里那条按整段匹配的 `LOOKS_INJECTED_RE` 与 `MAX_TURN_CHARS` 都拦不住。
 *
 * 因此闸门改成两层，缺一不可：
 *   1. 来源层：一轮里只要有消息声明了 source.kind='user'，就只抽这些消息；
 *   2. 内容层：行级前缀黑名单，兜住没有声明的注入片。
 *
 * 误杀也要防：短句、"这件事…"这类有锚点的指代句必须继续入库。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { BOILERPLATE_LINE_RE, isCompleteStatement, stripNoise } from '../lib/extract.js'
import { collectUserText, selectSpokenMessages, toTurns } from '../lib/plugin.js'

/** The five shapes actually found in the live store, plus two from the block. */
const SCAFFOLDING = [
  'Time sampled while preparing turn 19, step 1: 2026-11-01T13:38:29+08:00[Asia/Shanghai]',
  'Elapsed since the preceding model-visible message: unavailable',
  'Elapsed since the preceding step context: unavailable',
  'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.',
  'Current working directory: "C:\\Users\\me\\Documents\\project".',
  'Approval policy: ask.',
  'The following skills are available in this session:'
]

test('gate: every scaffolding line is removed before extraction', () => {
  for (const line of SCAFFOLDING) {
    const prose = stripNoise(`${line}\n用户要的是先给结论。`)
    assert.doesNotMatch(prose, /Time sampled|Elapsed since|Current runtime context|Current working directory|Approval policy|skills are available/)
    assert.match(prose, /用户要的是先给结论/, 'real prose must survive the same call')
  }
})

test('gate: the line rule is anchored, so an ordinary sentence is untouched', () => {
  const prose = stripNoise('用户说时间采样这一步可以跳过，因为已经有记录了。')
  assert.match(prose, /时间采样/)
  const lineRule = new RegExp(BOILERPLATE_LINE_RE.source, 'm')
  assert.equal(lineRule.test('Time sampled while preparing turn 1'), true)
  assert.equal(lineRule.test('我记得 Time sampled while preparing 这种话'), false)
})

test('gate: a sentence with no anchor of its own is refused', () => {
  assert.equal(isCompleteStatement('该方案已废弃'), false)
  assert.equal(isCompleteStatement('这件事明天再说'), false)
  // With an anchor the same opening is recoverable three weeks later.
  assert.equal(isCompleteStatement('该方案 lib/store.js 已废弃，改用 lib/service.js'), true)
  assert.equal(isCompleteStatement('这条 2026-10-25 的迁移已完成'), true)
})

test('gate: ordinary short memories still pass', () => {
  for (const text of [
    '用户要求所有回答都用中文。',
    '记忆数据库固定在 ~/.dsh/memory/memory.db',
    'DSH 的工作区在左侧导航栏建立',
    '当前主页面左侧导航栏已有插件菜单'
  ]) {
    assert.equal(isCompleteStatement(text), true, text)
  }
})

test('gate: only declared speakers become turns when any exists', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'Time sampled while preparing turn 3' }] },
    { role: 'user', content: [{ type: 'text', text: '把记忆插件的写入闸门收紧' }], source: { kind: 'user' } },
    { role: 'user', content: [{ type: 'text', text: '<available_skills>…</available_skills>' }] }
  ]
  const turns = toTurns(messages)
  assert.equal(turns.length, 1, 'scaffolding must not become a turn')
  assert.match(turns[0].text, /写入闸门/)
})

test('gate: a client that declares nothing still works (legacy fallback)', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '把记忆插件的写入闸门收紧' }] },
    { role: 'assistant', content: [{ type: 'text', text: '好的，我从来源层开始改。' }] }
  ]
  const turns = toTurns(messages)
  assert.equal(turns.length, 2, 'with no source at all, behaviour is unchanged')
})

test('gate: the query is built from the same selection as the write path', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'Current runtime context…' }] },
    { role: 'user', content: [{ type: 'text', text: '记忆插件升级到哪一步了？' }], source: { kind: 'user' } }
  ]
  assert.match(collectUserText(messages), /记忆插件升级/)
  assert.doesNotMatch(collectUserText(messages), /runtime context/)
  assert.equal(selectSpokenMessages(messages).length, 1)
})
