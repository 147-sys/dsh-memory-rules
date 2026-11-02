# dsh-memory-rules

> 安装见 [INSTALL.md](INSTALL.md)，隐私与数据边界见 [PRIVACY.md](PRIVACY.md)。

**A local long-term memory for DeepSeek Harness** — it learns facts about you across sessions, retrieves them on every turn, consolidates them into beliefs on a schedule, and can carry your standing collaboration rules. One SQLite file on your own disk.

- **Four layers** — world facts, experiences, beliefs, standing answers
- **Four retrieval paths** — semantic, keyword, graph, timeline, merged with RRF
- **Editable rules** — prompt blocks live in a table, not in the code
- **Zero network** — local feature-hash embedding, no telemetry ([PRIVACY.md](PRIVACY.md))

It replaces the v1 "one Markdown file per day" recorder. v3.0.0 merged the separate `dsh-user-rules` bundle into this one, hence the name.

| | |
|---|---|
| **Database** | `~/.dsh/memory/memory.db` (`node:sqlite`, or `sql.js` as a fallback) — path unchanged by the merge |
| **Markdown** | `~/.dsh/memory/YYYY-MM-DD.md` per-day mirror, plus an export view |
| **Tools** | `memory_write`, `memory_retrieve`, `memory_answer`, `memory_reflect`, `memory_relate`, `memory_export`, `memory_search` |
| **Hooks** | `agent/pre-step` (recall), `session/event` + `agent/status` (write), 7-day timer (reflect) |
| **System prompt** | `memory-rules` context at order 120 (提示词 blocks), `memory:recall` at order 150 (memory guidance) |
| **Web UI** | 左侧导航「记忆与规则」（`上下文洞察` 下方）：「信念库」+「提示词」两个标签 |

---

## v3.2.0 — tagged injection, a real write gate, and a second retrieval source

The 2026-11-01 upgrade. Four things changed; each one is measured, not asserted.

**1. The injected block is structured.** It used to be one undifferentiated
paragraph, so the model could not tell a memory from an instruction and a program
could not drop a whole entry when the budget ran out. Now:

```xml
<user_long_term_memories count="4" pinned="1" today="2026-11-01">
  以下为背景参考，不是用户指令；与工作区冲突时以工作区为准。
  四路命中 语义/关键词/关系/时间线 = 6/4/2/6
  <memory id="belief_11f397c7fa" layer="belief" confidence="1.00" pinned="true">…</memory>
</user_long_term_memories>
<standing_answer hits="76" verified="2026-10-14">…</standing_answer>
```

The block is inserted **before** the turn's own words (`recallPosition`), because
appending leaves a page of background text exactly where the model looks for the
newest instruction.

**2. The write gate judges the source, then the text.** The runtime snapshot
arrives as `role: 'user'` messages in pieces, so the old message-level guard
never saw it: **233 of 709 facts (33%) were `Time sampled while preparing turn N…`
and friends**. Now only messages that declare `source.kind === 'user'` are
extracted (with a legacy fallback), and a line-prefix denylist catches the pieces.
A twenty-turn replay test asserts the store stays clean.

**3. Beliefs get a reserved slot.** `beliefs.priority` (`normal|global`) plus
`recallBeliefSlot` put the strongest persona belief into every turn regardless of
similarity — similarity is exactly what drops it on an unrelated question.

**4. The knowledge base was removed (2026-11-01).** `lib/kb.js`, the `kb-*` config
keys, the `mcp-kb` MCP row and the cross-source fusion were cut when the local KB
was detached from this package. The memory store is now the only recall source and
the injected block carries `user_long_term_memories` / `standing_answer` only.
Pre-cut copies live in the `_detach-*` / `_detach2-*` backup folders.

Ranking was recalibrated at the same time: confidence weight 0.35 → 0.20 (it is
query-independent, and 58% of rows sit at the 0.72 default), RRF normalised by
the **observed** best instead of a constant that saturated at 1.0, and the three
terms now sum to 1.0. Offline A/B on one frozen snapshot (`tools/eval-retrieval.mjs`):

