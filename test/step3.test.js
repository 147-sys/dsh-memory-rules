/*!
 * dsh-memory-rules — Step 3 self-check.
 *
 * 自检目标（对应升级计划第 3 步）：
 *   1. 插入 3 条同主题 facts 能否合并成 1 条 belief
 *   2. 新旧冲突时是否只更新强度或覆写结论
 *   3. 不删原始事实 — every fact row survives, and a replaced statement is
 *      archived in `belief_revisions`
 *   4. 每 7 天触发一次 — the 7-day schedule, the catch-up rule and the
 *      idempotence guard all behave
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  catchUpDecision,
  clusterByTopic,
  detectConflict,
  detectsConflict,
  msUntilNextCheck,
  nextRunAfter,
  parseClock,
  periodKeyFor,
  previousRunAt,
  reflect,
  ReflectionScheduler,
  scheduledRunsBetween,
  strengthFor,
  topicLabel,
  topicTokens
} from '../lib/reflect.js'
import * as reflectModule from '../lib/reflect.js'
import { tempService } from './helpers.js'

const NOW = new Date('2026-10-16T10:00:00+08:00')

/** Store `facts` with an explicit id/timestamp, then return the ids. */
async function seedFacts(service, facts) {
  const ids = []
  for (const fact of facts) {
    const { stored } = await service.ingestFact({
      content: fact.content,
      layer: fact.layer ?? 'experience',
      confidence: fact.confidence ?? 0.7,
      tags: fact.tags ?? [],
      relations: fact.relations ?? []
    })
    // `ingestFact` stamps `createdAt`; rewrite it so the fixture is deterministic.
    await service.db.run('UPDATE facts SET created_at = ? WHERE id = ?', [fact.createdAt, stored.id])
    ids.push(stored.id)
  }
  service.invalidate()
  return ids
}

test('reflect: three same-topic facts merge into one belief, and nothing is deleted', async () => {
  const { service, cleanup } = await tempService('merge3')
  try {
    const ids = await seedFacts(service, [
      {
        content: '记忆数据库使用 SQLite 存储事实',
        createdAt: '2026-10-01T09:00:00+08:00',
        tags: ['sqlite'],
        relations: [{ subject: '记忆数据库', predicate: 'uses', object: 'SQLite' }]
      },
      {
        content: '记忆数据库的 SQLite 文件放在 memory.db',
        createdAt: '2026-10-05T09:00:00+08:00',
        confidence: 0.8,
        tags: ['sqlite']
      },
      {
        content: '记忆数据库用 SQLite 的 WAL 模式提高并发',
        createdAt: '2026-10-09T09:00:00+08:00',
        confidence: 0.75,
        tags: ['sqlite']
      },
      // A different topic must not be folded into this belief.
      { content: '用户偏好用 pnpm 管理依赖', createdAt: '2026-10-02T09:00:00+08:00', tags: ['preference'] }
    ])

    const before = await service.counts()
    assert.equal(before.facts, 4)
    assert.equal(before.beliefs, 0)

    const result = await service.runReflection({ periodKey: '2026-10-15', now: NOW })
    assert.equal(result.skipped, false)
    assert.equal(result.stats.created, 1, 'exactly one belief must be created')
    assert.equal(result.stats.overwritten, 0)

    const beliefs = await service.allBeliefs()
    assert.equal(beliefs.length, 1)
    const belief = beliefs[0]
    assert.equal(belief.evidenceCount, 3, 'all three same-topic facts are evidence')
    assert.deepEqual([...belief.evidenceIds].sort(), [...ids.slice(0, 3)].sort())
    assert.match(belief.topic, /sqlite|记忆|数据|memory|wal/i)
    assert.ok(belief.strength > 0.5 && belief.strength < 0.95, `strength out of range: ${belief.strength}`)
    assert.equal(belief.revision, 0)

    // 不删原始事实: all four rows are still there, and the relations survive.
    const after = await service.counts()
    assert.equal(after.facts, before.facts, 'no fact may be deleted by a reflection')
    assert.equal(after.relations, before.relations)
    const facts = await service.allFacts()
    for (const id of ids) assert.ok(facts.some((fact) => fact.id === id), `fact ${id} disappeared`)
    // The non-representative evidence is marked, not removed.
    const folded = facts.filter((fact) => fact.supersededBy === belief.id)
    assert.equal(folded.length, 2)
    // The unrelated fact stays active.
    const unrelated = facts.find((fact) => fact.content.includes('pnpm'))
    assert.equal(unrelated.supersededBy, null)

    // Idempotence: the same period cannot consolidate twice.
    const again = await service.runReflection({ periodKey: '2026-10-15', now: NOW })
    assert.equal(again.skipped, true)
    assert.equal((await service.allBeliefs()).length, 1)
    assert.equal((await service.counts()).belief_revisions, 0)

    // Forcing a re-run over unchanged evidence changes nothing.
    const forced = await service.runReflection({ periodKey: '2026-10-15', force: true, now: NOW })
    assert.equal(forced.skipped, false)
    assert.equal(forced.stats.created, 0)
    assert.equal((await service.allBeliefs())[0].statement, belief.statement)
  } finally {
    await cleanup()
  }
})

