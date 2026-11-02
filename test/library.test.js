/*!
 * dsh-memory-rules — 记忆与规则 host service tests (信念库 + 提示词).
 *
 * Runs the host half against a throwaway SQLite file: no host, no browser.
 * Beliefs are inserted directly (the service no longer exposes `create`), which
 * is also the honest shape of the data: beliefs arrive from consolidation and
 * from older versions of the store, not from a form.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import {
  MemoryLibraryService,
  PROMPT_METHODS,
  REMOTE_METHODS
} from '../lib/library.js'
import { RULES } from '../lib/rules.js'
import { openMemoryService } from '../lib/service.js'
import { tempService } from './helpers.js'

const silent = { info() {}, warn() {}, debug() {}, error() {} }

async function withLibrary(fn, options = {}) {
  const ctx = await tempService('library')
  try {
    const library = new MemoryLibraryService({
      ready: Promise.resolve(ctx.service),
      logger: silent,
      ...options
    })
    await fn(library, ctx.service, ctx)
  } finally {
    await ctx.cleanup()
  }
}

/** Insert a belief row the way consolidation would, without the form. */
async function seedBelief(service, { id, content, confidence = 0.6, evidenceCount = 0, archivedAt = null, revision = 0 }) {
  const beliefId = id ?? `belief_${Math.random().toString(16).slice(2, 12)}`
  const at = '2026-10-20T10:00:00+08:00'
  await service.db.run(
    `INSERT INTO beliefs
       (id, topic, statement, evidence_ids, evidence_count, strength, updated_at, created_at, layer, revision, archived_at)
     VALUES (?, ?, ?, '[]', ?, ?, ?, ?, 'experience', ?, ?)`,
    [beliefId, content.slice(0, 20), content, evidenceCount, confidence, at, at, revision, archivedAt]
  )
  return beliefId
}

test('memory library: only the seven remote methods are exported, each with one payload', () => {
  // The Typert SRC gateway derives the wire arguments from the method
  // signature, so a default parameter (which drops `Function.length` to 0)
  // would advertise a method that takes no payload.
  assert.deepEqual([...REMOTE_METHODS], [
    'list',
    'update',
    'deleteBelief',
    'listPrompts',
    'createPrompt',
    'updatePrompt',
    'deletePrompt'
  ])
  for (const method of REMOTE_METHODS) {
    assert.equal(MemoryLibraryService.prototype[method].length, 1, `${method} must take exactly one payload`)
  }
  // The add/archive write paths are gone from the Remote surface on purpose.
  assert.equal(REMOTE_METHODS.includes('create'), false)
  assert.equal(REMOTE_METHODS.includes('archive'), false)
  assert.deepEqual([...PROMPT_METHODS], ['listPrompts', 'createPrompt', 'updatePrompt', 'deletePrompt'])
})

test('memory library: list starts empty and reports counts', async () => {
  await withLibrary(async (library) => {
    const page = await library.list({})
    assert.equal(page.kind, 'beliefs')
    assert.equal(page.total, 0)
    assert.equal(page.page, 1)
    assert.equal(page.pages, 1)
    assert.deepEqual(page.counts, { active: 0, archived: 0 })
    assert.deepEqual(page.items, [])
  })
})

test('memory library: a belief row maps onto the wire shape', async () => {
  await withLibrary(async (library, service) => {
    await seedBelief(service, { id: 'belief_map', content: '记忆与规则测试：用户偏好深色主题', confidence: 0.82, evidenceCount: 4, revision: 2 })
    const page = await library.list({})
    assert.equal(page.total, 1)
    const item = page.items[0]
    assert.equal(item.id, 'belief_map')
    assert.equal(item.content, '记忆与规则测试：用户偏好深色主题')
    assert.equal(item.confidence, 0.82)
    assert.equal(item.layer, 'belief')
    assert.equal(item.evidence_count, 4)
    assert.equal(item.revision_number, 2)
    assert.equal(item.archived_at, null)
    assert.equal(item.overwritten, false)
  })
})