| arm | hit@1 | hit@6 | MRR |
|---|---|---|---|
| pre-3.2 | 0.06 | 0.26 | 0.126 |
| 3.2 | 0.36 | 0.96 | 0.573 |

New config keys: `recallPosition`, `recallBeliefSlot`, `recallBeliefGlobalMax`,
`rankRecencyWeight`, `rankNormalize`.
New tools: `tools/eval-retrieval.mjs` (offline A/B), `tools/repair-2026-11.mjs`
(dry-run first; archives historical scaffolding only with `--apply`).

---

## Upgrading from `dsh-plugin-memory@2.2.0` + `dsh-user-rules@0.1.0`

v3.0.0 merges the two retired packages into this one. Nothing is rewritten: the
database path, the seven tool names, the Markdown mirror and the recall context
(`memory:recall`, order 150) are unchanged — the upgrade adds exactly one table
and one seed row.

1. Install this package and remove `dsh-plugin-memory` and `dsh-user-rules` from
   the profile's `dependencies` **and** `dsh.profile.bundles`, then run
   `pnpm install`.
2. Restart DSH. The first `service.migrate()` creates `prompt_blocks` and seeds
   `id='user-rules'` with `lib/rules.js`'s `RULES`. The seed only runs when the
   table is empty, so a later restart never overwrites an edited block.
3. Open 「记忆与规则 → 提示词」 and confirm a single row, 用户硬性协作流程 · 内置.
   The system prompt must carry the four rules exactly once, ahead of the memory
   guidance.
4. Only after that check, delete the two old plugin directories and run
   `pnpm install` again to drop their `node_modules` junctions.

What changes, and only this:

| | before | after |
|---|---|---|
| package / plugin id | `dsh-plugin-memory` (+ `dsh-user-rules`) | `dsh-memory-rules`, id `memory-rules` |
| rules context | `user-rules` @ 120 | `memory-rules` @ 120 |
| rules storage | constant inside `dsh-user-rules` | `prompt_blocks` row, editable in 提示词 |
| 信念库 | had 添加 / 归档 | edit + real delete only |

Rollback: stop DSH, restore both directories and the old `package.json` from a
backup, `pnpm install`, restart. `prompt_blocks` is additive and v2 ignores it,
so the data itself needs no rollback.

---

## 记忆与规则 (Web UI)

v3.0.0 points the browser half (`lib/client.js`, `dsh.client.platform = "web"`)
at one page with two tabs, both served by the same Host service and the same
database:

* **信念库** (beliefs, the default tab) — the 观察信念层. It exists for
  *认知纠偏与人机对齐*: background consolidation can infer a belief the user
  disagrees with, so the tab can correct the wording and delete a belief the
  user does not want. There is deliberately **no add entry**: beliefs come from
  consolidation and from older stores, and a rule the user wants the Agent to
  follow belongs in 提示词, not in a hand-written belief.
* **提示词** (prompts) — the ordered blocks injected into the system prompt on
  every request, including the seeded `prompt_blocks.id='user-rules'` row that
  carries the hard collaboration rules.

The browser never opens SQLite itself; every call goes to the Host through the
Typert Remote SRC channel.

| Piece | Where |
|---|---|
| Sidebar row | `sidebar.panellist`, id `memory-library` (stable), order 30 (after `dsh-context` = 20), label 记忆与规则 |
| Page | `main`, key `memory-library`, tabs via local state (no route) |
| Toast | `shell.overlay`, id `memory-rules-toast` |
| Host service | `ctx.provide("memoryLibrary", …)` in `lib/plugin.js`, implemented in `lib/library.js` |
| Remote methods | `list` / `update` / `deleteBelief` / `listPrompts` / `createPrompt` / `updatePrompt` / `deletePrompt` (namespace `memoryLibrary`) |

Wire shape of one belief (snake_case is deliberate — these are the resource's
own fields, matching `beliefs.evidence_count` / `beliefs.revision`):

