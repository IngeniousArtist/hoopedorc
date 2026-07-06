import type {
  AuditEntry,
  CostRecord,
  DraftTask,
  LogEvent,
  MergeDecision,
  Notification,
  PlanChatMessage,
  Project,
  ProjectConfig,
  Run,
  Settings,
  Task,
} from "@orc/types";
import type { Db } from "./index";

function json<T>(raw: unknown): T {
  if (typeof raw === "string") return JSON.parse(raw) as T;
  return raw as T;
}

function asStr(v: unknown): string {
  if (v instanceof Buffer) return v.toString("utf8");
  return String(v ?? "");
}

// ── Projects ──

function mapProject(row: Record<string, unknown>): Project {
  return {
    id: asStr(row.id),
    name: asStr(row.name),
    repoUrl: asStr(row.repo_url),
    defaultBranch: asStr(row.default_branch),
    localPath: asStr(row.local_path),
    status: asStr(row.status) as Project["status"],
    prdPath: row.prd_path ? asStr(row.prd_path) : undefined,
    prd: row.prd ? asStr(row.prd) : undefined,
    budgetUsd: row.budget_usd != null ? Number(row.budget_usd) : undefined,
    config: row.config ? json<ProjectConfig>(row.config) : undefined,
    createdAt: asStr(row.created_at),
    updatedAt: asStr(row.updated_at),
  };
}

const PROJECT_COLUMNS =
  "id, name, repo_url, default_branch, local_path, status, prd_path, prd, budget_usd, config, created_at, updated_at";

