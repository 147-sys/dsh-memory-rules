/*!
 * dsh-memory-rules — Step 5 self-check: the archived/superseded invariant.
 *
 * 自检目标（回归 2026-10-15 发现的数据缺陷）：
 *
 * `superseded` and `archived` are mutually exclusive by definition — see the
 * header of `tools/cleanup.mjs`:
 *
 *   superseded  the observation was valid and a newer claim replaced it, so the
 *               fact stays readable as the belief's evidence.
 *   archived    the row was never a valid observation at all (an injected
 *               context fragment, a sentence the noise stripper broke, a
 *               truncated scrap) and is withdrawn from retrieval.
 *
 * On the live store, 16 facts ended up in both states at once: they had been
 * withdrawn on purpose by an explicit-ids archiving run, and a later reflection
 * pass then wrote a `superseded_by` pointer onto them.
 * `tools/doctor.mjs` reports that as an integrity failure
 * (`no fact is both superseded and archived`), and it is not merely cosmetic —
 * clearing `archived_at` to "fix" the contradiction would have put 16
 * deliberately withdrawn claims back into retrieval.
 *
 * The cause was `_supersedeEvidence()` not excluding archived rows. These tests
 * pin the rule at both levels so the regression cannot come back silently:
 * the helper itself, and the reflection path that calls it.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { tempService } from './helpers.js'

const NOW = new Date('2026-10-16T10:00:00+08:00')
const ARCHIVED_AT = '2026-10-04T00:00:00+08:00'

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

/** Withdraw a fact the way `tools/cleanup.mjs --apply --ids` does. */
async function archive(service, id) {
  await service.db.run('UPDATE facts SET archived_at = ? WHERE id = ?', [ARCHIVED_AT, id])
  service.invalidate()
}

test('supersede: an archived fact never receives a superseded_by pointer', async () => {
  const { service, cleanup } = await tempService('supersede-guard')
  try {
    const [archivedId, liveId] = await seedFacts(service, [
      { content: '记忆数据库使用 SQLite 存储事实', createdAt: '2026-10-01T09:00:00+08:00', tags: ['sqlite'] },
      { content: '记忆数据库使用 SQLite 的 WAL 模式', createdAt: '2026-10-02T09:00:00+08:00', tags: ['sqlite'] }
    ])
    await archive(service, archivedId)

    // Drive the helper directly: the archived row is in the evidence list of a
    // belief, exactly the shape the live store had when the defect appeared.
    const changed = await service._supersedeEvidence([archivedId, liveId], null, 'belief_test_guard')
    service.invalidate()

    const rows = await service.allFacts({ includeSuperseded: true })
    const get = (id) => rows.find((row) => row.id === id)

    // The archived row must be left strictly alone: no pointer, still withdrawn.
    assert.equal(changed, 1, 'only the live fact may be folded')
    assert.equal(get(archivedId).supersededBy, null, 'an archived fact must never be marked superseded')
    assert.equal(get(archivedId).archivedAt, ARCHIVED_AT, 'the archived row must stay archived')

    // The guard must not be over-broad: live evidence still folds as before.
    assert.equal(get(liveId).supersededBy, 'belief_test_guard', 'live evidence must still be folded')

    // The doctor's invariant, asserted as a whole rather than per row.
    const both = rows.filter((row) => row.supersededBy !== null && row.archivedAt !== null)
    assert.deepEqual(both, [], 'no fact may be both superseded and archived')
  } finally {
    await cleanup()
  }
})

test('supersede: the guard is idempotent and does not resurrect archived rows', async () => {
  const { service, cleanup } = await tempService('supersede-idempotent')
  try {
    const [archivedId, liveId] = await seedFacts(service, [
      { content: '记忆数据库使用 SQLite 存储事实', createdAt: '2026-10-01T09:00:00+08:00', tags: ['sqlite'] },
      { content: '记忆数据库使用 SQLite 的 WAL 模式', createdAt: '2026-10-02T09:00:00+08:00', tags: ['sqlite'] }
    ])
    await archive(service, archivedId)

    // Re-running over the same evidence is how a forced reflection behaves.
    // Note `changed` counts matched rows, not rows whose value changed — the
    // `superseded_by = ?` arm keeps a repeat update matching — so idempotence is
    // asserted on the stored state, not on that counter.
    await service._supersedeEvidence([archivedId, liveId], null, 'belief_test_guard')
    await service._supersedeEvidence([archivedId, liveId], null, 'belief_test_guard')
    const second = await service._supersedeEvidence([archivedId, liveId], null, 'belief_test_guard')
    service.invalidate()

    const rows = await service.allFacts({ includeSuperseded: true })
    const archived = rows.find((row) => row.id === archivedId)
    assert.equal(second, 1, 'the repeat call must match the one live row and never the archived one')
    assert.equal(rows.length, 2, 'no fact may be deleted')
    assert.equal(archived.supersededBy, null)
    assert.equal(archived.archivedAt, ARCHIVED_AT, 'a withdrawn row must not be resurrected')
    // Stable across repeats: the live row keeps exactly the one pointer.
    assert.equal(rows.find((row) => row.id === liveId).supersededBy, 'belief_test_guard')
  } finally {
    await cleanup()
  }
})

test('reflect: an archived fact already in a belief stays withdrawn', async () => {
  const { service, cleanup } = await tempService('reflect-archived')
  try {
    // Three same-topic facts so the reflection creates a belief; one of them is
    // withdrawn before the pass runs, which is what the live store looked like.
    const ids = await seedFacts(service, [
      { content: '记忆数据库使用 SQLite 存储事实', createdAt: '2026-10-01T09:00:00+08:00', tags: ['sqlite'] },
      { content: '记忆数据库使用 SQLite 的 WAL 模式', createdAt: '2026-10-02T09:00:00+08:00', tags: ['sqlite'] },
      { content: '记忆数据库使用 SQLite 存储全部证据', createdAt: '2026-10-03T09:00:00+08:00', tags: ['sqlite'] }
    ])
    const [archivedId] = ids
    await archive(service, archivedId)

    const result = await service.runReflection({ periodKey: '2026-10-15', now: NOW })
    assert.equal(result.skipped, false)

    const rows = await service.allFacts({ includeSuperseded: true })
    const archived = rows.find((row) => row.id === archivedId)
    assert.equal(archived.archivedAt, ARCHIVED_AT, 'the withdrawal must survive the reflection')
    assert.equal(archived.supersededBy, null, 'a reflection must not mark a withdrawn fact as superseded')

    const both = rows.filter((row) => row.supersededBy !== null && row.archivedAt !== null)
    assert.deepEqual(both, [], 'no fact may be both superseded and archived')

    // Regression guard on the normal path: the live evidence is still folded,
    // and the belief's representative fact is deliberately left live.
    const belief = (await service.allBeliefs())[0]
    assert.ok(belief, 'the reflection must still create a belief')
    const liveFolded = rows.filter((row) => row.id !== archivedId && row.supersededBy === belief.id)
    assert.equal(liveFolded.length, 1, 'exactly the non-representative live evidence is folded')
    assert.equal(rows.length, 3, 'no fact may be deleted')
  } finally {
    await cleanup()
  }
})