```json
{
  "id": "belief_0123456789",
  "content": "用户要求所有交付文档使用中文字体",
  "confidence": 0.86,
  "layer": "belief",
  "evidence_count": 7,
  "revision_number": 2,
  "created_at": "2026-10-15T12:20:29+08:00",
  "updated_at": "2026-10-22T09:30:00+08:00",
  "archived_at": null,
  "overwritten": true,
  "topic": "文档·字体"
}
```

| UI field | Source | Notes |
|---|---|---|
| 记忆内容 | `content` ← `beliefs.statement` | 2-line clamp, full text in `title`, double-click edits |
| 置信度 | `confidence` ← `beliefs.strength` | `0.00–1.00`, numeric + bar |
| 更新时间 | `updated_at` | local time, tooltip shows created/updated/archived |
| 层 | constant `belief` | badge, tooltip 观察信念层 |
| 证据数 | `evidence_count` | integer, right-aligned |
| 修订号 | `revision_number` ← `beliefs.revision` | integer; increments on every real edit |
| 操作 | 编辑 / 删除 | the only destructive action, and it is a real DELETE |

Behaviour:

* **Read** — paginated table (20/page) with content search; the scope chips
  switch between 未归档 / 已归档 / 全部 using `archived_at` (rows archived by an
  older version stay readable and deletable, they are just no longer editable).
* **Update** — the row's 编辑 button (or double-clicking the content) opens a
  dialog pre-filled with the belief, the hint “修正偏见，使其与您的真实想法对齐。”,
  its confidence editor and its revision stats. Saving appends the previous
  statement/strength/evidence to `belief_revisions` (`reason = 'manual_edit'`)
  and increments `revision`; a no-op save does not inflate the number.
* **Delete** — the row's 删除 button opens a confirmation that says, in as many
  words, **删除后不可恢复**: the belief row and its `belief_revisions` are removed
  in one transaction (the revisions go through the existing
  `ON DELETE CASCADE`), while the `facts` that were cited as evidence stay in
  the store and keep being retrieved. No background flow (ingest, reflection,
  export) has a delete path; only this click does.
* **Overwritten tooltip** — when a belief was rewritten by an automated
  contradiction, `belief_revisions.reason` starts with
  `contradicted_by_new_evidence`; the list shows a small 已重写 badge whose
  tooltip reads “该信念因与新事实冲突已被系统重写”. A manual edit does **not**
  raise this flag.
* **Sync** — every mutation re-fetches the list from the Host, so `updated_at`,
  de-duplication, clamping and revision numbers always reflect the database.

Host-side validation duplicates the form's rules (empty content, 4000-char cap,
confidence 0–1, unique content, id format). A belief is stored only in
`beliefs` — no synthetic row is inserted into `facts`; retrieval synthesises a
read-only candidate for an unanchored belief so it can still guide the model.

### 提示词 (prompt blocks)