test('memory library: update appends a revision and increments revision_number', async () => {
  await withLibrary(async (library, service) => {
    const id = await seedBelief(service, { content: '旧信念', confidence: 0.5 })

    const { item: updated } = await library.update({ id, content: '新信念', confidence: 0.95 })
    assert.equal(updated.content, '新信念')
    assert.equal(updated.confidence, 0.95)
    assert.equal(updated.revision_number, 1)

    const revisions = await service.db.all('SELECT * FROM belief_revisions WHERE belief_id = ?', [id])
    assert.equal(revisions.length, 1)
    assert.equal(revisions[0].previous_statement, '旧信念')
    assert.equal(revisions[0].previous_strength, 0.5)
    assert.equal(revisions[0].reason, 'manual_edit')

    const again = await library.update({ id, content: '更新后的信念' })
    assert.equal(again.item.revision_number, 2)
    assert.equal((await service.db.all('SELECT * FROM belief_revisions WHERE belief_id = ?', [id])).length, 2)

    // A no-op save must not inflate the revision number.
    const unchanged = await library.update({ id, content: '更新后的信念', confidence: 0.95 })
    assert.equal(unchanged.item.revision_number, 2)
    assert.equal((await service.db.all('SELECT * FROM belief_revisions WHERE belief_id = ?', [id])).length, 2)
  })
})

test('memory library: a manual edit alone does not mark the belief as overwritten', async () => {
  await withLibrary(async (library, service) => {
    const id = await seedBelief(service, { content: '手动修改前' })
    await library.update({ id, content: '手动修改后' })
    const page = await library.list({})
    assert.equal(page.items[0].overwritten, false, 'only a contradicted_by_new_evidence revision counts')
  })
})

test('memory library: an automated overwrite makes the tooltip flag true', async () => {
  await withLibrary(async (library, service) => {
    const id = await seedBelief(service, { content: '旧结论', revision: 1 })
    await service.db.run(
      `INSERT INTO belief_revisions
         (id, belief_id, previous_statement, previous_strength, previous_evidence, reason, trigger_fact_id, created_at)
       VALUES (?, ?, ?, ?, '[]', 'contradicted_by_new_evidence:negation', NULL, ?)`,
      ['rev_overwrite', id, '旧结论', 0.5, '2026-10-20T03:00:00+08:00']
    )
    const page = await library.list({})
    assert.equal(page.items[0].overwritten, true)
  })
})

test('memory library: update rejects unknown ids, colliding content and archived rows', async () => {
  await withLibrary(async (library, service) => {
    const a = await seedBelief(service, { content: '信念 A' })
    await seedBelief(service, { content: '信念 B' })

    await assert.rejects(() => library.update({ id: 'belief_0000000000', content: 'x' }), /不存在/)
    await assert.rejects(() => library.update({ id: a, content: '信念 B' }), /另一条信念已使用相同内容/)
    await assert.rejects(() => library.update({ id: a, content: '信念 A', confidence: 2 }), /0\.00 到 1\.00/)
    await assert.rejects(() => library.update({ id: a, content: '   ' }), /信念内容不能为空/)

    await seedBelief(service, { id: 'belief_archived', content: '已作废的信念', archivedAt: '2026-10-21T10:00:00+08:00' })
    await assert.rejects(() => library.update({ id: 'belief_archived', content: '改不了' }), /已作废/)
  })
})

test('memory library: search and pagination', async () => {
  await withLibrary(async (library, service) => {
    for (let i = 0; i < 25; i += 1) {
      await seedBelief(service, { id: `belief_page_${i}`, content: `分页信念 ${String(i).padStart(2, '0')}` })
    }
    const first = await library.list({ pageSize: 10 })
    assert.equal(first.total, 25)
    assert.equal(first.pages, 3)
    assert.equal(first.items.length, 10)

    const third = await library.list({ pageSize: 10, page: 3 })
    assert.equal(third.items.length, 5)

    const filtered = await library.list({ query: '分页信念 07' })
    assert.equal(filtered.total, 1)
    assert.equal(filtered.items[0].content, '分页信念 07')

    const missing = await library.list({ query: '不存在的关键词' })
    assert.equal(missing.total, 0)
  })
})

test('memory library: the archived scope filters, it does not delete', async () => {
  await withLibrary(async (library, service) => {
    await seedBelief(service, { id: 'belief_active', content: '活跃信念' })
    await seedBelief(service, { id: 'belief_old', content: '旧信念', archivedAt: '2026-10-21T10:00:00+08:00' })
    assert.equal((await library.list({ scope: 'active' })).total, 1)
    assert.equal((await library.list({ scope: 'archived' })).total, 1)
    assert.equal((await library.list({ scope: 'all' })).total, 2)
    assert.deepEqual((await library.list({})).counts, { active: 1, archived: 1 })
  })
})

