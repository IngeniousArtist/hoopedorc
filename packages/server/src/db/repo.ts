import type {
  AuditEntry,
  CostRecord,
  DraftTask,
  LogEvent,
  MergeDecision,
  ModelInvocation,
  Notification,
  PlanChatMessage,
  Project,
  ProjectConfig,
  RollbackJob,
  Run,
  Settings,
  Task,
} from "@orc/types";
import type { Db } from "./index";
import { normalizeSettings } from "../config";

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
    lastScheduledRunAt: row.last_scheduled_run_at ? asStr(row.last_scheduled_run_at) : undefined,
    createdAt: asStr(row.created_at),
    updatedAt: asStr(row.updated_at),
  };
}

const PROJECT_COLUMNS =
  "id, name, repo_url, default_branch, local_path, status, prd_path, prd, budget_usd, config, last_scheduled_run_at, created_at, updated_at";

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
    lastScheduledRunAt: "last_scheduled_run_at",
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
 * merge decisions, invocations, costs, notifications, audit log). SQLite FKs are enforced
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
    db.prepare("DELETE FROM model_invocations WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM notifications WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM audit_log WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM rollback_jobs WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM tasks WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
  });
  run(id);
}

// ── Planning session ──

export function savePlanningSession(
  db: Db,
  projectId: string,
  opts: {
    messages?: PlanChatMessage[];
    prd?: string | null;
    draftTasks?: DraftTask[] | null;
    /** F38: AGENTS.md draft from the last deconstruct, cleared at
     *  /plan/commit like `prd`. */
    agentsMd?: string | null;
    /** F28: the archived markdown session file this session is being
     *  written to. `null` clears it (done at /plan/commit, so the next
     *  chat turn mints a fresh file for the next session). */
    sessionFile?: string | null;
  },
): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (opts.messages !== undefined) { sets.push("planning_messages = ?"); vals.push(JSON.stringify(opts.messages)); }
  if (opts.prd !== undefined) { sets.push("planning_prd = ?"); vals.push(opts.prd ?? null); }
  if (opts.draftTasks !== undefined) { sets.push("planning_draft_tasks = ?"); vals.push(opts.draftTasks ? JSON.stringify(opts.draftTasks) : null); }
  if (opts.agentsMd !== undefined) { sets.push("planning_agents_md = ?"); vals.push(opts.agentsMd ?? null); }
  if (opts.sessionFile !== undefined) { sets.push("planning_session_file = ?"); vals.push(opts.sessionFile ?? null); }
  if (sets.length === 0) return;
  vals.push(projectId);
  db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

