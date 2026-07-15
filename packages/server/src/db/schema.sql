-- Hoopedorc persistence schema (SQLite).  OWNER: deepseek-flash.
-- JSON-encoded array columns are noted; decode them in the repository layer.

PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS projects (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  repo_url              TEXT NOT NULL,
  default_branch        TEXT NOT NULL DEFAULT 'main',
  local_path            TEXT NOT NULL,
  status                TEXT NOT NULL,
  prd_path              TEXT,
  prd                   TEXT,   -- last committed PRD markdown (for v2 planning context)
  budget_usd            REAL,
  planning_messages     TEXT,   -- JSON PlanChatMessage[]
  planning_prd          TEXT,   -- PRD markdown from last deconstruct
  planning_draft_tasks  TEXT,   -- JSON DraftTask[] from last deconstruct (user-editable)
  planning_agents_md    TEXT,   -- AGENTS.md draft from last deconstruct (F38, user-editable)
  config                TEXT,   -- JSON ProjectConfig (F9): gate/retry/merge-policy overrides
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id),
  title               TEXT NOT NULL,
  description         TEXT NOT NULL,
  difficulty          TEXT NOT NULL,
  status              TEXT NOT NULL,
  depends_on          TEXT NOT NULL DEFAULT '[]',  -- JSON array of task ids
  acceptance_criteria TEXT NOT NULL DEFAULT '[]',  -- JSON array of strings
  assigned_model      TEXT NOT NULL,
  role                TEXT,                         -- optional Role for routing
  scope_paths         TEXT NOT NULL DEFAULT '[]',  -- JSON array of globs
  branch              TEXT,
  worktree_path       TEXT,
  pr_number           INTEGER,
  attempts            INTEGER NOT NULL DEFAULT 0,
  max_attempts        INTEGER NOT NULL DEFAULT 3,
  dispatch_requested_at TEXT,  -- B34: persisted manual-priority queue request
  status_reason       TEXT,    -- one-line human-readable terminal outcome
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);

CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL DEFAULT '',
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  model       TEXT NOT NULL,
  effort      TEXT,
  attempt     INTEGER NOT NULL,
  status      TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  exit_reason TEXT,
  cost_usd      REAL NOT NULL DEFAULT 0,
  tokens_in     INTEGER NOT NULL DEFAULT 0,
  tokens_out    INTEGER NOT NULL DEFAULT 0,
  tokens_cached INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id);