export function getProjects(db: Db): Project[] {
  return db
    .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects ORDER BY created_at DESC`)
    .all()
    .map((r) => mapProject(r as Record<string, unknown>));
}

export function getProject(db: Db, id: string): Project | null {
  const row = db
    .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  return row ? mapProject(row) : null;
}

export function createProject(
  db: Db,
  p: Omit<Project, "createdAt" | "updatedAt">,
): Project {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO projects (id, name, repo_url, default_branch, local_path, status, prd_path, budget_usd, config, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    p.id,
    p.name,
    p.repoUrl,
    p.defaultBranch,
    p.localPath,
    p.status,
    p.prdPath ?? null,
    p.budgetUsd ?? null,
    p.config ? JSON.stringify(p.config) : null,
    now,
    now,
  );
  return getProject(db, p.id)!;
}

export function updateProject(
  db: Db,
  id: string,
  updates: Partial<Project>,
): Project | null {
  const now = new Date().toISOString();
  const set: string[] = ["updated_at = ?"];
  const vals: unknown[] = [now];

  const colMap: Record<string, string> = {
    name: "name",
    repoUrl: "repo_url",
    defaultBranch: "default_branch",
    localPath: "local_path",
    status: "status",
    prdPath: "prd_path",
    prd: "prd",
    budgetUsd: "budget_usd",
    config: "config",
  };

  for (const [key, col] of Object.entries(colMap)) {
    if (key in updates) {
      set.push(`${col} = ?`);
      const v = (updates as Record<string, unknown>)[key];
      vals.push(key === "config" ? (v ? JSON.stringify(v) : null) : (v ?? null));
    }
  }

  vals.push(id);
  db.prepare(`UPDATE projects SET ${set.join(", ")} WHERE id = ?`).run(...vals);
  return getProject(db, id);
}

/**
 * Delete a project and every row that references it (tasks, runs, logs,
 * merge decisions, costs, notifications, audit log). SQLite FKs are enforced
 * (PRAGMA foreign_keys = ON), so children must go first; wrapped in a
 * transaction so a partial delete can't leave orphans.
 */
export function deleteProject(db: Db, id: string): void {
  const run = db.transaction((projectId: string) => {
    const taskIds = (
      db.prepare("SELECT id FROM tasks WHERE project_id = ?").all(projectId) as { id: string }[]
    ).map((r) => r.id);

    for (const taskId of taskIds) {
      db.prepare("DELETE FROM logs WHERE task_id = ?").run(taskId);
      db.prepare("DELETE FROM merge_decisions WHERE task_id = ?").run(taskId);
      db.prepare("DELETE FROM runs WHERE task_id = ?").run(taskId);
    }
    db.prepare("DELETE FROM costs WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM notifications WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM audit_log WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM tasks WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
  });
  run(id);
}

// ── Planning session ──

export function savePlanningSession(
  db: Db,
  projectId: string,
  opts: { messages?: PlanChatMessage[]; prd?: string | null; draftTasks?: DraftTask[] | null },
): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (opts.messages !== undefined) { sets.push("planning_messages = ?"); vals.push(JSON.stringify(opts.messages)); }
  if (opts.prd !== undefined) { sets.push("planning_prd = ?"); vals.push(opts.prd ?? null); }
  if (opts.draftTasks !== undefined) { sets.push("planning_draft_tasks = ?"); vals.push(opts.draftTasks ? JSON.stringify(opts.draftTasks) : null); }
  if (sets.length === 0) return;
  vals.push(projectId);
  db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

export function getPlanningSession(
  db: Db,
  projectId: string,
): { messages: PlanChatMessage[]; prd?: string; draftTasks?: DraftTask[] } {
  const row = db
    .prepare("SELECT planning_messages, planning_prd, planning_draft_tasks FROM projects WHERE id = ?")
    .get(projectId) as { planning_messages: string | null; planning_prd: string | null; planning_draft_tasks: string | null } | undefined;
  if (!row) return { messages: [] };
  return {
    messages: row.planning_messages ? (JSON.parse(row.planning_messages) as PlanChatMessage[]) : [],
    prd: row.planning_prd ?? undefined,
    draftTasks: row.planning_draft_tasks ? (JSON.parse(row.planning_draft_tasks) as DraftTask[]) : undefined,
  };
}

// ── Tasks ──

function mapTask(row: Record<string, unknown>): Task {
  return {
    id: asStr(row.id),
    projectId: asStr(row.project_id),
    title: asStr(row.title),
    description: asStr(row.description),
    difficulty: asStr(row.difficulty) as Task["difficulty"],
    status: asStr(row.status) as Task["status"],
    dependsOn: json<string[]>(row.depends_on),
    acceptanceCriteria: json<string[]>(row.acceptance_criteria),
    assignedModel: asStr(row.assigned_model) as Task["assignedModel"],
    role: row.role ? (asStr(row.role) as Task["role"]) : undefined,
    scopePaths: json<string[]>(row.scope_paths),
    branch: row.branch ? asStr(row.branch) : undefined,
    worktreePath: row.worktree_path ? asStr(row.worktree_path) : undefined,
    prNumber: row.pr_number != null ? Number(row.pr_number) : undefined,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    createdAt: asStr(row.created_at),
    updatedAt: asStr(row.updated_at),
  };
}

export function getTasks(db: Db, projectId: string): Task[] {
  return db
    .prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at ASC")
    .all(projectId)
    .map((r) => mapTask(r as Record<string, unknown>));
}

export function getTask(db: Db, id: string): Task | null {
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapTask(row) : null;
}

export function createTask(
  db: Db,
  t: Omit<Task, "createdAt" | "updatedAt">,
): Task {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, description, difficulty, status, depends_on, acceptance_criteria, assigned_model, role, scope_paths, attempts, max_attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    t.id,
    t.projectId,
    t.title,
    t.description,
    t.difficulty,
    t.status,
    JSON.stringify(t.dependsOn),
    JSON.stringify(t.acceptanceCriteria),
    t.assignedModel,
    t.role ?? null,
    JSON.stringify(t.scopePaths),
    t.attempts,
    t.maxAttempts,
    now,
    now,
  );
  return getTask(db, t.id)!;
}

export function updateTask(
  db: Db,
  id: string,
  updates: Partial<Task>,
): Task | null {
  const now = new Date().toISOString();
  const set: string[] = ["updated_at = ?"];
  const vals: unknown[] = [now];

  const colMap: Record<string, string> = {
    title: "title",
    description: "description",
    difficulty: "difficulty",
    status: "status",
    assignedModel: "assigned_model",
    role: "role",
    branch: "branch",
    worktreePath: "worktree_path",
    prNumber: "pr_number",
    attempts: "attempts",
    maxAttempts: "max_attempts",
  };
  const jsonCols = new Set(["dependsOn", "acceptanceCriteria", "scopePaths"]);

  for (const [key, col] of Object.entries(colMap)) {
    if (key in updates) {
      set.push(`${col} = ?`);
      vals.push((updates as Record<string, unknown>)[key] ?? null);
    }
  }
  for (const key of jsonCols) {
    if (key in updates) {
      const col = key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
      set.push(`${col} = ?`);
      vals.push(JSON.stringify((updates as Record<string, unknown>)[key]));
    }
  }

  vals.push(id);
  db.prepare(`UPDATE tasks SET ${set.join(", ")} WHERE id = ?`).run(...vals);
  return getTask(db, id);
}

// ── Runs ──

function mapRun(row: Record<string, unknown>): Run {
  return {
    id: asStr(row.id),
    // Pre-B15 rows (migrated via ALTER TABLE, no backfill) have NULL here.
    projectId: row.project_id ? asStr(row.project_id) : "",
    taskId: asStr(row.task_id),
    model: asStr(row.model) as Run["model"],
    attempt: Number(row.attempt),
    status: asStr(row.status) as Run["status"],
    startedAt: asStr(row.started_at),
    endedAt: row.ended_at ? asStr(row.ended_at) : undefined,
    exitReason: row.exit_reason ? asStr(row.exit_reason) : undefined,
    costUsd: Number(row.cost_usd),
    tokensIn: Number(row.tokens_in),
    tokensOut: Number(row.tokens_out),
  };
}

export function getRuns(db: Db, taskId: string): Run[] {
  return db
    .prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC")
    .all(taskId)
    .map((r) => mapRun(r as Record<string, unknown>));
}

export function getRun(db: Db, id: string): Run | null {
  const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapRun(row) : null;
}

export function createRun(
  db: Db,
  r: Omit<Run, "id"> & { id?: string },
): Run {
  const id = r.id ?? crypto.randomUUID();
  db.prepare(
    `INSERT INTO runs (id, project_id, task_id, model, attempt, status, started_at, cost_usd, tokens_in, tokens_out)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, r.projectId, r.taskId, r.model, r.attempt, r.status, r.startedAt, r.costUsd, r.tokensIn, r.tokensOut);
  return getRun(db, id)!;
}