test('memory library: deleteBelief removes the belief and its revisions, never the facts', async () => {
  await withLibrary(async (library, service) => {
    // Two facts cited as evidence, one revision: the delete must take the
    // belief and the revision and leave the evidence alone.
    await service.ingestFact({ content: '用户在某个日期确认了协作流程', layer: 'experience', confidence: 0.9 })
    await service.ingestFact({ content: '用户后来又确认了一次该流程', layer: 'experience', confidence: 0.9 })
    const factsBefore = Number((await service.db.get('SELECT COUNT(*) AS n FROM facts', [])).n)
    const id = await seedBelief(service, { content: '待删除的信念', evidenceCount: 2, revision: 1 })
    await service.db.run(
      `INSERT INTO belief_revisions
         (id, belief_id, previous_statement, previous_strength, previous_evidence, reason, trigger_fact_id, created_at)
       VALUES (?, ?, '更早的措辞', 0.5, '[]', 'manual_edit', NULL, '2026-10-20T10:00:00+08:00')`,
      ['rev_delete', id]
    )

    const deleted = await library.deleteBelief({ id })
    assert.equal(deleted.item.id, id)
    assert.equal(deleted.item.deleted_revisions, 1)

    assert.equal((await service.db.get('SELECT COUNT(*) AS n FROM beliefs WHERE id = ?', [id])).n, 0)
    assert.equal((await service.db.get('SELECT COUNT(*) AS n FROM belief_revisions WHERE belief_id = ?', [id])).n, 0)
    assert.equal(Number((await service.db.get('SELECT COUNT(*) AS n FROM facts', [])).n), factsBefore)
    assert.equal((await library.list({ scope: 'all' })).total, 0)

    await assert.rejects(() => library.deleteBelief({ id }), /不存在/)
  })
})

test('prompts: a fresh store is seeded with the hard rules verbatim', async () => {
  await withLibrary(async (library, service) => {
    const page = await library.listPrompts()
    assert.equal(page.kind, 'prompts')
    assert.equal(page.total, 1)
    assert.equal(page.enabled, 1)
    const item = page.items[0]
    assert.equal(item.id, 'user-rules')
    assert.equal(item.title, '用户硬性协作流程')
    assert.equal(item.position, 0)
    assert.equal(item.enabled, true)
    assert.equal(item.chars, RULES.length)
    assert.equal(item.body, RULES)
    assert.equal(page.maxBodyChars, 8000)

    // The preview is the injected text, not a reconstruction.
    assert.equal(page.preview.fallback, false)
    assert.equal(page.preview.name, 'memory-rules')
    assert.equal(page.preview.order, 120)
    assert.equal(page.preview.memoryGuidanceOrder, 150)
    assert.equal(page.preview.chars, RULES.length)
    assert.equal(page.preview.text, RULES)
    assert.deepEqual(
      (await service.db.all('SELECT id FROM prompt_blocks', [])).map((row) => row.id),
      ['user-rules']
    )
  })
})

test('prompts: create, update and delete drive the injection preview', async () => {
  await withLibrary(async (library, service) => {
    const first = await library.createPrompt({ title: '语气偏好', body: '回答先给结论。\n再给理由。', position: 10 })
    const second = await library.createPrompt({ title: '默认追加', body: '末尾追加的块' })
    assert.equal(first.item.position, 10)
    assert.equal(second.item.position, 20, 'a block without a position is appended after the last one')
    assert.equal(first.item.chars, '回答先给结论。\n再给理由。'.length)

    let page = await library.listPrompts()
    assert.equal(page.total, 3)
    assert.equal(page.enabled, 3)
    assert.deepEqual(page.items.map((item) => item.id), ['user-rules', first.item.id, second.item.id])
    assert.equal(page.preview.text, [RULES, '回答先给结论。\n再给理由。', '末尾追加的块'].join('\n\n'))

    // Disabling one block removes it from the injected text but not from the list.
    await library.updatePrompt({ id: first.item.id, enabled: false })
    page = await library.listPrompts()
    assert.equal(page.total, 3)
    assert.equal(page.enabled, 2)
    assert.equal(page.preview.text, [RULES, '末尾追加的块'].join('\n\n'))

    // A no-op save keeps updated_at.
    const before = (await library.listPrompts()).items.find((item) => item.id === second.item.id)
    await library.updatePrompt({ id: second.item.id, body: before.body, title: before.title })
    const after = (await library.listPrompts()).items.find((item) => item.id === second.item.id)
    assert.equal(after.updated_at, before.updated_at)

    // Re-ordering changes the injected order: position 5 puts the last-created
    // block between the seed (0) and the first block (10), and the earlier
    // disabled block comes back once it is enabled again.
    await library.updatePrompt({ id: first.item.id, enabled: true })
    await library.updatePrompt({ id: second.item.id, position: 5 })
    page = await library.listPrompts()
    assert.deepEqual(page.items.map((item) => item.id), ['user-rules', second.item.id, first.item.id])
    assert.equal(page.preview.text, [RULES, '末尾追加的块', '回答先给结论。\n再给理由。'].join('\n\n'))

    // Deleting everything leaves the RULES fallback in the prompt.
    for (const item of page.items) await library.deletePrompt({ id: item.id })
    page = await library.listPrompts()
    assert.equal(page.total, 0)
    assert.equal(page.preview.fallback, true)
    assert.equal(page.preview.text, RULES)
    assert.equal(page.preview.chars, RULES.length)
    assert.equal(Number((await service.db.get('SELECT COUNT(*) AS n FROM prompt_blocks', [])).n), 0)
  })
})