test('reflect: new contradicting evidence overwrites the conclusion and archives the old one', async () => {
  const { service, cleanup } = await tempService('overwrite')
  try {
    await seedFacts(service, [
      { content: '记忆数据库使用 SQLite 存储事实', createdAt: '2026-10-01T09:00:00+08:00', tags: ['sqlite'] },
      { content: '记忆数据库使用 SQLite 的 WAL 模式', createdAt: '2026-10-02T09:00:00+08:00', tags: ['sqlite'] },
      { content: '记忆数据库使用 SQLite 存储全部证据', createdAt: '2026-10-03T09:00:00+08:00', tags: ['sqlite'] }
    ])
    await service.runReflection({ periodKey: '2026-10-01', now: new Date('2026-10-05T10:00:00+08:00') })
    const first = (await service.allBeliefs())[0]
    assert.ok(first)
    const originalStatement = first.statement

    // New, contradicting evidence arrives in the next period.
    const newIds = await seedFacts(service, [
      {
        content: '记忆数据库不再使用 SQLite，已改为 PostgreSQL',
        createdAt: '2026-10-16T09:00:00+08:00',
        confidence: 0.9,
        tags: ['sqlite']
      }
    ])
    const facts = await service.allFacts()
    for (const id of newIds) {
      const fact = facts.find((entry) => entry.id === id)
      assert.ok(detectsConflict(originalStatement, fact.content), `fixture must actually conflict: ${fact.content}`)
    }

    const result = await service.runReflection({
      periodKey: '2026-10-15',
      now: NOW,
      newFactIds: newIds
    })
    assert.equal(result.stats.overwritten, 1, 'the contradiction must overwrite the conclusion')

    const second = (await service.allBeliefs())[0]
    assert.notEqual(second.statement, originalStatement, 'the belief statement must be replaced')
    assert.match(second.statement, /PostgreSQL/)
    assert.equal(second.revision, 1, 'the revision counter must advance')
    assert.equal(second.evidenceCount, 4, 'evidence is cumulative: nothing is dropped')

    // The previous wording and its evidence are archived, not lost.
    const revisions = await service.db.all('SELECT * FROM belief_revisions', [])
    assert.equal(revisions.length, 1)
    assert.equal(revisions[0].previous_statement, originalStatement)
    assert.match(revisions[0].reason, /contradicted_by_new_evidence/)
    assert.equal(JSON.parse(revisions[0].previous_evidence).length, 3)
    assert.ok(Number(revisions[0].previous_strength) > 0)

    // The contradicting fact is the new representative, so it stays active.
    const after = await service.allFacts()
    const trigger = after.find((fact) => fact.id === second.evidenceIds.find((id) => newIds.includes(id)))
    assert.equal(trigger.supersededBy, null)
    // ...and every original fact is still on disk.
    assert.equal(after.length, 4)
  } finally {
    await cleanup()
  }
})

