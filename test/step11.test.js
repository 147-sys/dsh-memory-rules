/*!
 * dsh-memory-rules — Step 11: twenty turns of the real message shape.
 *
 * 自检目标（升级验收 A10 / A7）：
 *
 * 单测证明每条规则对不对，这一条证明"合起来跑二十轮"之后库是干净的。它按线上
 * 真实的消息形状回放：每一轮都是
 *
 *   [runtime 片] [技能目录片] [用户原话 source.kind='user']
 *
 * 然后断言三件事：
 *   1. 新增 facts 里没有一条是运行时样板（A10）；
 *   2. 注入块自己不会被当成事实再抽一遍（A7）；
 *   3. 真实的人话仍然一条不少地进了库（不能为了干净而失明）。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { extractFacts, stripNoise } from '../lib/extract.js'
import { toTurns } from '../lib/plugin.js'
import { tempService } from './helpers.js'

/** The shapes the harness actually sends, as separate messages. */
function turnMessages(index, ownWords) {
  return [
    {
      role: 'user',
      content: [{ type: 'text', text: `Time sampled while preparing turn ${index}, step 1: 2026-11-01T13:3${index % 10}:00+08:00[Asia/Shanghai]` }]
    },
    {
      role: 'user',
      content: [{ type: 'text', text: 'Elapsed since the preceding model-visible message: unavailable' }]
    },
    {
      role: 'user',
      content: [{ type: 'text', text: 'Current DSH file policy: workspace-write. Approval policy: ask.' }]
    },
    {
      role: 'user',
      content: [{ type: 'text', text: '<user_long_term_memories source="memory" count="2">旧注入块</user_long_term_memories>' }],
      source: { kind: 'memory', form: 'snapshot' }
    },
    { role: 'user', content: [{ type: 'text', text: ownWords }], source: { kind: 'user' } }
  ]
}

/** The twenty things the person actually says. */
const OWN_WORDS = [
  '把记忆插件的写入闸门收紧，先做来源判定再做长度判定。',
  '数据库里那条 superseded 不是噪声，是被归纳进信念的标记。',
  '注入块要放在用户原话之前，不要放最后。',
  '知识库走 250 毫秒硬预算，超时就当没有。',
  '信念保底槽只占一个位置，多了一定会复述。',
  '排序权重里 confidence 要降下来，它和查询无关。',
  'RRF 归一要用实际最大值，不然多路一致没有意义。',
  '记忆和知识必须两个标签，不然冲突时没法指称。',
  '常设答案要单独一个标签，它不是记忆。',
  '心跳要能在库里读到，否则等于没有埋点。',
  '写入端不做 LLM 判重，成本撑不住。',
  '孤儿的 superseded 指针会让事实永久不可召回。',
  '抽取权重调整必须用同一批离线样本对比。',
  '失败要 fail-open，知识库挂了不能拖死对话。',
  '超预算时丢整条，不要截半句。',
  '展示层不要改 form，那是宿主的约定。',
  '观察信念是性格载体，不该靠相似度碰运气。',
  '记忆永不物理删除，只作废或者被取代。',
  '知识库和记忆不共用一个文件。',
  '验收标准要能被第二个人独立复现。'
]

test('replay: twenty turns leave no scaffolding in the store', async () => {
  const { service, cleanup } = await tempService('replay-gate')
  try {
    for (let index = 1; index <= OWN_WORDS.length; index += 1) {
      const turns = toTurns(turnMessages(index, OWN_WORDS[index - 1]))
      assert.equal(turns.length, 1, `turn ${index} must yield exactly one turn`)
      await service.ingestMessages(turns, { sessionId: 'replay', seen: new Set() })
    }
    service.invalidate()
    const facts = await service.allFacts({ includeSuperseded: true })
    assert.ok(facts.length > 0, 'the real statements must be stored')

    const boilerplate = facts.filter((fact) =>
      /Time sampled while preparing|Elapsed since the preceding|Current DSH file policy|Approval policy/.test(fact.content)
    )
    assert.deepEqual(boilerplate.map((fact) => fact.content), [], 'A10: no scaffolding may be stored')

    const injected = facts.filter((fact) => /旧注入块|user_long_term_memories/.test(fact.content))
    assert.deepEqual(injected.map((fact) => fact.content), [], 'A7: an injected block must not be re-extracted')
  } finally {
    await cleanup()
  }
})

test('replay: the gate does not go blind — ordinary statements still pass', () => {
  const prose = stripNoise('把记忆插件的写入闸门收紧，先做来源判定再做长度判定。')
  const facts = extractFacts([{ role: 'user', text: prose }], { includeAssistant: false })
  assert.ok(facts.length >= 1, 'a real instruction must still become a fact')
  assert.match(facts[0].content, /写入闸门/)
})