test('prompts: validation rejects empty fields, oversized bodies and bad ordering', async () => {
  await withLibrary(async (library) => {
    await assert.rejects(() => library.createPrompt({ title: '  ', body: 'x' }), /标题不能为空/)
    await assert.rejects(() => library.createPrompt({ title: 'x'.repeat(81), body: 'x' }), /标题不能超过 80/)
    await assert.rejects(() => library.createPrompt({ title: '标题', body: '   ' }), /正文不能为空/)
    await assert.rejects(() => library.createPrompt({ title: '标题', body: 'x'.repeat(8001) }), /正文不能超过 8000/)
    await assert.rejects(() => library.createPrompt({ title: '标题', body: 'x', position: 1.5 }), /排序必须是/)
    await assert.rejects(() => library.createPrompt({ title: '标题', body: 'x', position: -1 }), /排序必须是/)
    await assert.rejects(() => library.updatePrompt({ id: 'prompt_missing', body: 'x' }), /不存在/)
    await assert.rejects(() => library.deletePrompt({ id: 'prompt_missing' }), /不存在/)

    // The body is kept verbatim apart from the outer whitespace.
    const created = await library.createPrompt({ title: ' 保留缩进 ', body: '\n  第一行\n    第二行  \n' })
    assert.equal(created.item.body, '第一行\n    第二行')
    assert.equal(created.item.title, '保留缩进')
  })
})

test('prompts: every successful write refreshes the injection cache hook', async () => {
  let refreshes = 0
  await withLibrary(async (library) => {
    const created = await library.createPrompt({ title: '触发缓存', body: '正文' })
    assert.equal(refreshes, 1, 'create notifies')
    await library.updatePrompt({ id: created.item.id, body: '新正文' })
    assert.equal(refreshes, 2, 'update notifies')
    await library.updatePrompt({ id: created.item.id, body: '新正文' })
    assert.equal(refreshes, 2, 'a no-op update does not notify')
    await library.deletePrompt({ id: created.item.id })
    assert.equal(refreshes, 3, 'delete notifies')
  }, { onPromptsChanged: () => { refreshes += 1 } })
})

test('prompts: the seed is not resurrected after the user deletes it', async () => {
  const ctx = await tempService('prompt-seed')
  const { service, dbFile, dir } = ctx
  const library = new MemoryLibraryService({ ready: Promise.resolve(service), logger: silent })
  await library.deletePrompt({ id: 'user-rules' })
  assert.equal((await library.listPrompts()).total, 0)
  await service.close()

  // Reopen the same file: the seed marker means "offered once", so a deliberate
  // deletion sticks and the prompt falls back to the built-in text instead.
  const reopened = await openMemoryService({ memoryDir: dir, dbFile, logger: silent, markdownMirror: false })
  try {
    assert.equal(Number((await reopened.db.get('SELECT COUNT(*) AS n FROM prompt_blocks', [])).n), 0)
    assert.notEqual((await reopened.db.get("SELECT value FROM meta WHERE key = 'prompt_blocks_seeded'", []))?.value, undefined)
  } finally {
    await reopened.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
