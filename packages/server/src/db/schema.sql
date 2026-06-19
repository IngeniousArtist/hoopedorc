-- Hoopedorc persistence schema (SQLite).  OWNER: deepseek-flash.
-- JSON-encoded array columns are noted; decode them in the repository layer.

PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS projects (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  repo_url       TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  local_path     TEXT NOT NULL,
  status         TEXT NOT NULL,
  prd_path       TEXT,
  budget_usd     REAL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
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
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);

CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  model       TEXT NOT NULL,
  attempt     INTEGER NOT NULL,
  status      TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  exit_reason TEXT,
  cost_usd    REAL NOT NULL DEFAULT 0,
  tokens_in   INTEGER NOT NULL DEFAULT 0,
  tokens_out  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id);

CREATE TABLE IF NOT EXISTS logs (
  id      TEXT PRIMARY KEY,
  run_id  TEXT NOT NULL,
  task_id TEXT NOT NULL,
  ts      TEXT NOT NULL,
  level   TEXT NOT NULL,
  source  TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_run ON logs(run_id);

CREATE TABLE IF NOT EXISTS merge_decisions (
  id              TEXT PRIMARY KEY,
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
  project_id TEXT NOT NULL,
  model      TEXT NOT NULL,
  task_id    TEXT,
  run_id     TEXT,
  cost_usd   REAL NOT NULL,
  tokens_in  INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  ts         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_costs_project ON costs(project_id);

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
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT NOT NULL                            -- JSON Settings blob
);