export function getPlanningSession(
  db: Db,
  projectId: string,
): {
  messages: PlanChatMessage[];
  prd?: string;
  draftTasks?: DraftTask[];
  agentsMd?: string;
  sessionFile?: string;
} {
  const row = db
    .prepare(
      "SELECT planning_messages, planning_prd, planning_draft_tasks, planning_agents_md, planning_session_file FROM projects WHERE id = ?",
    )
    .get(projectId) as
    | {
        planning_messages: string | null;
        planning_prd: string | null;
        planning_draft_tasks: string | null;
        planning_agents_md: string | null;
        planning_session_file: string | null;
      }
    | undefined;
  if (!row) return { messages: [] };
  return {
    messages: row.planning_messages ? (JSON.parse(row.planning_messages) as PlanChatMessage[]) : [],
    prd: row.planning_prd ?? undefined,
    draftTasks: row.planning_draft_tasks ? (JSON.parse(row.planning_draft_tasks) as DraftTask[]) : undefined,
    agentsMd: row.planning_agents_md ?? undefined,
    sessionFile: row.planning_session_file ?? undefined,
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
    dispatchRequestedAt: row.dispatch_requested_at
      ? asStr(row.dispatch_requested_at)
      : undefined,
    statusReason: row.status_reason ? asStr(row.status_reason) : undefined,
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
    `INSERT INTO tasks (id, project_id, title, description, difficulty, status, depends_on, acceptance_criteria, assigned_model, role, scope_paths, attempts, max_attempts, dispatch_requested_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    t.dispatchRequestedAt ?? null,
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
    dispatchRequestedAt: "dispatch_requested_at",
    statusReason: "status_reason",
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

/** Cancel every queued manual-priority request that has not started yet. */
export function clearDispatchRequests(db: Db, projectId: string): Task[] {
  const requested = db
    .prepare(
      "SELECT id FROM tasks WHERE project_id = ? AND dispatch_requested_at IS NOT NULL",
    )
    .all(projectId) as { id: string }[];
  if (requested.length === 0) return [];

  db.prepare(
    "UPDATE tasks SET dispatch_requested_at = NULL, updated_at = ? WHERE project_id = ? AND dispatch_requested_at IS NOT NULL",
  ).run(new Date().toISOString(), projectId);
  return requested.flatMap(({ id }) => {
    const task = getTask(db, id);
    return task ? [task] : [];
  });
}

/**
 * Apply the user's Stop outcome only while the task is still active. A
 * terminal engine update that commits first wins and is never rewritten.
 */
export function markTaskStoppedIfActive(
  db: Db,
  id: string,
  reason = "Stopped by user",
): { changed: boolean; task: Task | null } {
  const result = db
    .prepare(
      `UPDATE tasks
       SET status = 'blocked', status_reason = ?, dispatch_requested_at = NULL, updated_at = ?
       WHERE id = ? AND status IN ('in_progress', 'in_review')`,
    )
    .run(reason, new Date().toISOString(), id);
  return { changed: result.changes > 0, task: getTask(db, id) };
}

// ── Rollback jobs ──

const TERMINAL_ROLLBACK_STATUSES = [
  "completed",
  "rejected",
  "conflicted",
  "failed",
] as const;

function mapRollbackJob(row: Record<string, unknown>): RollbackJob {
  return {
    id: asStr(row.id),
    projectId: asStr(row.project_id),
    taskId: asStr(row.task_id),
    sourcePrNumber: Number(row.source_pr_number),
    sourceCommit: row.source_commit ? asStr(row.source_commit) : undefined,
    sourceParentCount:
      row.source_parent_count != null
        ? Number(row.source_parent_count)
        : undefined,
    branch: asStr(row.branch),
    worktreePath: asStr(row.worktree_path),
    rollbackPrNumber:
      row.rollback_pr_number != null
        ? Number(row.rollback_pr_number)
        : undefined,
    status: asStr(row.status) as RollbackJob["status"],
    statusReason: row.status_reason ? asStr(row.status_reason) : undefined,
    gate: row.gate ? json<RollbackJob["gate"]>(row.gate) : undefined,
    decision: row.decision
      ? json<RollbackJob["decision"]>(row.decision)
      : undefined,
    approvalNotificationId: row.approval_notification_id
      ? asStr(row.approval_notification_id)
      : undefined,
    approvalChoice: row.approval_choice
      ? asStr(row.approval_choice)
      : undefined,
    createdAt: asStr(row.created_at),
    updatedAt: asStr(row.updated_at),
  };
}

export function getRollbackJob(db: Db, id: string): RollbackJob | null {
  const row = db.prepare("SELECT * FROM rollback_jobs WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapRollbackJob(row) : null;
}

export function getRollbackJobForTask(
  db: Db,
  taskId: string,
  sourcePrNumber: number,
): RollbackJob | null {
  const row = db
    .prepare(
      "SELECT * FROM rollback_jobs WHERE task_id = ? AND source_pr_number = ?",
    )
    .get(taskId, sourcePrNumber) as Record<string, unknown> | undefined;
  return row ? mapRollbackJob(row) : null;
}

/** INSERT OR IGNORE makes duplicate rollback clicks atomic and idempotent. */
export function createOrGetRollbackJob(
  db: Db,
  job: Omit<RollbackJob, "createdAt" | "updatedAt">,
): RollbackJob {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO rollback_jobs
       (id, project_id, task_id, source_pr_number, source_commit,
        source_parent_count, branch, worktree_path, rollback_pr_number, status,
        status_reason, gate, decision, approval_notification_id,
        approval_choice, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    job.id,
    job.projectId,
    job.taskId,
    job.sourcePrNumber,
    job.sourceCommit ?? null,
    job.sourceParentCount ?? null,
    job.branch,
    job.worktreePath,
    job.rollbackPrNumber ?? null,
    job.status,
    job.statusReason ?? null,
    job.gate ? JSON.stringify(job.gate) : null,
    job.decision ? JSON.stringify(job.decision) : null,
    job.approvalNotificationId ?? null,
    job.approvalChoice ?? null,
    now,
    now,
  );
  return getRollbackJobForTask(db, job.taskId, job.sourcePrNumber)!;
}

export function updateRollbackJob(
  db: Db,
  id: string,
  updates: Partial<RollbackJob>,
): RollbackJob | null {
  const set = ["updated_at = ?"];
  const values: unknown[] = [new Date().toISOString()];
  const columns: Record<string, string> = {
    sourceCommit: "source_commit",
    sourceParentCount: "source_parent_count",
    branch: "branch",
    worktreePath: "worktree_path",
    rollbackPrNumber: "rollback_pr_number",
    status: "status",
    statusReason: "status_reason",
    approvalNotificationId: "approval_notification_id",
    approvalChoice: "approval_choice",
  };
  for (const [key, column] of Object.entries(columns)) {
    if (key in updates) {
      set.push(`${column} = ?`);
      values.push((updates as Record<string, unknown>)[key] ?? null);
    }
  }
  for (const key of ["gate", "decision"] as const) {
    if (key in updates) {
      set.push(`${key} = ?`);
      const value = updates[key];
      values.push(value == null ? null : JSON.stringify(value));
    }
  }
  values.push(id);
  db.prepare(`UPDATE rollback_jobs SET ${set.join(", ")} WHERE id = ?`).run(
    ...values,
  );
  return getRollbackJob(db, id);
}

export function getRecoverableRollbackJobs(db: Db): RollbackJob[] {
  const placeholders = TERMINAL_ROLLBACK_STATUSES.map(() => "?").join(", ");
  return (
    db
      .prepare(
        `SELECT * FROM rollback_jobs WHERE status NOT IN (${placeholders}) ORDER BY created_at ASC`,
      )
      .all(...TERMINAL_ROLLBACK_STATUSES) as Record<string, unknown>[]
  ).map(mapRollbackJob);
}

// ── Model invocation ledger (B40) ──

function mapInvocation(row: Record<string, unknown>): ModelInvocation {
  return {
    id: asStr(row.id),
    projectId: row.project_id ? asStr(row.project_id) : undefined,
    taskId: row.task_id ? asStr(row.task_id) : undefined,
    runId: row.run_id ? asStr(row.run_id) : undefined,
    stage: asStr(row.stage) as ModelInvocation["stage"],
    model: asStr(row.model) as ModelInvocation["model"],
    runner: asStr(row.runner) as ModelInvocation["runner"],
    effort: asStr(row.effort) || "default",
    startedAt: asStr(row.started_at),
    endedAt: row.ended_at ? asStr(row.ended_at) : undefined,
    outcome: asStr(row.outcome) as ModelInvocation["outcome"],
    exitReason: row.exit_reason ? asStr(row.exit_reason) : undefined,
    costUsd: Number(row.cost_usd),
    tokensIn: Number(row.tokens_in),
    tokensOut: Number(row.tokens_out),
    tokensCached: Number(row.tokens_cached),
  };
}

export function getInvocation(db: Db, id: string): ModelInvocation | null {
  const row = db.prepare("SELECT * FROM model_invocations WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapInvocation(row) : null;
}

export function getInvocations(
  db: Db,
  filter: { projectId?: string; taskId?: string; stage?: ModelInvocation["stage"] } = {},
): ModelInvocation[] {
  const where: string[] = [];
  const values: string[] = [];
  if (filter.projectId) {
    where.push("project_id = ?");
    values.push(filter.projectId);
  }
  if (filter.taskId) {
    where.push("task_id = ?");
    values.push(filter.taskId);
  }
  if (filter.stage) {
    where.push("stage = ?");
    values.push(filter.stage);
  }
  return db
    .prepare(
      `SELECT * FROM model_invocations${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ` +
        "ORDER BY started_at DESC",
    )
    .all(...values)
    .map((row) => mapInvocation(row as Record<string, unknown>));
}

/** Idempotent start write. A duplicate producer cannot replace the original
 * attempt-stable runner/effort/correlation fields. */
export function createInvocation(db: Db, invocation: ModelInvocation): ModelInvocation {
  db.prepare(
    `INSERT OR IGNORE INTO model_invocations (
       id, project_id, task_id, run_id, stage, model, runner, effort,
       started_at, ended_at, outcome, exit_reason, cost_usd,
       tokens_in, tokens_out, tokens_cached
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    invocation.id,
    invocation.projectId ?? null,
    invocation.taskId ?? null,
    invocation.runId ?? null,
    invocation.stage,
    invocation.model,
    invocation.runner,
    invocation.effort,
    invocation.startedAt,
    invocation.endedAt ?? null,
    invocation.outcome,
    invocation.exitReason ?? null,
    invocation.costUsd,
    invocation.tokensIn,
    invocation.tokensOut,
    invocation.tokensCached,
  );
  return getInvocation(db, invocation.id)!;
}

export interface InvocationTerminalResult {
  invocation: ModelInvocation;
  /** True only for the caller that won running -> terminal. */
  transitioned: boolean;
  /** Compatibility cost projection created in the same transaction. */
  cost?: CostRecord;
}

/** Exactly-once terminal transition and cost projection. Keeping both writes
 * in one SQLite transaction prevents a crash from leaving billed usage in
 * one accounting surface but not the other. */
export function terminalizeInvocation(
  db: Db,
  id: string,
  terminal: Pick<
    ModelInvocation,
    | "outcome"
    | "endedAt"
    | "exitReason"
    | "costUsd"
    | "tokensIn"
    | "tokensOut"
    | "tokensCached"
  >,
): InvocationTerminalResult | null {
  if (terminal.outcome === "running") {
    throw new Error("terminal invocation outcome cannot be running");
  }
  return db.transaction((): InvocationTerminalResult | null => {
    const changed = db.prepare(
      `UPDATE model_invocations
       SET ended_at = ?, outcome = ?, exit_reason = ?, cost_usd = ?,
           tokens_in = ?, tokens_out = ?, tokens_cached = ?
       WHERE id = ? AND outcome = 'running'`,
    ).run(
      terminal.endedAt ?? new Date().toISOString(),
      terminal.outcome,
      terminal.exitReason ?? null,
      terminal.costUsd,
      terminal.tokensIn,
      terminal.tokensOut,
      terminal.tokensCached,
      id,
    );
    const invocation = getInvocation(db, id);
    if (!invocation) return null;
    if (changed.changes === 0) return { invocation, transitioned: false };

    let cost: CostRecord | undefined;
    if (invocation.projectId && invocation.costUsd > 0) {
      const costId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO costs (
           id, invocation_id, project_id, model, task_id, run_id,
           cost_usd, tokens_in, tokens_out, tokens_cached, ts
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        costId,
        invocation.id,
        invocation.projectId,
        invocation.model,
        invocation.taskId ?? null,
        invocation.runId ?? null,
        invocation.costUsd,
        invocation.tokensIn,
        invocation.tokensOut,
        invocation.tokensCached,
        invocation.endedAt ?? new Date().toISOString(),
      );
      cost = mapCost(
        db.prepare("SELECT * FROM costs WHERE id = ?").get(costId) as Record<string, unknown>,
      );
    }
    return { invocation, transitioned: true, cost };
  })();
}

// ── Runs (task-attempt compatibility view) ──

function mapRun(row: Record<string, unknown>): Run {
  return {
    id: asStr(row.id),
    // Pre-B15 rows (migrated via ALTER TABLE, no backfill) have NULL here.
    projectId: row.project_id ? asStr(row.project_id) : "",
    taskId: asStr(row.task_id),
    model: asStr(row.model) as Run["model"],
    effort: row.effort ? asStr(row.effort) : undefined,
    attempt: Number(row.attempt),
    status: asStr(row.status) as Run["status"],
    startedAt: asStr(row.started_at),
    endedAt: row.ended_at ? asStr(row.ended_at) : undefined,
    exitReason: row.exit_reason ? asStr(row.exit_reason) : undefined,
    costUsd: Number(row.cost_usd),
    tokensIn: Number(row.tokens_in),
    tokensOut: Number(row.tokens_out),
    tokensCached: row.tokens_cached != null ? Number(row.tokens_cached) : 0,
  };
}

function syncRunInvocation(db: Db, run: Run): void {
  createInvocation(db, {
    id: run.id,
    projectId: run.projectId || undefined,
    taskId: run.taskId,
    runId: run.id,
    stage: run.id.endsWith("-docs") ? "docs" : "author",
    model: run.model,
    runner: "unknown",
    effort: run.effort ?? "default",
    startedAt: run.startedAt,
    outcome: "running",
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    tokensCached: 0,
  });
  if (run.status !== "running") {
    terminalizeInvocation(db, run.id, {
      outcome:
        run.status === "passed"
          ? "completed"
          : run.status === "stopped"
            ? "stopped"
            : "failed",
      endedAt: run.endedAt,
      exitReason: run.exitReason,
      costUsd: run.costUsd,
      tokensIn: run.tokensIn,
      tokensOut: run.tokensOut,
      tokensCached: run.tokensCached ?? 0,
    });
  }
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
    `INSERT INTO runs (id, project_id, task_id, model, effort, attempt, status, started_at, ended_at, exit_reason, cost_usd, tokens_in, tokens_out, tokens_cached)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    r.projectId,
    r.taskId,
    r.model,
    r.effort ?? null,
    r.attempt,
    r.status,
    r.startedAt,
    r.endedAt ?? null,
    r.exitReason ?? null,
    r.costUsd,
    r.tokensIn,
    r.tokensOut,
    r.tokensCached ?? 0,
  );
  const created = getRun(db, id)!;
  syncRunInvocation(db, created);
  return created;
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
    tokensCached: "tokens_cached",
    effort: "effort",
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
    invocationId: row.invocation_id ? asStr(row.invocation_id) : undefined,
    projectId: asStr(row.project_id),
    model: asStr(row.model) as CostRecord["model"],
    taskId: row.task_id ? asStr(row.task_id) : undefined,
    runId: row.run_id ? asStr(row.run_id) : undefined,
    costUsd: Number(row.cost_usd),
    tokensIn: Number(row.tokens_in),
    tokensOut: Number(row.tokens_out),
    tokensCached: row.tokens_cached != null ? Number(row.tokens_cached) : 0,
    ts: asStr(row.ts),
  };
}

export function getCosts(db: Db, projectId: string): CostRecord[] {
  return db
    .prepare(
      `SELECT * FROM costs
       WHERE project_id = ? AND invocation_id IS NOT NULL
       ORDER BY ts DESC`,
    )
    .all(projectId)
    .map((r) => mapCost(r as Record<string, unknown>));
}

export function createCost(
  db: Db,
  c: Omit<CostRecord, "id"> & { id?: string },
): CostRecord {
  const id = c.id ?? crypto.randomUUID();
  const linkedRun = c.runId ? getInvocation(db, c.runId) : null;
  const invocationId = c.invocationId ?? linkedRun?.id ?? `legacy-cost:${id}`;
  const existing = db
    .prepare("SELECT * FROM costs WHERE invocation_id = ?")
    .get(invocationId) as Record<string, unknown> | undefined;
  if (existing) return mapCost(existing);
  if (!linkedRun && !c.invocationId) {
    createInvocation(db, {
      id: invocationId,
      projectId: c.projectId,
      taskId: c.taskId,
      stage: c.taskId ? "validator" : "planner",
      model: c.model,
      runner: "unknown",
      effort: "default",
      startedAt: c.ts,
      endedAt: c.ts,
      outcome: "completed",
      exitReason: "legacy_compatibility_write",
      costUsd: c.costUsd,
      tokensIn: c.tokensIn,
      tokensOut: c.tokensOut,
      tokensCached: c.tokensCached ?? 0,
    });
  }
  db.prepare(
    `INSERT INTO costs (id, invocation_id, project_id, model, task_id, run_id, cost_usd, tokens_in, tokens_out, tokens_cached, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    invocationId,
    c.projectId,
    c.model,
    c.taskId ?? null,
    c.runId ?? null,
    c.costUsd,
    c.tokensIn,
    c.tokensOut,
    c.tokensCached ?? 0,
    c.ts,
  );
  return mapCost(
    db.prepare("SELECT * FROM costs WHERE id = ?").get(id) as Record<string, unknown>,
  );
}

export function getCostSummary(
  db: Db,
  projectId: string,
): { totalUsd: number; byModel: Record<string, number> } {
  const rows = db
    .prepare(
      "SELECT model, SUM(cost_usd) as total FROM model_invocations WHERE project_id = ? GROUP BY model",
    )
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
      `SELECT COALESCE(SUM(cost_usd), 0) as total
       FROM model_invocations WHERE project_id = ? AND started_at >= ?`,
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
         FROM model_invocations
         WHERE project_id = ? GROUP BY model ORDER BY cost DESC`,
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
        `SELECT substr(started_at, 1, 10) AS date, SUM(cost_usd) AS cost
         FROM model_invocations
         WHERE project_id = ? GROUP BY date ORDER BY date ASC`,
      )
      .all(projectId) as Record<string, unknown>[]
  ).map((r) => ({ date: asStr(r.date), costUsd: Number(r.cost) }));

  const byTask = (
    db
      .prepare(
        `SELECT i.task_id AS task_id,
                COALESCE(t.title, '(planning / untracked)') AS title,
                SUM(i.cost_usd) AS cost
         FROM model_invocations i LEFT JOIN tasks t ON t.id = i.task_id
         WHERE i.project_id = ?
         GROUP BY i.task_id ORDER BY cost DESC`,
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
       FROM model_invocations WHERE project_id = ?`,
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
       FROM model_invocations WHERE cost_usd > 0 GROUP BY model`,
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
    .prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) as total FROM model_invocations WHERE model = ? AND started_at >= ?",
    )
    .get(model, firstOfMonthUtc()) as { total: number } | undefined;
  return row ? Number(row.total) : 0;
}

/** Total spend this calendar month across all projects and models. */
export function getGlobalMonthlyCost(db: Db): number {
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) as total FROM model_invocations WHERE started_at >= ?",
    )
    .get(firstOfMonthUtc()) as { total: number } | undefined;
  return row ? Number(row.total) : 0;
}

/**
 * B40: every model invocation and its cost since `sinceIso`, across ALL
 * projects and stages. Started/in-flight calls count immediately because a
 * subscription quota cares about requests made, not eventual outcomes.
 */
export function getModelUsageSince(
  db: Db,
  model: string,
  sinceIso: string,
): { runs: number; costUsd: number } {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS total
       FROM model_invocations WHERE model = ? AND started_at >= ?`,
    )
    .get(model, sinceIso) as { n: number; total: number };
  return { runs: Number(row.n), costUsd: Number(row.total) };
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
    // F22: absent on pre-migration rows (NULL) exactly like any other
    // optional field here — no special-casing needed.
    context: row.context ? json<Notification["context"]>(row.context) : undefined,
  };
}