test('reflect: a contradiction already inside the evidence only adjusts strength', async () => {
  const { service, cleanup } = await tempService('strengthonly')
  try {
    await seedFacts(service, [
      { content: '部署方案使用 SQLite 作为本地数据库', createdAt: '2026-10-01T09:00:00+08:00', confidence: 0.9 },
      { content: '部署方案使用 SQLite 的 WAL 日志', createdAt: '2026-10-02T09:00:00+08:00', confidence: 0.8 },
      { content: '部署方案使用 SQLite 的备份接口', createdAt: '2026-10-03T09:00:00+08:00', confidence: 0.7 }
    ])
    await service.runReflection({ periodKey: '2026-10-01', now: new Date('2026-10-05T10:00:00+08:00') })
    const before = (await service.allBeliefs())[0]

    // A contradictory fact that the belief already counts as evidence: this is
    // the "same evidence, weaker belief" case, so ONLY the strength may move.
    await seedFacts(service, [
      { content: '部署方案不使用 SQLite 的 WAL 日志', createdAt: '2026-10-02T09:00:00+08:00', confidence: 0.4 }
    ])
    const snapshot = await service.snapshot()
    const conflictFact = snapshot.facts.find((fact) => fact.content.includes('不使用 SQLite'))
    // Force it into the belief's evidence without touching the statement, which
    // is exactly the state a previous run leaves behind.
    await service.db.run('UPDATE beliefs SET evidence_ids = ?, evidence_count = ? WHERE id = ?', [
      JSON.stringify([...before.evidenceIds, conflictFact.id]),
      before.evidenceIds.length + 1,
      before.id
    ])
    await service.db.run('UPDATE facts SET superseded_by = ? WHERE id = ?', [before.id, conflictFact.id])
    service.invalidate()

    const result = await service.runReflection({ periodKey: '2026-10-15', now: NOW, newFactIds: [] })
    assert.equal(result.stats.overwritten, 0, 'a known contradiction must not overwrite again')
    const after = (await service.allBeliefs())[0]
    assert.equal(after.statement, before.statement, 'the statement must be untouched')
    assert.equal(after.revision, 0, 'no revision is recorded when nothing is replaced')
    assert.ok(after.strength < before.strength, `contradiction must weaken the belief: ${before.strength} -> ${after.strength}`)
    assert.equal((await service.counts()).belief_revisions, 0)
  } finally {
    await cleanup()
  }
})

test('reflect: related-but-different facts are not mistaken for a contradiction', () => {
  assert.equal(detectConflict('用户偏好用 pnpm 管理依赖', '用户偏好用 bun 管理依赖').severity, 'none')
  assert.equal(detectConflict('记忆数据库使用 SQLite', '记忆数据库使用 SQLite 的 WAL 模式').severity, 'none')
  const negated = detectConflict('记忆数据库使用 SQLite', '记忆数据库不再使用 SQLite')
  assert.equal(negated.severity, 'strong')
  assert.equal(negated.type, 'reversal')
  const antonym = detectConflict('该功能启用了缓存', '该功能禁用了缓存')
  assert.equal(antonym.severity, 'strong')
  assert.equal(antonym.type, 'antonym')
  assert.equal(detectConflict('完全无关的一句话', '另一个毫无交集的说法').severity, 'none')
  assert.equal(detectConflict('同一句话', '同一句话').severity, 'none')

  // A negation of a NARROWER object refutes a part, not the claim: "no longer
  // uses SQLite's backup interface" must not archive "the store uses SQLite".
  const narrowedReversal = detectConflict('记忆库使用 SQLite', '记忆库不再使用 SQLite 的备份接口')
  assert.equal(narrowedReversal.severity, 'weak', `expected weak, got ${narrowedReversal.type}`)
  assert.equal(narrowedReversal.type, 'reversal-narrowed')
  // When both sides name a different qualifier of the same head noun, the
  // extractor cannot order them, so the documented behaviour is to escalate
  // (overwrite + archive): a missed contradiction is worse than a noisy one,
  // and the archived wording is recoverable.
  const differingQualifiers = detectConflict('部署方案使用 SQLite 作为本地数据库', '部署方案不使用 SQLite 的 WAL 日志')
  assert.equal(differingQualifiers.severity, 'strong')
  // ...while a negation of the same object stays a contradiction.
  assert.equal(detectConflict('部署方案使用 SQLite 作为本地数据库', '部署方案不使用 SQLite').severity, 'strong')
  const { objectScope } = reflectModule
  assert.equal(objectScope('记忆库使用 SQLite', '记忆库不再使用 SQLite 的备份接口'), 'narrowed')
  assert.equal(objectScope('记忆库使用 SQLite', '记忆库不再使用 SQLite'), 'same')

  // Strength: asymptotic, and a conflict costs a fixed penalty.
  assert.ok(strengthFor(3) > strengthFor(1))
  assert.ok(strengthFor(10) > strengthFor(3))
  assert.ok(strengthFor(10) < 0.95)
  assert.ok(strengthFor(3, true) < strengthFor(3, false))
})

