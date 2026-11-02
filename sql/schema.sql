-- dsh-memory-rules — local memory service schema (authoritative SQL file).
--
-- This file is the human-readable copy of the DDL. The runtime loads the
-- identical statements from `lib/schema.js` (so the plugin carries no
-- read-at-startup dependency on this file); `test/schema.test.js` asserts that
-- the two stay byte-for-byte equivalent, so an edit here that is not mirrored
-- there fails the test suite instead of silently drifting.
--
-- Storage engines: `node:sqlite` (Node >= 22.5, preferred) or `sql.js`
-- (WASM fallback). Only features both engines share are used: ordinary tables,
-- ordinary indexes, CHECK constraints and foreign keys. In particular this
-- schema deliberately avoids FTS5 and `CREATE VIRTUAL TABLE`, because `sql.js`
-- cannot be assumed to ship those modules.
--
-- Tens of thousands of facts are expected, so every search path is answered
-- from an index and the app-side filter is a single full scan at most.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- facts — the atomic, extracted memory. Four layers share this table:
--
--   world      世界事实   general, stable knowledge ("TypeScript is a
--                         superset of JavaScript")
--   experience 自身经历   a concrete episode of this agent or this user
--                         ("2026-10-14 the user reworked the Agnes keys")
--   belief     观察信念   a fact that has been consolidated into `beliefs`
--                         (kept, never deleted, and reachable from the belief)
--   answer     常设答案   a fact that was promoted into `answers`
--
-- `relations` carries the graph edges; `embedding` carries the hash-ngram
-- vector used by the semantic search path. Both are denormalised on purpose so
-- a fact is complete in one row.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS facts (
  id             TEXT PRIMARY KEY,
  content        TEXT NOT NULL,
  source_session TEXT,
  created_at     TEXT NOT NULL,
  layer          TEXT NOT NULL DEFAULT 'experience',
  confidence     REAL NOT NULL DEFAULT 0.6,
  tags           TEXT NOT NULL DEFAULT '[]',
  -- Non-null only when this row is the verbatim, untrimmed source sentence
  -- that was rewritten into `content`. It is what makes "不照搬原文" auditable.
  raw_quote      TEXT,
  -- Extraction provenance: "user" | "assistant" | "manual" | "reflect".
  origin         TEXT NOT NULL DEFAULT 'assistant',
  -- 0 = active. Non-zero on facts that a reflection folded into a belief; the
  -- fact stays in the table (evidence is never deleted) and is de-prioritised
  -- in retrieval instead of disappearing.
  superseded_by  TEXT,
  -- Non-null when the row was withdrawn because the *extraction* was wrong
  -- rather than because a newer claim replaced it: a fragment of the injected
  -- runtime context, a sentence broken by the noise stripper, a truncated
  -- fragment. Distinct from `superseded_by` on purpose — a superseded fact is
  -- evidence for a belief and must stay retrievable, an archived one never was
  -- a valid observation and must not be. `tools/cleanup.mjs` sets it and writes
  -- the audit trail; nothing else in the plugin does.
  archived_at    TEXT,
  embedding      TEXT,
  updated_at     TEXT,
  CHECK (layer IN ('world', 'experience', 'belief', 'answer'))
);

CREATE INDEX IF NOT EXISTS idx_facts_layer_created ON facts (layer, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_facts_created ON facts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_facts_confidence ON facts (confidence DESC);
CREATE INDEX IF NOT EXISTS idx_facts_session ON facts (source_session);
CREATE INDEX IF NOT EXISTS idx_facts_superseded ON facts (superseded_by);

-- ---------------------------------------------------------------------------
-- beliefs — consolidated beliefs (观察信念).
--
-- One row is one surviving statement about one topic. `evidence_ids` is a JSON
-- array of `facts.id`; it only ever grows. `strength` is the live strength
-- (0..1) and is adjusted by later evidence; `evidence_count` is kept as a
-- column so retrieval can weight a belief without parsing the JSON.
-- `revision` is the revision number: it counts how many times the statement
-- was overwritten or manually corrected; the superseded wording, strength and
-- evidence live in `belief_revisions`.
--
-- `archived_at` is the human "作废" marker set from the 记忆库 panel. It is
-- deliberately not a delete: the row, its evidence ids and every revision stay
-- readable for audit, but an archived belief is excluded from retrieval and
-- from the consolidation pass. It is also distinct from `revision`: a belief
-- can have been rewritten and still be active.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS beliefs (
  id             TEXT PRIMARY KEY,
  topic          TEXT NOT NULL,
  statement      TEXT NOT NULL,
  evidence_ids   TEXT NOT NULL DEFAULT '[]',
  evidence_count INTEGER NOT NULL DEFAULT 0,
  strength       REAL NOT NULL DEFAULT 0.5,
  updated_at     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  -- Which fact layer feeds this belief: 'world' or 'experience'.
  layer          TEXT NOT NULL DEFAULT 'experience',
  revision       INTEGER NOT NULL DEFAULT 0,
  archived_at    TEXT,
  -- 'global' marks a belief that must be injected every turn regardless of
  -- similarity; 'normal' competes for a slot like any other memory.
  priority       TEXT NOT NULL DEFAULT 'normal',
  CHECK (layer IN ('world', 'experience'))
);

CREATE INDEX IF NOT EXISTS idx_beliefs_topic ON beliefs (topic);
CREATE INDEX IF NOT EXISTS idx_beliefs_strength ON beliefs (strength DESC);
CREATE INDEX IF NOT EXISTS idx_beliefs_updated ON beliefs (updated_at DESC);
-- `idx_beliefs_priority` is created by the migration, not here: on a store that
-- predates the column, an index in this file would run before the ALTER and the
-- whole open would fail with "no such column: priority".

-- ---------------------------------------------------------------------------
-- answers — standing answers (常设答案).
--
-- A hit here is answered straight from the row: no retrieval pass and no model
-- call. `question_pattern` holds normalised question variants (JSON array of
-- strings) so one standing answer can cover several phrasings.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS answers (
  id               TEXT PRIMARY KEY,
  question_pattern TEXT NOT NULL,
  cached_answer    TEXT NOT NULL,
  last_verified    TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  hits             INTEGER NOT NULL DEFAULT 0,
  confidence       REAL NOT NULL DEFAULT 0.9,
  source_fact_ids  TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_answers_verified ON answers (last_verified DESC);

-- ---------------------------------------------------------------------------
-- relations — the relation graph, one row per (subject, predicate, object).
--
-- `source_fact_id` ties the edge to the fact that asserted it, so a belief can
-- always be walked back to the raw evidence. An edge with a NULL
-- `source_fact_id` is a user-declared edge (`memory_relate`).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS relations (
  id             TEXT PRIMARY KEY,
  subject        TEXT NOT NULL,
  predicate      TEXT NOT NULL,
  "object"       TEXT NOT NULL,
  source_fact_id TEXT REFERENCES facts (id) ON DELETE CASCADE,
  created_at     TEXT NOT NULL,
  confidence     REAL NOT NULL DEFAULT 0.6
);

CREATE INDEX IF NOT EXISTS idx_relations_subject ON relations (subject);
CREATE INDEX IF NOT EXISTS idx_relations_object ON relations ("object");
CREATE INDEX IF NOT EXISTS idx_relations_predicate ON relations (predicate);
CREATE INDEX IF NOT EXISTS idx_relations_fact ON relations (source_fact_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_relations_edge ON relations (subject, predicate, "object", IFNULL(source_fact_id, ''));

-- ---------------------------------------------------------------------------
-- belief_revisions — append-only audit of every overwrite.
--
-- Requirement: "只更新强度或覆写结论，不删原始事实". When a new fact conflicts
-- with a belief, the belief's statement is replaced and the previous wording,
-- strength and evidence are appended here first. Nothing is ever removed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS belief_revisions (
  id                TEXT PRIMARY KEY,
  belief_id         TEXT NOT NULL REFERENCES beliefs (id) ON DELETE CASCADE,
  previous_statement TEXT NOT NULL,
  previous_strength REAL NOT NULL,
  previous_evidence TEXT NOT NULL DEFAULT '[]',
  reason            TEXT NOT NULL,
  trigger_fact_id   TEXT,
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_belief_revisions_belief ON belief_revisions (belief_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- reflections — one row per background consolidation run (every 7 days).
-- `period_key` is the scheduled run's local day (`YYYY-MM-DD`); the unique
-- index makes the run idempotent, so a restart cannot consolidate the same
-- run twice, while the 8th/15th/22nd/29th each get their own key.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reflections (
  id           TEXT PRIMARY KEY,
  period_key   TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  kind         TEXT NOT NULL DEFAULT 'scheduled',
  merged       INTEGER NOT NULL DEFAULT 0,
  overwritten  INTEGER NOT NULL DEFAULT 0,
  reinforced   INTEGER NOT NULL DEFAULT 0,
  scanned      INTEGER NOT NULL DEFAULT 0,
  topics       INTEGER NOT NULL DEFAULT 0,
  notes        TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reflections_period ON reflections (period_key, kind);

-- ---------------------------------------------------------------------------
-- meta — schema version and small service-level counters.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- prompt_blocks — 提示词 (prompt blocks) injected into the system prompt.
--
-- This table is the successor of the standalone `dsh-user-rules` bundle: the
-- user's hard collaboration rules used to live in that package as a constant and
-- entered the prompt through a `user-rules` context at order 120. They now live
-- here as the seeded row `id='user-rules'`, are editable from the Web UI, and are
-- injected through the `memory-rules` context (order 120) so they still read
-- before the memory guidance (order 150).
--
-- Storage rules:
--
--   * `body` is inserted verbatim and joined in `position` order with a blank
--     line; only rows with `enabled = 1` are injected;
--   * one body is capped at 8000 characters by the Host API (the UI mirrors the
--     same limit) — the injection is paid for on every request;
--   * deletion is a real DELETE and is only reachable from the Web UI. No
--     background flow (ingest, reflection, export) ever deletes a row here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS prompt_blocks (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Injection order is `position` first; the other two columns only break ties so
-- the assembled prompt is stable across reads and restarts.
CREATE INDEX IF NOT EXISTS idx_prompt_blocks_order ON prompt_blocks (position, created_at, id);