export function updateRun(
  db: Db,
  id: string,
  updates: Partial<Run>,
): Run | null {
  const set: string[] = [];
  const vals: unknown[] = [];

  const colMap: Record<string, string> = {
    status: "status",
    endedAt: "ended_at",
    exitReason: "exit_reason",
    costUsd: "cost_usd",
    tokensIn: "tokens_in",
    tokensOut: "tokens_out",
  };

  for (const [key, col] of Object.entries(colMap)) {
    if (key in updates) {
      set.push(`${col} = ?`);
      vals.push((updates as Record<string, unknown>)[key] ?? null);
    }
  }

  if (set.length === 0) return getRun(db, id);
  vals.push(id);
  db.prepare(`UPDATE runs SET ${set.join(", ")} WHERE id = ?`).run(...vals);
  return getRun(db, id);
}

// ── Logs ──

function mapLog(row: Record<string, unknown>): LogEvent {
  return {
    id: asStr(row.id),
    // Pre-B15 rows (migrated via ALTER TABLE, no backfill) have NULL here.
    projectId: row.project_id ? asStr(row.project_id) : "",
    runId: asStr(row.run_id),
    taskId: asStr(row.task_id),
    ts: asStr(row.ts),
    level: asStr(row.level) as LogEvent["level"],
    source: asStr(row.source) as LogEvent["source"],
    message: asStr(row.message),
  };
}

export function getLogs(db: Db, runId: string): LogEvent[] {
  return db
    .prepare("SELECT * FROM logs WHERE run_id = ? ORDER BY ts ASC")
    .all(runId)
    .map((r) => mapLog(r as Record<string, unknown>));
}

/**
 * All logs for a task across every run — every onLog emission is keyed by
 * task_id regardless of runId, so this (not getLogs by run) is what backs
 * the Board's history view after a reload. `after` (an ISO timestamp)
 * fetches only newer rows for incremental polling; either way the result is
 * capped at `limit` (default 1000) so a very chatty task can't return
 * megabytes in one call.
 */
