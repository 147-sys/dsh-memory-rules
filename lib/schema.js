/*!
 * dsh-memory-rules — generated schema module. DO NOT EDIT BY HAND.
 *
 * Generated from `sql/schema.sql` by `node tools/build-schema.mjs`.
 * `test/step1.test.js` fails when this file and the SQL file disagree, so the
 * SQL file stays the human-readable source of truth and this module stays the
 * one the runtime actually executes.
 */

/** Fingerprint of {@link SCHEMA_SQL}; stored in `meta` to detect drift. */
export const SCHEMA_VERSION = 'edf574fdd585b7b1'

/** Executable DDL (comments stripped), in dependency order. */
export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
















CREATE TABLE IF NOT EXISTS facts (
  id             TEXT PRIMARY KEY,
  content        TEXT NOT NULL,
  source_session TEXT,
  created_at     TEXT NOT NULL,
  layer          TEXT NOT NULL DEFAULT 'experience',
  confidence     REAL NOT NULL DEFAULT 0.6,
  tags           TEXT NOT NULL DEFAULT '[]',


  raw_quote      TEXT,

  origin         TEXT NOT NULL DEFAULT 'assistant',



  superseded_by  TEXT,







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


















CREATE TABLE IF NOT EXISTS beliefs (
  id             TEXT PRIMARY KEY,
  topic          TEXT NOT NULL,
  statement      TEXT NOT NULL,
  evidence_ids   TEXT NOT NULL DEFAULT '[]',
  evidence_count INTEGER NOT NULL DEFAULT 0,
  strength       REAL NOT NULL DEFAULT 0.5,
  updated_at     TEXT NOT NULL,
  created_at     TEXT NOT NULL,

  layer          TEXT NOT NULL DEFAULT 'experience',
  revision       INTEGER NOT NULL DEFAULT 0,
  archived_at    TEXT,


  priority       TEXT NOT NULL DEFAULT 'normal',
  CHECK (layer IN ('world', 'experience'))
);

CREATE INDEX IF NOT EXISTS idx_beliefs_topic ON beliefs (topic);
CREATE INDEX IF NOT EXISTS idx_beliefs_strength ON beliefs (strength DESC);
CREATE INDEX IF NOT EXISTS idx_beliefs_updated ON beliefs (updated_at DESC);











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




CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);




















CREATE TABLE IF NOT EXISTS prompt_blocks (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);



CREATE INDEX IF NOT EXISTS idx_prompt_blocks_order ON prompt_blocks (position, created_at, id);
`