test('reflect: clustering is deterministic and topic-labelled', () => {
  const facts = [
    { id: 'a', content: '记忆数据库使用 SQLite', tags: ['sqlite'], layer: 'experience', confidence: 0.8, createdAt: '2026-10-03T00:00:00+08:00' },
    { id: 'b', content: '记忆数据库使用 SQLite 的 WAL', tags: ['sqlite'], layer: 'experience', confidence: 0.7, createdAt: '2026-10-02T00:00:00+08:00' },
    { id: 'c', content: '记忆数据库用 SQLite 存证据', tags: ['sqlite'], layer: 'experience', confidence: 0.6, createdAt: '2026-10-01T00:00:00+08:00' },
    { id: 'd', content: '用户偏好用 pnpm 管理依赖', tags: ['preference'], layer: 'experience', confidence: 0.6, createdAt: '2026-10-01T00:00:00+08:00' }
  ].map((fact) => ({ ...fact, topicTokens: topicTokens(fact) }))
  const clusters = clusterByTopic(facts, { threshold: 0.34, minEvidence: 3 })
  assert.equal(clusters.length, 1)
  assert.equal(clusters[0].facts.length, 3)
  // The label must contain a distinctive token from the topic, not only the
  // bigrams every member shares.
  assert.match(topicLabel(clusters[0]), /sqlite|wal|memory/i)
  const plan = reflect({ facts, beliefs: [] }, { minEvidence: 3 })
  assert.equal(plan.creates.length, 1)
  assert.equal(plan.creates[0].evidenceIds.length, 3)
})

test('reflect: the 7-day schedule, catch-up and next-run maths', () => {
  assert.deepEqual(parseClock('03:00'), { hours: 3, minutes: 0 })
  assert.deepEqual(parseClock('nonsense'), { hours: 3, minutes: 0 })
  assert.deepEqual(parseClock('25:99'), { hours: 3, minutes: 0 })

  // The idempotence key is the actual run day, so the 8th/22nd/29th are not
  // folded into a half-month bucket and silently skipped.
  assert.equal(periodKeyFor(new Date('2026-10-01T00:00:00+08:00')), '2026-10-01')
  assert.equal(periodKeyFor(new Date('2026-10-14T23:00:00+08:00')), '2026-10-14')
  assert.equal(periodKeyFor(new Date('2026-10-15T00:00:00+08:00')), '2026-10-15')
  assert.equal(periodKeyFor(new Date('2026-10-31T23:00:00+08:00')), '2026-10-31')

  // A day-of-month step of 7 expands to 1,8,15,22,29 (not a rolling seven-day
  // interval; that distinction is documented in reflect.js).
  const runs = scheduledRunsBetween(new Date('2026-10-01T00:00:00+08:00'), new Date('2026-11-01T00:00:00+08:00'), {
    at: '03:00'
  })
  assert.deepEqual(
    runs.map((run) => `${run.getMonth() + 1}/${run.getDate()} ${run.getHours()}:${run.getMinutes()}`),
    ['10/1 3:0', '10/8 3:0', '10/15 3:0', '10/22 3:0', '10/29 3:0']
  )
  assert.equal(nextRunAfter(new Date('2026-10-16T10:00:00+08:00'), { at: '03:00' }).getDate(), 22)
  assert.equal(previousRunAt(new Date('2026-10-16T10:00:00+08:00'), { at: '03:00' }).getDate(), 15)
  // 02:59 on a run day is still before that day's 03:00 run.
  assert.equal(previousRunAt(new Date('2026-10-15T02:59:00+08:00'), { at: '03:00' }).getDate(), 8)
  // The check delay is capped so a long wait still wakes daily.
  const delay = msUntilNextCheck(new Date('2026-10-16T10:00:00+08:00'), { at: '03:00', maxHours: 24 })
  assert.equal(delay, 24 * 3600000)

  // Catch-up: a machine that was off on the 15th still owes that run.
  const owed = catchUpDecision(new Date('2026-10-20T10:00:00+08:00'), { at: '03:00', lastPeriodKey: '2026-10-08' })
  assert.equal(owed.due, true)
  assert.equal(owed.periodKey, '2026-10-15')
  const settled = catchUpDecision(new Date('2026-10-20T10:00:00+08:00'), { at: '03:00', lastPeriodKey: '2026-10-15' })
  assert.equal(settled.due, false)
})