export function getLogsByTask(
  db: Db,
  taskId: string,
  opts: { after?: string; limit?: number } = {},
): LogEvent[] {
  const limit = opts.limit ?? 1000;
  if (opts.after) {
    return db
      .prepare(
        "SELECT * FROM logs WHERE task_id = ? AND ts > ? ORDER BY ts ASC LIMIT ?",
      )
      .all(taskId, opts.after, limit)
      .map((r) => mapLog(r as Record<string, unknown>));
  }
  // Cap via the newest rows first, then re-sort ascending for display —
  // without the DESC+LIMIT a long-running task's earliest (least useful)
  // logs would win the cap instead of its most recent ones.
  return db
    .prepare("SELECT * FROM logs WHERE task_id = ? ORDER BY ts DESC LIMIT ?")
    .all(taskId, limit)
    .map((r) => mapLog(r as Record<string, unknown>))
    .reverse();
}

export function createLog(
  db: Db,
  l: Omit<LogEvent, "id"> & { id?: string },
): LogEvent {
  const id = l.id ?? crypto.randomUUID();
  db.prepare(
    "INSERT INTO logs (id, project_id, run_id, task_id, ts, level, source, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, l.projectId, l.runId, l.taskId, l.ts, l.level, l.source, l.message);
  return { ...l, id } as LogEvent;
}

/**
 * Insert many logs in a single transaction. Agent runs stream hundreds of log
 * lines; one synchronous INSERT per line blocked the event loop (the server
 * froze). Batching them into one transaction per flush keeps writes cheap.
 */
export function createLogs(
  db: Db,
  logs: (Omit<LogEvent, "id"> & { id?: string })[],
): LogEvent[] {
  const stmt = db.prepare(
    "INSERT INTO logs (id, project_id, run_id, task_id, ts, level, source, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const out: LogEvent[] = [];
  const insertAll = db.transaction(
    (rows: (Omit<LogEvent, "id"> & { id?: string })[]) => {
      for (const l of rows) {
        const id = l.id ?? crypto.randomUUID();
        stmt.run(id, l.projectId, l.runId, l.taskId, l.ts, l.level, l.source, l.message);
        out.push({ ...l, id } as LogEvent);
      }
    },
  );
  insertAll(logs);
  return out;
}

/**
 * Keep the logs table bounded: delete rows older than `retentionDays`, then
 * cap each task at its newest `maxPerTask` rows (a single very chatty task
 * could otherwise blow well past the age cutoff before it's actually "old").
 * Called on boot and once a day — see index.ts main(). Returns the number of
 * rows deleted, for a boot-time log line.
 */
export function pruneLogs(
  db: Db,
  retentionDays: number,
  maxPerTask = 2000,
): number {
  const cutoff = new Date(
    Date.now() - retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const byAge = db.prepare("DELETE FROM logs WHERE ts < ?").run(cutoff);

  const overLimit = db
    .prepare("SELECT task_id FROM logs GROUP BY task_id HAVING COUNT(*) > ?")
    .all(maxPerTask) as { task_id: string }[];

  const trimTask = db.prepare(
    `DELETE FROM logs WHERE task_id = ? AND id NOT IN (
       SELECT id FROM logs WHERE task_id = ? ORDER BY ts DESC LIMIT ?
     )`,
  );
  let byCount = 0;
  for (const { task_id } of overLimit) {
    byCount += trimTask.run(task_id, task_id, maxPerTask).changes;
  }

  return byAge.changes + byCount;
}

// ── Merge Decisions ──

function mapMergeDecision(row: Record<string, unknown>): MergeDecision {
  return {
    id: asStr(row.id),
    // Pre-B15 rows (migrated via ALTER TABLE, no backfill) have NULL here.
    projectId: row.project_id ? asStr(row.project_id) : "",
    taskId: asStr(row.task_id),
    runId: asStr(row.run_id),
    validatorModel: asStr(row.validator_model) as MergeDecision["validatorModel"],
    verdict: asStr(row.verdict) as MergeDecision["verdict"],
    reasons: json<string[]>(row.reasons),
    confidence: Number(row.confidence),
    gate: json<MergeDecision["gate"]>(row.gate),
    ts: asStr(row.ts),
  };
}

export function getMergeDecisions(db: Db, taskId: string): MergeDecision[] {
  return db
    .prepare("SELECT * FROM merge_decisions WHERE task_id = ? ORDER BY ts DESC")
    .all(taskId)
    .map((r) => mapMergeDecision(r as Record<string, unknown>));
}

export function createMergeDecision(
  db: Db,
  d: MergeDecision,
): MergeDecision {
  db.prepare(
    `INSERT INTO merge_decisions (id, project_id, task_id, run_id, validator_model, verdict, reasons, confidence, gate, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    d.id,
    d.projectId,
    d.taskId,
    d.runId,
    d.validatorModel,
    d.verdict,
    JSON.stringify(d.reasons),
    d.confidence,
    JSON.stringify(d.gate),
    d.ts,
  );
  return d;
}

// ── Costs ──

function mapCost(row: Record<string, unknown>): CostRecord {
  return {
    id: asStr(row.id),
    projectId: asStr(row.project_id),
    model: asStr(row.model) as CostRecord["model"],
    taskId: row.task_id ? asStr(row.task_id) : undefined,
    runId: row.run_id ? asStr(row.run_id) : undefined,
    costUsd: Number(row.cost_usd),
    tokensIn: Number(row.tokens_in),
    tokensOut: Number(row.tokens_out),
    ts: asStr(row.ts),
  };
}

export function getCosts(db: Db, projectId: string): CostRecord[] {
  return db
    .prepare("SELECT * FROM costs WHERE project_id = ? ORDER BY ts DESC")
    .all(projectId)
    .map((r) => mapCost(r as Record<string, unknown>));
}

export function createCost(
  db: Db,
  c: Omit<CostRecord, "id"> & { id?: string },
): CostRecord {
  const id = c.id ?? crypto.randomUUID();
  db.prepare(
    `INSERT INTO costs (id, project_id, model, task_id, run_id, cost_usd, tokens_in, tokens_out, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, c.projectId, c.model, c.taskId ?? null, c.runId ?? null, c.costUsd, c.tokensIn, c.tokensOut, c.ts);
  return { ...c, id } as CostRecord;
}

export function getCostSummary(
  db: Db,
  projectId: string,
): { totalUsd: number; byModel: Record<string, number> } {
  const rows = db
    .prepare("SELECT model, SUM(cost_usd) as total FROM costs WHERE project_id = ? GROUP BY model")
    .all(projectId) as { model: string; total: number }[];
  const byModel: Record<string, number> = {};
  let totalUsd = 0;
  for (const r of rows) {
    const t = Number(r.total);
    byModel[r.model] = t;
    totalUsd += t;
  }
  return { totalUsd, byModel };
}

/** Total spend on a project since a given ISO timestamp — used by F8's run
 *  summary to report just this run's spend, not the project's lifetime total. */
export function getCostSince(db: Db, projectId: string, sinceIso: string): number {
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) as total FROM costs WHERE project_id = ? AND ts >= ?",
    )
    .get(projectId, sinceIso) as { total: number } | undefined;
  return row ? Number(row.total) : 0;
}

export interface ModelCostRow {
  model: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  runs: number;
}

/** Rich per-project cost analytics: per-model, daily time-series, per-task. */
export function getCostAnalytics(
  db: Db,
  projectId: string,
): {
  totalUsd: number;
  totalTokensIn: number;
  totalTokensOut: number;
  byModel: ModelCostRow[];
  daily: { date: string; costUsd: number }[];
  byTask: { taskId: string; title: string; costUsd: number }[];
} {
  const byModel = (
    db
      .prepare(
        `SELECT model,
                SUM(cost_usd)  AS cost,
                SUM(tokens_in) AS tin,
                SUM(tokens_out) AS tout,
                COUNT(*)       AS runs
         FROM costs WHERE project_id = ? GROUP BY model ORDER BY cost DESC`,
      )
      .all(projectId) as Record<string, unknown>[]
  ).map((r) => ({
    model: asStr(r.model),
    costUsd: Number(r.cost),
    tokensIn: Number(r.tin),
    tokensOut: Number(r.tout),
    runs: Number(r.runs),
  }));

  const daily = (
    db
      .prepare(
        `SELECT substr(ts, 1, 10) AS date, SUM(cost_usd) AS cost
         FROM costs WHERE project_id = ? GROUP BY date ORDER BY date ASC`,
      )
      .all(projectId) as Record<string, unknown>[]
  ).map((r) => ({ date: asStr(r.date), costUsd: Number(r.cost) }));

  const byTask = (
    db
      .prepare(
        `SELECT c.task_id AS task_id,
                COALESCE(t.title, '(planning / untracked)') AS title,
                SUM(c.cost_usd) AS cost
         FROM costs c LEFT JOIN tasks t ON t.id = c.task_id
         WHERE c.project_id = ?
         GROUP BY c.task_id ORDER BY cost DESC`,
      )
      .all(projectId) as Record<string, unknown>[]
  ).map((r) => ({
    taskId: r.task_id ? asStr(r.task_id) : "",
    title: asStr(r.title),
    costUsd: Number(r.cost),
  }));

  const totals = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd),0) AS cost,
              COALESCE(SUM(tokens_in),0) AS tin,
              COALESCE(SUM(tokens_out),0) AS tout
       FROM costs WHERE project_id = ?`,
    )
    .get(projectId) as { cost: number; tin: number; tout: number };

  return {
    totalUsd: Number(totals.cost),
    totalTokensIn: Number(totals.tin),
    totalTokensOut: Number(totals.tout),
    byModel,
    daily,
    byTask,
  };
}

/**
 * Rolling per-model average spend per cost-record (≈ per run), across ALL
 * projects. Used to estimate the cost of not-yet-run tasks.
 */
export function getModelRunAverages(
  db: Db,
): Record<string, { avgCostPerRun: number; runs: number }> {
  const rows = db
    .prepare(
      `SELECT model, AVG(cost_usd) AS avg, COUNT(*) AS n
       FROM costs WHERE cost_usd > 0 GROUP BY model`,
    )
    .all() as { model: string; avg: number; n: number }[];
  const out: Record<string, { avgCostPerRun: number; runs: number }> = {};
  for (const r of rows) {
    out[r.model] = { avgCostPerRun: Number(r.avg), runs: Number(r.n) };
  }
  return out;
}

/**
 * First instant of the current month in UTC. Costs are stored as UTC ISO
 * strings (new Date().toISOString()), so the boundary must be UTC too —
 * a local-time boundary skews the monthly window by the UTC offset (up to a
 * full day) right at month edges.
 */
function firstOfMonthUtc(): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  ).toISOString();
}

export function getModelMonthlyCost(db: Db, model: string): number {
  const row = db
    .prepare("SELECT COALESCE(SUM(cost_usd), 0) as total FROM costs WHERE model = ? AND ts >= ?")
    .get(model, firstOfMonthUtc()) as { total: number } | undefined;
  return row ? Number(row.total) : 0;
}

/** Total spend this calendar month across all projects and models. */
export function getGlobalMonthlyCost(db: Db): number {
  const row = db
    .prepare("SELECT COALESCE(SUM(cost_usd), 0) as total FROM costs WHERE ts >= ?")
    .get(firstOfMonthUtc()) as { total: number } | undefined;
  return row ? Number(row.total) : 0;
}

/**
 * F16: how many times `model` has run and how much it has cost, since
 * `sinceIso`, across ALL projects — a subscription's usage cap applies to
 * the model's API key/plan, not any one project. Run count comes from the
 * `runs` table (every attempt, not just terminal ones — a subscription's
 * rolling window cares about requests made, not outcomes); cost comes from
 * `costs` the same way `getModelMonthlyCost` does, just with a rolling
 * window instead of a calendar-month one.
 */
export function getModelUsageSince(
  db: Db,
  model: string,
  sinceIso: string,
): { runs: number; costUsd: number } {
  const runRow = db
    .prepare("SELECT COUNT(*) as n FROM runs WHERE model = ? AND started_at >= ?")
    .get(model, sinceIso) as { n: number };
  const costRow = db
    .prepare("SELECT COALESCE(SUM(cost_usd), 0) as total FROM costs WHERE model = ? AND ts >= ?")
    .get(model, sinceIso) as { total: number };
  return { runs: Number(runRow.n), costUsd: Number(costRow.total) };
}

// ── Notifications ──

function mapNotification(row: Record<string, unknown>): Notification {
  return {
    id: asStr(row.id),
    projectId: asStr(row.project_id),
    taskId: row.task_id ? asStr(row.task_id) : undefined,
    severity: asStr(row.severity) as Notification["severity"],
    title: asStr(row.title),
    message: asStr(row.message),
    requiresApproval: Number(row.requires_approval) === 1,
    options: row.options ? json<string[]>(row.options) : undefined,
    respondedWith: row.responded_with ? asStr(row.responded_with) : undefined,
    createdAt: asStr(row.created_at),
  };
}

export function getNotification(db: Db, id: string): Notification | null {
  const row = db.prepare("SELECT * FROM notifications WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapNotification(row) : null;
}

export function getNotifications(db: Db, projectId?: string): Notification[] {
  let rows: Record<string, unknown>[];
  if (projectId) {
    rows = db
      .prepare("SELECT * FROM notifications WHERE project_id = ? ORDER BY created_at DESC")
      .all(projectId) as Record<string, unknown>[];
  } else {
    rows = db
      .prepare("SELECT * FROM notifications ORDER BY created_at DESC")
      .all() as Record<string, unknown>[];
  }
  return rows.map(mapNotification);
}

export function createNotification(
  db: Db,
  n: Omit<Notification, "id" | "createdAt"> & { id?: string },
): Notification {
  const id = n.id ?? crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO notifications (id, project_id, task_id, severity, title, message, requires_approval, options, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    n.projectId,
    n.taskId ?? null,
    n.severity,
    n.title,
    n.message,
    n.requiresApproval ? 1 : 0,
    n.options ? JSON.stringify(n.options) : null,
    now,
  );
  return { ...n, id, createdAt: now } as Notification;
}

export function respondToNotification(
  db: Db,
  id: string,
  choice: string,
): Notification | null {
  db.prepare("UPDATE notifications SET responded_with = ? WHERE id = ?").run(choice, id);
  const row = db.prepare("SELECT * FROM notifications WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapNotification(row) : null;
}

/**
 * The literal `responded_with` value stamped on every still-pending
 * approval at boot (B10) — the process that would have resolved them (the
 * `EngineRunner.pendingApprovals` promise) died with the previous process,
 * so nothing is actually waiting on them anymore.
 */
export const EXPIRED_RESTART = "expired_restart";

/**
 * On boot, mark every still-unresolved approval notification as expired: the
 * in-memory resolver each was blocking on lived only in the previous
 * process, so after a restart there is nothing left to unblock even though
 * the notification still looks live (dead Approve/Reject buttons in the UI
 * and in any already-sent Telegram message). Returns the number of rows
 * updated.
 */
export function expireStaleApprovals(db: Db): number {
  const result = db
    .prepare(
      "UPDATE notifications SET responded_with = ? WHERE requires_approval = 1 AND responded_with IS NULL",
    )
    .run(EXPIRED_RESTART);
  return result.changes;
}

// ── Audit log ──

function mapAudit(row: Record<string, unknown>): AuditEntry {
  return {
    id: asStr(row.id),
    projectId: asStr(row.project_id),
    taskId: row.task_id ? asStr(row.task_id) : undefined,
    ts: asStr(row.ts),
    kind: asStr(row.kind),
    actor: asStr(row.actor),
    summary: asStr(row.summary),
    detail: row.detail ? json<Record<string, unknown>>(row.detail) : undefined,
  };
}

export function createAuditEntry(
  db: Db,
  e: Omit<AuditEntry, "id" | "ts"> & { id?: string; ts?: string },
): AuditEntry {
  const id = e.id ?? crypto.randomUUID();
  const ts = e.ts ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO audit_log (id, project_id, task_id, ts, kind, actor, summary, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    e.projectId,
    e.taskId ?? null,
    ts,
    e.kind,
    e.actor,
    e.summary,
    e.detail ? JSON.stringify(e.detail) : null,
  );
  return { ...e, id, ts } as AuditEntry;
}

export function getAuditLog(db: Db, projectId: string): AuditEntry[] {
  return db
    .prepare("SELECT * FROM audit_log WHERE project_id = ? ORDER BY ts DESC")
    .all(projectId)
    .map((r) => mapAudit(r as Record<string, unknown>));
}

// ── Budget alerts (F7) ──

/** True if this (scope, threshold) pair has already been alerted on. */
export function hasBudgetAlert(db: Db, scope: string, threshold: number): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM budget_alerts WHERE scope = ? AND threshold = ?")
      .get(scope, threshold),
  );
}

/** Idempotent — a duplicate (scope, threshold) is silently ignored thanks to
 *  the unique index, so a racing double-check can't double-record. */
export function recordBudgetAlert(db: Db, scope: string, threshold: number): void {
  db.prepare(
    "INSERT OR IGNORE INTO budget_alerts (id, scope, threshold, ts) VALUES (?, ?, ?, ?)",
  ).run(crypto.randomUUID(), scope, threshold, new Date().toISOString());
}

/** Re-arms a scope's thresholds — called when a project's budget cap itself
 *  changes, so raising it doesn't permanently silence future alerts. */
export function clearBudgetAlerts(db: Db, scope: string): void {
  db.prepare("DELETE FROM budget_alerts WHERE scope = ?").run(scope);
}

// ── Model health (F6) ──

export interface ModelCheckRecord {
  id: string;
  modelId: string;
  displayName: string;
  ok: boolean;
  costUsd: number;
  ms: number;
  reply?: string;
  error?: string;
  ts: string;
}

function mapModelCheck(row: Record<string, unknown>): ModelCheckRecord {
  return {
    id: asStr(row.id),
    modelId: asStr(row.model_id),
    displayName: asStr(row.display_name),
    ok: Number(row.ok) === 1,
    costUsd: Number(row.cost_usd),
    ms: Number(row.ms),
    reply: row.reply ? asStr(row.reply) : undefined,
    error: row.error ? asStr(row.error) : undefined,
    ts: asStr(row.ts),
  };
}

export function createModelCheck(
  db: Db,
  c: Omit<ModelCheckRecord, "id"> & { id?: string },
): ModelCheckRecord {
  const id = c.id ?? crypto.randomUUID();
  db.prepare(
    `INSERT INTO model_checks (id, model_id, display_name, ok, cost_usd, ms, reply, error, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    c.modelId,
    c.displayName,
    c.ok ? 1 : 0,
    c.costUsd,
    c.ms,
    c.reply ?? null,
    c.error ?? null,
    c.ts,
  );
  return { ...c, id };
}