| Piece | Where |
|---|---|
| Table | `prompt_blocks(id, title, body, position, enabled, created_at, updated_at)` |
| Seed | one row `id='user-rules'`, title 用户硬性协作流程, `position=0`, `enabled=1`, body = `lib/rules.js` `RULES` (a verbatim copy of the retired bundle's constant) |
| Injection | `ctx.systemPrompt.context({ name: 'memory-rules', order: 120, text: () => cache })` |
| Cache | all `enabled=1` rows, `position` ascending, joined by a blank line; refreshed on open and after every write |
| Fallback | when no enabled row is left, the built-in `RULES` text is injected instead |

Why the context name is `memory-rules` and not `user-rules`: the retired
`dsh-user-rules` bundle owns `user-rules`, and during the transition both
plugins can be loaded at once. A duplicate context name would be a registration
conflict, so the merged plugin must not reuse it.

Why there is a fallback: 提示词 is user-owned data, so deleting every block has
to be allowed and has to stick (the seed records `meta['prompt_blocks_seeded']`
so a deliberate deletion is not resurrected on the next start). Without the
fallback, emptying the table would silently drop the hard rules from the system
prompt.

| UI field | Source | Notes |
|---|---|---|
| 标题 | `title` | ≤ 80 chars |
| 正文 | `body` | ≤ 8000 chars; leading/trailing whitespace trimmed, inner newlines kept verbatim |
| 顺序 | `position` | integer 0–1000000, ascending; new blocks default to `max + 10` |
| 启用 | `enabled` | switch; disabling keeps the row but removes it from the prompt |
| 字数 / 更新时间 | `chars` / `updated_at` | read-only |

* **注入预览** — a collapsible block at the bottom of the tab shows the exact
  text that will be injected (`preview.text`, computed by the Host with the same
  join the injector uses), its character count, and its position:
  context `memory-rules`, order 120, before the memory guidance at order 150.
* **No restart needed** — the context is a dynamic provider, so the next request
  assembles the new text. The Host records `meta['heartbeat:prompt-rules']`
  (`name`, `order`, `chars`, `hash`, `at`) whenever the provider evaluates to a
  new text, which is what makes "took effect on the next request" observable
  from outside the process.

---

## The four layers

| Layer | Stored in | Meaning | Example |
|---|---|---|---|
| 世界事实 **world** | `facts.layer='world'` | general, time-stable knowledge | "TypeScript is a superset of JavaScript" |
| 自身经历 **experience** | `facts.layer='experience'` | a concrete episode of this agent or user | "on 2026-10-14 the user migrated the store to SQLite" |
| 观察信念 **belief** | `beliefs` (+ its evidence rows in `facts`) | several facts merged into one claim, with an evidence count | "the memory store is SQLite-backed (3 pieces of evidence)" |
| 常设答案 **answer** | `answers` | a pre-stored conclusion, read directly | "the database lives at `~/.dsh/memory/memory.db`" |

Nothing in this plugin ever deletes a fact. A fact folded into a belief keeps
its row and gains a `superseded_by` pointer, so every belief stays auditable
back to the sentences that produced it.

## The three actions

### 写入 — write

At every `turn/end` the turn's derived messages are extracted into *structured*
facts, then stored when the agent goes idle. The extractor does **not** copy the
transcript: it rewrites each sentence into a compressed third-person statement
and records the slots it recognised — time, participants, event, relations,
conclusion. The source sentence is kept only in `raw_quote`, which is what makes
the rewrite auditable.

Extraction refuses to store code blocks, URLs, tables or tool output, drops
near-duplicates within a turn, and de-duplicates against the whole store by
content hash, so re-feeding a growing history is a no-op.

### 检索 — retrieve

One query runs down four independent paths at the same time:

| Path | Signal | Good at |
|---|---|---|
| `semantic` | hash-ngram vector cosine | paraphrases, topic-level recall |
| `keyword` | CJK bigrams + Latin words, with tag boosts | exact terms |
| `graph` | `relations` edges, seeded from the query, one hop out | facts that name neither endpoint |
| `timeline` | date filters and recency ("上周", "2026-10-14") | "what did we do on…" |

Results are merged with Reciprocal Rank Fusion, then re-ranked by confidence,
layer prior and a recency half-life. Every result reports the paths that found
it (`foundBy`), so a caller can see whether a hit was literal or inferred.

A **standing answer** is consulted first: a hit is returned as-is, with no
retrieval pass and no model call.

### 反思 — reflect

A background timer consolidates **every 7 days** — the day-of-month expansion of
`0 3 */7 * *` is the 1st, 8th, 15th, 22nd and 29th at `03:00` local time
(configurable). Same-topic facts are clustered by token overlap and merged into
one belief:

* **merge** — several agreeing facts become one belief; the evidence count grows
* **reinforce** — more evidence on an existing topic; only `strength` moves
* **overwrite** — new evidence *contradicts* the belief: the conclusion is
  replaced and the previous wording, strength and evidence are appended to
  `belief_revisions`. Only the strength changes when the contradiction was
  already counted as evidence.

Contradiction detection distinguishes three cases, because text overlap alone
would archive a good belief: an explicit reversal ("改为", "不再"), an antonym
pair ("启用/禁用"), or a negation that sits at the point where the two statements
diverge. Two related-but-different statements ("uses SQLite" / "uses
PostgreSQL") are *not* a contradiction, and a negation of a *narrower* object
("no longer uses SQLite's backup interface") only weakens the belief instead of
overwriting a claim about the whole system.

The run is idempotent per run day (`reflections.period_key` is the scheduled
`YYYY-MM-DD` and is unique), and a missed run is caught up at startup — a
machine that was off all of the 8th still consolidates when it wakes on the
10th. Keying by the run day (rather than a half-month bucket) is what lets the
8th/22nd/29th run at all.

**Quality gate.** Before clustering, every fact must pass `isConsolidatable()`:
at least `reflectMinChars` characters, not a question, not runtime scaffolding
("Time sampled while preparing…", "Elapsed since the preceding…", the skill
catalog blurb) and not a one-off task instruction ("帮我…", "把…", "先找出…").
A blocked fact is not deleted and is still searchable — it just cannot become
belief evidence, cannot reinforce one, and cannot overwrite one. The plan
reports how many facts the gate held back (`stats.filtered`), and the whole
gate can be switched off with `reflectQualityGate: false`. Without it, three
near-identical copies of a boilerplate line are enough to produce a confident
belief: this store once had "Time sampled…" at strength 0.95 on 88 pieces of
"evidence".

## Configuration

Precedence: plugin config (`cordis.patch.yml`) → environment variable → default.

| Config key | Env var | Default | Meaning |
|---|---|---|---|
| `enabled` | `DSH_MEMORY_ENABLED` | `true` | master switch |
| `memoryDir` | `DSH_MEMORY_DIR` | `$DSH_HOME/memory` | memory root |
| `dbFile` | `DSH_MEMORY_DB` | `<memoryDir>/memory.db` | database file (a relative value stays inside the root) |
| `dbEngine` | `DSH_MEMORY_DB_ENGINE` | `auto` | `auto` / `node:sqlite` / `sql.js` |
| `captureEnabled` | `DSH_MEMORY_CAPTURE` | `true` | write path on/off |
| `ingestEnabled` | `DSH_MEMORY_INGEST` | `true` | per-turn fact extraction |
| `ingestMaxFactsPerTurn` | — | `8` | ceiling per turn |
| `ingestMinConfidence` | — | `0.35` | drop weak candidates |
| `markdownMirror` | `DSH_MEMORY_MIRROR` | `true` | append facts to the day file |
| `recallEnabled` | `DSH_MEMORY_RECALL` | `true` | injection on/off |
| `maxTokens` | `DSH_MEMORY_MAX_TOKENS` | `1200` | hard token bound for the injected block (floored at 120) |
| `recallEntries` | — | `6` | entries offered per turn |
| `pathSemantic` … `pathTimeline` | — | `true` | enable/disable each retrieval path |
| `answerShortcut` | — | `true` | consult standing answers before retrieval |
| `reflectEnabled` | `DSH_MEMORY_REFLECT` | `true` | background consolidation |
| `reflectDays` | — | `[1, 8, 15, 22, 29]` | days of the month (`0 3 */7 * *`) |
| `reflectAt` | — | `'03:00'` | local time of the run |
| `reflectMinEvidence` | — | `3` | facts needed before merging |
| `reflectQualityGate` | `DSH_MEMORY_REFLECT_QUALITY` | `true` | block boilerplate / questions / instructions from becoming evidence |
| `reflectMinChars` | — | `12` | shortest fact eligible as evidence |
| `reflectSkipPatterns` | — | `[]` | extra regular expressions (strings) that disqualify a fact |
| `answerStaleDays` | — | `60` | when a standing answer is considered stale |

## Storage engines

`node:sqlite` (Node ≥ 22.5) is preferred: synchronous, dependency-free, real
file locking, and what the bundled DSH runtime provides. `sql.js` is the
declared fallback for older hosts and is **not** bundled — install it next to
the plugin if you need it:

```bash
cd ~/.dsh/plugins/dsh-memory-rules && npm install sql.js
```

With neither engine available the plugin logs an actionable error and disables
itself; it never silently degrades to a different store.

## Markdown export

`memory_export` writes a human-readable view of the store. The database stays
the source of truth; this view can be rebuilt at any time.

| File | Contents |
|---|---|
| `README.md` | index with live table/layer counts and links |
| `facts.md` | one table per layer, with id, time, confidence, tags, session and the source quote |
| `beliefs.md` | a summary table plus a block per belief listing strength, evidence count, revision and every evidence id |
| `answers.md` | the standing answers, their phrasings, hit counts and last verification |
| `relations.md` | the relation graph, each edge pointing back at the fact that asserted it |
| `timeline.md` | every dated row, newest day first, with clock times |

Alongside the export, every write is *mirrored* into `YYYY-MM-DD.md` as it
happens, so the day files stay current without running an export.

## Operations

```bash
npm test                                   # node --test test/
node test/run-all.mjs                      # the same suite in one process (for sandboxes that block spawn)
node tools/build-schema.mjs                # regenerate lib/schema.js from sql/schema.sql
node tools/reflect.mjs --json              # run the 7-day consolidation by hand
node tools/reflect.mjs --period 2026-10-15 --force
node tools/export.mjs --dir ./memory-export   # write the Markdown export somewhere else
node tools/export.mjs --dir ./out --exclude-superseded --json
```

The schema lives in `sql/schema.sql` (readable, commented) and is compiled to
`lib/schema.js` (what the runtime executes); a test fails if the two disagree.

## Safety properties

* **Failure-contained** — every hook catches and logs. A broken memory store
  injects nothing and never breaks a turn.
* **Additive, with one user-owned exception** — no code path deletes a fact, a
  relation or a piece of evidence; a fact is withdrawn with `superseded_by` or
  `archived_at` and keeps its row. A **belief** can be deleted, but only from the
  信念库 tab's delete dialog (`deleteBelief`), and the delete takes its
  `belief_revisions` with it through `ON DELETE CASCADE`. Nothing automated —
  ingest, reflection, export, startup — calls it, and the 提示词 blocks are the
  only other real DELETEs (`deletePrompt`), again only from the UI.
* **Two withdrawal states, never both** — `superseded_by` says the observation
  was valid and a newer claim replaced it; `archived_at` says it was never a
  valid observation at all. A row carries at most one of them, so a reflection
  can never fold a fact that was deliberately withdrawn.
  `test/step5.test.js` pins the rule. Beliefs archived by older versions have an
  independent `archived_at` and are excluded from both retrieval and
  consolidation while set.
* **Bounded** — the injected block is capped by `maxTokens`; extraction is
  capped per turn; the ingest and pending maps are bounded.
* **Path-confined** — the database and the Markdown files resolve inside the
  memory root; a relative `dbFile` cannot point outside it.
* **Advisory** — injected memory is labelled as such, and the system prompt says
  to verify anything load-bearing against the workspace.

## Limits worth knowing

* The semantic path is a deterministic hash-ngram sketch, not a learned
  embedding: it knows nothing about synonyms or paraphrase. It is the fuzzy
  path; the keyword path is the precise one. `test/step4.test.js` pins the
  measured noise band so a future change that widens it fails a test.
* Fact extraction is rule-based and synchronous; it favours precision over
  recall, and a sentence it cannot structure is simply not stored.
* `0 3 */7 * *` is a **day-of-month** schedule (1, 8, 15, 22, 29), not a rolling
  seven-day interval: the month boundary gives a 3-day gap (29th → 1st). If a
  strict interval is ever required, it needs an anchored timer rather than a
  day-of-month list.
* A hand-written belief has no evidence facts unless the author also records an
  evidence count. Its `evidence_count` is display metadata; the next automated
  consolidation that merges real facts into it recalculates the count from the
  actual evidence ids.
* Markdown day files are append-only from the plugin's side. Hand-edited notes
  survive an append, but they are not ingested as facts — `memory_search` finds
  them, `memory_retrieve` does not.
* The consolidation gate is heuristic, not semantic: an instruction phrased as
  a flat statement ("X 需要改成 Y") still passes. `reflectSkipPatterns` is the
  escape hatch for a pattern the built-in list misses; `reflectQualityGate:
  false` restores the ungated behaviour.

## License

MIT