test('reflect: the scheduler fires once per due period and survives a failing run', async () => {
  const { service, cleanup } = await tempService('scheduler')
  try {
    await seedFacts(service, [
      { content: '调度器测试使用 SQLite 存事实', createdAt: '2026-10-01T09:00:00+08:00', tags: ['sqlite'] },
      { content: '调度器测试使用 SQLite 的 WAL', createdAt: '2026-10-02T09:00:00+08:00', tags: ['sqlite'] },
      { content: '调度器测试使用 SQLite 存证据', createdAt: '2026-10-03T09:00:00+08:00', tags: ['sqlite'] }
    ])

    // A controllable clock and timer: no real waiting, fully deterministic.
    let clock = new Date('2026-10-16T10:00:00+08:00')
    const timers = []
    const scheduler = service.createScheduler({
      now: () => clock,
      setTimeout: (fn, ms) => {
        const timer = { fn, ms, cleared: false }
        timers.push(timer)
        return timer
      },
      clearTimeout: (timer) => {
        timer.cleared = true
      }
    })
    scheduler.start()
    await Promise.resolve()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal((await service.allBeliefs()).length, 1, 'the startup catch-up must consolidate')
    assert.equal((await service.reflections()).length, 1)
    const row = (await service.reflections())[0]
    assert.equal(row.period_key, '2026-10-15', 'the owed period, not today\'s')

    // A second check in the same period must not run again.
    const again = await scheduler.check('scheduled')
    assert.equal(again.ran, false)
    assert.equal((await service.reflections()).length, 1)

    // A failing run is contained and the chain is rescheduled.
    const broken = service.createScheduler({
      now: () => clock,
      setTimeout: (fn, ms) => {
        const timer = { fn, ms, cleared: false }
        timers.push(timer)
        return timer
      },
      clearTimeout: () => {},
      isDue: () => ({ due: true, periodKey: '2099-01-01' }),
      run: () => {
        throw new Error('boom')
      },
      logger: { info() {}, warn() {}, debug() {} }
    })
    broken.start()
    await new Promise((resolve) => setImmediate(resolve))
    assert.ok(broken.runs === 0, 'a throwing run must not be counted as a success')
    const stopped = broken.stop()
    assert.equal(stopped, undefined)

    // Time only moves forward; the next check is scheduled at most a day out.
    clock = new Date('2026-10-17T10:00:00+08:00')
    assert.equal(msUntilNextCheck(clock, { at: '03:00', maxHours: 24 }), 24 * 3600000)
    scheduler.stop()
    assert.ok(timers.length > 0)
  } finally {
    await cleanup()
  }
})

test('reflect: the run is recorded and the belief mirror is written', async () => {
  const { service, dir, cleanup } = await tempService('recording', { markdownMirror: true })
  try {
    await seedFacts(service, [
      { content: '镜像测试使用 SQLite 存事实', createdAt: '2026-10-01T09:00:00+08:00', tags: ['sqlite'] },
      { content: '镜像测试使用 SQLite 的 WAL', createdAt: '2026-10-02T09:00:00+08:00', tags: ['sqlite'] },
      { content: '镜像测试使用 SQLite 存证据', createdAt: '2026-10-03T09:00:00+08:00', tags: ['sqlite'] }
    ])
    await service.runReflection({ periodKey: '2026-10-15', now: NOW })
    const rows = await service.reflections()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].kind, 'scheduled')
    assert.equal(rows[0].scanned, 3)
    assert.equal(rows[0].topics, 1)
    assert.equal(rows[0].merged + rows[0].reinforced, 0)
    assert.match(rows[0].notes, /created=1/)
    assert.ok(rows[0].finished_at)
    const mirror = path.join(dir, 'beliefs.md')
    assert.ok(fs.existsSync(mirror), 'the belief mirror must be written')
    const text = fs.readFileSync(mirror, 'utf8')
    assert.match(text, /反思/)
    assert.match(text, /原始事实全部保留/)
  } finally {
    await cleanup()
  }
})

test('reflect: a manual run bypasses the period guard', async () => {
  const { service, cleanup } = await tempService('manual')
  try {
    await seedFacts(service, [
      { content: '手动反思使用 SQLite 存事实', createdAt: '2026-10-01T09:00:00+08:00', tags: ['sqlite'] },
      { content: '手动反思使用 SQLite 的 WAL', createdAt: '2026-10-02T09:00:00+08:00', tags: ['sqlite'] },
      { content: '手动反思使用 SQLite 存证据', createdAt: '2026-10-03T09:00:00+08:00', tags: ['sqlite'] }
    ])
    const first = await service.runReflection({ periodKey: '2026-10-15', kind: 'manual', now: NOW })
    assert.equal(first.skipped, false)
    const second = await service.runReflection({ periodKey: '2026-10-15', kind: 'manual', now: NOW })
    assert.equal(second.skipped, true, 'the manual kind is guarded per period too')
    const third = await service.runReflection({ periodKey: '2026-10-15', kind: 'manual', force: true, now: NOW })
    assert.equal(third.skipped, false)
    // The forced re-run replaces the same `reflections` row (the id is derived
    // from period + kind), so the audit has one manual row, not two.
    assert.equal((await service.reflections()).length, 1)
    assert.equal((await service.reflections())[0].kind, 'manual')
  } finally {
    await cleanup()
  }
})