-- B40: authoritative ledger for every model-backed CLI call. Unlike `runs`,
-- this includes planning, deconstruction, validation, docs, and health calls.
-- project/task are nullable because a setup health probe is installation-wide.
CREATE TABLE IF NOT EXISTS model_invocations (
  id            TEXT PRIMARY KEY,
  project_id    TEXT,
  task_id       TEXT,
  run_id        TEXT,
  stage         TEXT NOT NULL,
  model         TEXT NOT NULL,
  runner        TEXT NOT NULL,
  effort        TEXT NOT NULL DEFAULT 'default',
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  outcome       TEXT NOT NULL,
  exit_reason   TEXT,
  cost_usd      REAL NOT NULL DEFAULT 0,
  tokens_in     INTEGER NOT NULL DEFAULT 0,
  tokens_out    INTEGER NOT NULL DEFAULT 0,
  tokens_cached INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_model_invocations_model_started
  ON model_invocations(model, started_at);
CREATE INDEX IF NOT EXISTS idx_model_invocations_project_started
  ON model_invocations(project_id, started_at);
CREATE INDEX IF NOT EXISTS idx_model_invocations_task
  ON model_invocations(task_id, started_at);

CREATE TABLE IF NOT EXISTS logs (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL DEFAULT '',
  run_id     TEXT NOT NULL,
  task_id    TEXT NOT NULL,
  ts         TEXT NOT NULL,
  level      TEXT NOT NULL,
  source     TEXT NOT NULL,
  message    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_run ON logs(run_id);
CREATE INDEX IF NOT EXISTS idx_logs_task ON logs(task_id, ts);

CREATE TABLE IF NOT EXISTS merge_decisions (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL DEFAULT '',
  task_id         TEXT NOT NULL,
  run_id          TEXT NOT NULL,
  validator_model TEXT NOT NULL,
  verdict         TEXT NOT NULL,
  reasons         TEXT NOT NULL DEFAULT '[]',  -- JSON array
  confidence      REAL NOT NULL,
  gate            TEXT NOT NULL,               -- JSON GateResult
  ts              TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS costs (
  id         TEXT PRIMARY KEY,
  invocation_id TEXT,
  project_id TEXT NOT NULL,
  model      TEXT NOT NULL,
  task_id    TEXT,
  run_id     TEXT,
  cost_usd      REAL NOT NULL,
  tokens_in     INTEGER NOT NULL,
  tokens_out    INTEGER NOT NULL,
  tokens_cached INTEGER NOT NULL DEFAULT 0,
  ts            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_costs_project ON costs(project_id);

-- F7: which soft budget thresholds (50/80%) have already been alerted on, so
-- each only pushes once. `scope` is `project:<id>` (lifetime spend) or
-- `global:<YYYY-MM>` (global scope is naturally month-scoped by baking the
-- month into the key, so a new month re-arms both thresholds automatically).
CREATE TABLE IF NOT EXISTS budget_alerts (
  id        TEXT PRIMARY KEY,
  scope     TEXT NOT NULL,
  threshold INTEGER NOT NULL,
  ts        TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_alerts_scope_threshold ON budget_alerts(scope, threshold);

CREATE TABLE IF NOT EXISTS notifications (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL,
  task_id           TEXT,
  severity          TEXT NOT NULL,
  title             TEXT NOT NULL,
  message           TEXT NOT NULL,
  requires_approval INTEGER NOT NULL DEFAULT 0,
  options           TEXT,                       -- JSON array
  responded_with    TEXT,
  created_at        TEXT NOT NULL,
  context           TEXT                        -- F22: JSON { prUrl?, reasons? }
);

-- F6: one row per "Test models" click per model — the health panel's
-- "last check" column. Not pruned (small, low-volume — a handful of manual
-- clicks, unlike the logs table B14 had to bound).
CREATE TABLE IF NOT EXISTS model_checks (
  id           TEXT PRIMARY KEY,
  invocation_id TEXT,
  model_id     TEXT NOT NULL,
  display_name TEXT NOT NULL,
  ok           INTEGER NOT NULL,
  cost_usd     REAL NOT NULL DEFAULT 0,
  ms           INTEGER NOT NULL DEFAULT 0,
  reply        TEXT,
  error        TEXT,
  ts           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_model_checks_model ON model_checks(model_id, ts);

-- B41: rate-limit state is global to one logical model subscription, not one
-- project/runtime. Persisting the expiry prevents a service restart from
-- immediately hammering a model that was already cooling down.
CREATE TABLE IF NOT EXISTS model_cooldowns (
  model_id   TEXT PRIMARY KEY,
  until      TEXT NOT NULL,
  reason     TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT NOT NULL                            -- JSON Settings blob
);

-- B36: restart-safe rollback pipeline. A task/PR pair owns one durable job so
-- duplicate clicks and process restarts cannot issue the revert twice.
CREATE TABLE IF NOT EXISTS rollback_jobs (
  id                       TEXT PRIMARY KEY,
  project_id               TEXT NOT NULL REFERENCES projects(id),
  task_id                  TEXT NOT NULL REFERENCES tasks(id),
  source_pr_number         INTEGER NOT NULL,
  source_commit            TEXT,
  source_parent_count      INTEGER,
  branch                   TEXT NOT NULL,
  worktree_path            TEXT NOT NULL,
  rollback_pr_number       INTEGER,
  status                   TEXT NOT NULL,
  status_reason            TEXT,
  gate                     TEXT,
  decision                 TEXT,
  approval_notification_id TEXT,
  approval_choice          TEXT,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  UNIQUE(task_id, source_pr_number)
);
CREATE INDEX IF NOT EXISTS idx_rollback_jobs_project ON rollback_jobs(project_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_rollback_jobs_status ON rollback_jobs(status, updated_at);

-- Append-only audit trail: every merge decision, approval, terminal task
-- transition, and rollback. PRD requires a persisted who/what/when/why trail.
CREATE TABLE IF NOT EXISTS audit_log (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id    TEXT,
  ts         TEXT NOT NULL,
  kind       TEXT NOT NULL,   -- e.g. merge_decision | approval_requested | approval_resolved | task_done | task_failed | rollback
  actor      TEXT NOT NULL,   -- e.g. validator:deepseek-pro | human | engine
  summary    TEXT NOT NULL,
  detail     TEXT             -- optional JSON blob
);
CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_log(project_id);