export function getNotification(db: Db, id: string): Notification | null {
  const row = db.prepare("SELECT * FROM notifications WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapNotification(row) : null;
}

/** B23: newest-first, capped so months of autonomous runs don't hand the
 *  Notifications page (and the U1 nav badge's seed fetch) an ever-growing
 *  list — mirrors the bound `pruneNotifications` below enforces at rest.
 *  B26: the cap alone has no pending-approval exemption the way
 *  `pruneNotifications` does — a pending approval that's sat unanswered
 *  while `limit` newer notifications piled up (a long unattended run) would
 *  silently drop off both the Notifications page and the U1 nav badge's
 *  seed fetch. Union the newest `limit` rows with every still-pending
 *  approval regardless of age, then re-sort; UNION's own row-level dedup
 *  collapses the common case where a pending approval is already within
 *  the newest `limit`. */
export function getNotifications(
  db: Db,
  projectId?: string,
  limit = 200,
): Notification[] {
  let rows: Record<string, unknown>[];
  if (projectId) {
    rows = db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM notifications WHERE project_id = ? ORDER BY created_at DESC LIMIT ?
         )
         UNION
         SELECT * FROM notifications
         WHERE project_id = ? AND requires_approval = 1 AND responded_with IS NULL
         ORDER BY created_at DESC`,
      )
      .all(projectId, limit, projectId) as Record<string, unknown>[];
  } else {
    rows = db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?
         )
         UNION
         SELECT * FROM notifications
         WHERE requires_approval = 1 AND responded_with IS NULL
         ORDER BY created_at DESC`,
      )
      .all(limit) as Record<string, unknown>[];
  }
  return rows.map(mapNotification);
}

