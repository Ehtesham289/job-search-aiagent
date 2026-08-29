-- Durable run state, checkpoints, and the long-term memory that makes the
-- next run start better than the last one (§2.9).
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  brief         TEXT NOT NULL,
  status        TEXT NOT NULL,
  budget        TEXT NOT NULL,        -- JSON Budget
  plan          TEXT,                 -- JSON TaskGraph
  blackboard    TEXT NOT NULL,        -- JSON, the shared run state
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- §4 idempotency keys: a resumed run reads committed results instead of
-- re-doing the work (and re-paying for it).
-- Keyed by (run_id, idempotency_key), not by the key alone: the key identifies
-- a node within a plan, so an unscoped key would let a brand-new run silently
-- replay a previous run's results instead of doing the work.
CREATE TABLE IF NOT EXISTS node_results (
  run_id          TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  node_id         TEXT NOT NULL,
  kind            TEXT NOT NULL,
  status          TEXT NOT NULL,
  result          TEXT NOT NULL,      -- JSON
  created_at      TEXT NOT NULL,
  PRIMARY KEY (run_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_node_results_run ON node_results(run_id);

CREATE TABLE IF NOT EXISTS traces (
  run_id              TEXT NOT NULL,
  seq                 INTEGER NOT NULL,
  node_id             TEXT NOT NULL,
  kind                TEXT NOT NULL,
  agent               TEXT NOT NULL,
  model               TEXT,
  status              TEXT NOT NULL,
  input_hash          TEXT NOT NULL,
  output_summary      TEXT NOT NULL,
  usage               TEXT NOT NULL,  -- JSON Usage
  duration_ms         INTEGER NOT NULL,
  attempts            INTEGER NOT NULL,
  retries             INTEGER NOT NULL,
  validation_failures INTEGER NOT NULL,
  error               TEXT,
  started_at          TEXT NOT NULL,
  finished_at         TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

-- §2.3 The registry. Long-lived, shared across runs, grown asynchronously.
CREATE TABLE IF NOT EXISTS sources (
  id          TEXT PRIMARY KEY,
  company     TEXT NOT NULL,
  domain      TEXT,
  career_url  TEXT,
  ats_type    TEXT NOT NULL,
  ats_slug    TEXT,
  confidence  REAL NOT NULL,
  status      TEXT NOT NULL,
  reason      TEXT,
  verified_at TEXT,
  health      TEXT NOT NULL,          -- JSON
  updated_at  TEXT NOT NULL,
  -- Whether the user wants this board searched. Separate from `status`, which
  -- records whether it works. Defaults on, so a registry built before this
  -- column existed keeps behaving exactly as it did.
  enabled     INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_company_ats ON sources(company, ats_type, IFNULL(ats_slug,''));

CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,
  dedupe_key   TEXT NOT NULL,
  source_id    TEXT NOT NULL,
  company      TEXT NOT NULL,
  title        TEXT NOT NULL,
  posting      TEXT NOT NULL,         -- JSON JobPosting
  first_seen   TEXT NOT NULL,
  last_seen    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_dedupe ON jobs(dedupe_key);

-- §2.5 "runs once per job, cached forever".
CREATE TABLE IF NOT EXISTS jd_analysis (
  job_id      TEXT PRIMARY KEY,
  analysis    TEXT NOT NULL,          -- JSON JDAnalysis
  model       TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS embeddings (
  owner_kind  TEXT NOT NULL,          -- 'job' | 'resume_section' | 'title'
  owner_id    TEXT NOT NULL,
  dim         INTEGER NOT NULL,
  vec         BLOB NOT NULL,          -- Float32Array
  label       TEXT NOT NULL,
  PRIMARY KEY (owner_kind, owner_id)
);

-- §2.2 synonym graph. "SDE" and "Member of Technical Staff" are the same job.
CREATE TABLE IF NOT EXISTS title_synonyms (
  term       TEXT NOT NULL,
  canonical  TEXT NOT NULL,
  weight     REAL NOT NULL,
  confirmed  INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (term, canonical)
);

CREATE TABLE IF NOT EXISTS skill_synonyms (
  term       TEXT NOT NULL,
  canonical  TEXT NOT NULL,
  weight     REAL NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (term, canonical)
);

CREATE TABLE IF NOT EXISTS escalations (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL,
  payload     TEXT NOT NULL,          -- JSON Escalation
  answer      TEXT,
  created_at  TEXT NOT NULL,
  answered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_escalations_run ON escalations(run_id);

-- §2.8 tracker.
CREATE TABLE IF NOT EXISTS applications (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL,
  job_id        TEXT NOT NULL,
  state         TEXT NOT NULL,
  apply_url     TEXT,
  jd_snapshot   TEXT,
  resume_sha    TEXT,
  resume_path   TEXT,
  updated_at    TEXT NOT NULL
);

-- §2.9 which tailoring edits the user accepted vs rejected.
CREATE TABLE IF NOT EXISTS edit_feedback (
  id         TEXT PRIMARY KEY,
  job_id     TEXT NOT NULL,
  edit_kind  TEXT NOT NULL,
  accepted   INTEGER NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL
);