/** The single most recent check per model_id — the health panel's "last
 *  check" column. */
export function getLatestModelChecks(db: Db): ModelCheckRecord[] {
  const rows = db
    .prepare(
      `SELECT mc.* FROM model_checks mc
       INNER JOIN (
         SELECT model_id, MAX(ts) AS max_ts FROM model_checks GROUP BY model_id
       ) latest ON mc.model_id = latest.model_id AND mc.ts = latest.max_ts`,
    )
    .all() as Record<string, unknown>[];
  return rows.map(mapModelCheck);
}

export interface ModelRunStats {
  model: string;
  totalRuns: number;
  failedRuns: number;
  /** null when no run has an ended_at yet (nothing to measure). */
  medianDurationMs: number | null;
}

/**
 * Rolling failure rate + median duration per model, from every completed run
 * ever recorded — cross-project, since a model's reliability isn't a
 * per-project property.
 */
export function getModelRunStats(db: Db): ModelRunStats[] {
  const rows = db
    .prepare(
      `SELECT model, exit_reason, started_at, ended_at FROM runs WHERE ended_at IS NOT NULL`,
    )
    .all() as {
    model: string;
    exit_reason: string | null;
    started_at: string;
    ended_at: string;
  }[];

  const byModel = new Map<
    string,
    { total: number; failed: number; durations: number[] }
  >();
  for (const r of rows) {
    const entry = byModel.get(r.model) ?? { total: 0, failed: 0, durations: [] };
    entry.total++;
    if (
      r.exit_reason === "error" ||
      r.exit_reason === "stuck" ||
      r.exit_reason === "rate_limited"
    ) {
      entry.failed++;
    }
    const ms = new Date(r.ended_at).getTime() - new Date(r.started_at).getTime();
    if (ms >= 0) entry.durations.push(ms);
    byModel.set(r.model, entry);
  }

  return Array.from(byModel.entries()).map(([model, e]) => {
    const sorted = [...e.durations].sort((a, b) => a - b);
    const medianDurationMs = sorted.length
      ? sorted[Math.floor(sorted.length / 2)]!
      : null;
    return { model, totalRuns: e.total, failedRuns: e.failed, medianDurationMs };
  });
}

// ── Settings ──

export function getSettings(db: Db): Settings | null {
  const row = db.prepare("SELECT json FROM settings WHERE id = 1").get() as
    | { json: string }
    | undefined;
  return row ? json<Settings>(row.json) : null;
}

export function upsertSettings(db: Db, s: Settings): Settings {
  db.prepare(
    `INSERT INTO settings (id, json) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
  ).run(JSON.stringify(s));
  return getSettings(db)!;
}