/**
 * B23: mirrors pruneLogs' shape — delete notifications older than
 * `retentionDays`, called on boot and once a day (see index.ts main()).
 * Never deletes a pending approval (requires_approval with no
 * responded_with) regardless of age — B10 already expires those on boot,
 * but an approval a human hasn't seen yet must never just vanish. Returns
 * the number of rows deleted, for a boot-time log line.
 */
export function pruneNotifications(db: Db, retentionDays: number): number {
  const cutoff = new Date(
    Date.now() - retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const result = db
    .prepare(
      `DELETE FROM notifications
       WHERE created_at < ?
         AND NOT (requires_approval = 1 AND responded_with IS NULL)`,
    )
    .run(cutoff);
  return result.changes;
}

export function createNotification(
  db: Db,
  n: Omit<Notification, "id" | "createdAt"> & { id?: string },
): Notification {
  const id = n.id ?? crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO notifications (id, project_id, task_id, severity, title, message, requires_approval, options, created_at, context)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    n.context ? JSON.stringify(n.context) : null,
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
  invocationId?: string;
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
    invocationId: row.invocation_id ? asStr(row.invocation_id) : undefined,
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
    `INSERT INTO model_checks (id, invocation_id, model_id, display_name, ok, cost_usd, ms, reply, error, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    c.invocationId ?? null,
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
 * Rolling failure rate + median duration per model, from every terminal
 * invocation at every stage — cross-project, since a model's reliability
 * isn't a per-project property.
 */
export function getModelRunStats(db: Db): ModelRunStats[] {
  const rows = db
    .prepare(
      `SELECT model, outcome, exit_reason, started_at, ended_at
       FROM model_invocations WHERE ended_at IS NOT NULL`,
    )
    .all() as {
    model: string;
    outcome: string;
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
      r.outcome === "failed" ||
      r.outcome === "interrupted" ||
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
  return row ? normalizeSettings(json<unknown>(row.json)) : null;
}

export function upsertSettings(db: Db, s: unknown): Settings {
  const normalized = normalizeSettings(s);
  db.prepare(
    `INSERT INTO settings (id, json) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
  ).run(JSON.stringify(normalized));
  return getSettings(db)!;
}
