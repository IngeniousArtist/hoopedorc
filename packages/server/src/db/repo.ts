import type {
  AuditEntry,
  CostRecord,
  DraftTask,
  LogEvent,
  MergeDecision,
  ModelId,
  ModelInvocation,
  Notification,
  PlanChatMessage,
  Project,
  ProjectConfig,
  RollbackJob,
  Run,
  Settings,
  Task,
  VerifiedFigmaReference,
} from "@orc/types";
import { createHash, randomUUID } from "node:crypto";
import type { Db } from "./index";
import { normalizeSettings } from "../config";
import { TaskChangeBus, type TaskChangeWaitResult } from "../task-change-bus";

const taskChangeBuses = new WeakMap<Db, TaskChangeBus>();

function taskChangeBus(db: Db): TaskChangeBus {
  let bus = taskChangeBuses.get(db);
  if (!bus) {
    bus = new TaskChangeBus();
    taskChangeBuses.set(db, bus);
  }
  return bus;
}

function publishTaskChange(db: Db, projectId: string): void {
  taskChangeBus(db).notify(projectId);
}

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
 * merge decisions, invocations, costs, notifications, project budget alerts,
 * planning receipts, audit log). SQLite FKs are enforced
 * (PRAGMA foreign_keys = ON), so children must go first; wrapped in a
 * transaction so a partial delete can't leave orphans.
 */
export function deleteProject(db: Db, id: string): void {
  const run = db.transaction((projectId: string) => {
    const taskIds = (
      db.prepare("SELECT id FROM tasks WHERE project_id = ?").all(projectId) as { id: string }[]
    ).map((r) => r.id);

    db.prepare("DELETE FROM logs WHERE project_id = ?").run(projectId);
    for (const taskId of taskIds) {
      db.prepare("DELETE FROM merge_decisions WHERE task_id = ?").run(taskId);
      db.prepare("DELETE FROM runs WHERE task_id = ?").run(taskId);
    }
    db.prepare("DELETE FROM costs WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM model_invocations WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM notifications WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM budget_alerts WHERE scope = ?").run(`project:${projectId}`);
    db.prepare("DELETE FROM audit_log WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM rollback_jobs WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM planning_commits WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM tasks WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
  });
  run(id);
}

// ── Planning session ──

export interface PlanningSessionUpdate {
  messages?: PlanChatMessage[];
  prd?: string | null;
  draftTasks?: DraftTask[] | null;
  /** F38: AGENTS.md draft from the last deconstruct, cleared at
   *  /plan/commit like `prd`. */
  agentsMd?: string | null;
  /** F52: small verified exact-node list, retained on failed retries. */
  verifiedFigmaReferences?: VerifiedFigmaReference[] | null;
  /** F28: the archived markdown session file this session is being
   *  written to. `null` clears it (done at /plan/commit, so the next
   *  chat turn mints a fresh file for the next session). */
  sessionFile?: string | null;
  /** O3: set only when creating or clearing the active revision. */
  revisionId?: string | null;
}

function planningSessionAssignments(opts: PlanningSessionUpdate): {
  sets: string[];
  vals: unknown[];
} {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (opts.messages !== undefined) {
    sets.push("planning_messages = ?");
    vals.push(JSON.stringify(opts.messages));
  }
  if (opts.prd !== undefined) {
    sets.push("planning_prd = ?");
    vals.push(opts.prd ?? null);
  }
  if (opts.draftTasks !== undefined) {
    sets.push("planning_draft_tasks = ?");
    vals.push(opts.draftTasks ? JSON.stringify(opts.draftTasks) : null);
  }
  if (opts.agentsMd !== undefined) {
    sets.push("planning_agents_md = ?");
    vals.push(opts.agentsMd ?? null);
  }
  if (opts.verifiedFigmaReferences !== undefined) {
    sets.push("planning_figma_refs = ?");
    vals.push(
      opts.verifiedFigmaReferences
        ? JSON.stringify(opts.verifiedFigmaReferences)
        : null,
    );
  }
  if (opts.sessionFile !== undefined) {
    sets.push("planning_session_file = ?");
    vals.push(opts.sessionFile ?? null);
  }
  if (opts.revisionId !== undefined) {
    sets.push("planning_revision_id = ?");
    vals.push(opts.revisionId ?? null);
  }
  return { sets, vals };
}

export function savePlanningSession(
  db: Db,
  projectId: string,
  opts: PlanningSessionUpdate,
): void {
  const { sets, vals } = planningSessionAssignments(opts);
  if (sets.length === 0) return;
  vals.push(projectId);
  db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

/** O3: update scratch only while the caller still owns this exact revision. */
export function savePlanningSessionForRevision(
  db: Db,
  projectId: string,
  revisionId: string,
  opts: PlanningSessionUpdate,
): boolean {
  const { sets, vals } = planningSessionAssignments(opts);
  if (sets.length === 0) return false;
  vals.push(projectId, revisionId);
  const result = db
    .prepare(
      `UPDATE projects SET ${sets.join(", ")}
       WHERE id = ? AND planning_revision_id = ?`,
    )
    .run(...vals);
  return result.changes === 1;
}

/** O3: lazily mint one revision for an otherwise empty planning session. */
export function ensurePlanningRevision(db: Db, projectId: string): string {
  const row = db
    .prepare("SELECT planning_revision_id FROM projects WHERE id = ?")
    .get(projectId) as { planning_revision_id: string | null } | undefined;
  if (!row) throw new Error("project not found");
  if (row.planning_revision_id) return row.planning_revision_id;

  const revisionId = randomUUID();
  const assigned = db
    .prepare(
      `UPDATE projects SET planning_revision_id = ?
       WHERE id = ? AND planning_revision_id IS NULL`,
    )
    .run(revisionId, projectId);
  if (assigned.changes === 1) return revisionId;

  const current = db
    .prepare("SELECT planning_revision_id FROM projects WHERE id = ?")
    .get(projectId) as { planning_revision_id: string | null } | undefined;
  if (!current?.planning_revision_id) {
    throw new Error("could not initialize planning revision");
  }
  return current.planning_revision_id;
}

export function getPlanningSession(
  db: Db,
  projectId: string,
): {
  messages: PlanChatMessage[];
  prd?: string;
  draftTasks?: DraftTask[];
  agentsMd?: string;
  verifiedFigmaReferences?: VerifiedFigmaReference[];
  sessionFile?: string;
  revisionId?: string;
} {
  const row = db
    .prepare(
      "SELECT planning_messages, planning_prd, planning_draft_tasks, planning_agents_md, planning_figma_refs, planning_session_file, planning_revision_id FROM projects WHERE id = ?",
    )
    .get(projectId) as
    | {
        planning_messages: string | null;
        planning_prd: string | null;
        planning_draft_tasks: string | null;
        planning_agents_md: string | null;
        planning_figma_refs: string | null;
        planning_session_file: string | null;
        planning_revision_id: string | null;
      }
    | undefined;
  if (!row) return { messages: [] };
  return {
    messages: row.planning_messages ? (JSON.parse(row.planning_messages) as PlanChatMessage[]) : [],
    prd: row.planning_prd ?? undefined,
    draftTasks: row.planning_draft_tasks ? (JSON.parse(row.planning_draft_tasks) as DraftTask[]) : undefined,
    agentsMd: row.planning_agents_md ?? undefined,
    verifiedFigmaReferences: row.planning_figma_refs
      ? (JSON.parse(row.planning_figma_refs) as VerifiedFigmaReference[])
      : undefined,
    sessionFile: row.planning_session_file ?? undefined,
    revisionId: row.planning_revision_id ?? undefined,
  };
}

export interface PlanningCommitReceipt {
  projectId: string;
  revisionId: string;
  state: "pending" | "successful";
  contentHash: string;
  createdTaskIds: string[];
  result?: unknown;
}

export function getPlanningCommitReceipt(
  db: Db,
  projectId: string,
  revisionId: string,
): PlanningCommitReceipt | undefined {
  const row = db
    .prepare(
      `SELECT project_id, revision_id, state, content_hash,
              created_task_ids, result_json
       FROM planning_commits
       WHERE project_id = ? AND revision_id = ?`,
    )
    .get(projectId, revisionId) as
    | {
        project_id: string;
        revision_id: string;
        state: "pending" | "successful";
        content_hash: string;
        created_task_ids: string;
        result_json: string | null;
      }
    | undefined;
  if (!row) return undefined;
  return {
    projectId: row.project_id,
    revisionId: row.revision_id,
    state: row.state,
    contentHash: row.content_hash,
    createdTaskIds: json<string[]>(row.created_task_ids),
    result: row.result_json ? json<unknown>(row.result_json) : undefined,
  };
}

export function createPendingPlanningCommit(
  db: Db,
  projectId: string,
  revisionId: string,
  contentHash: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO planning_commits (
       project_id, revision_id, state, content_hash, created_task_ids,
       result_json, created_at, updated_at
     ) VALUES (?, ?, 'pending', ?, '[]', NULL, ?, ?)`,
  ).run(projectId, revisionId, contentHash, now, now);
}

export function completePlanningCommit(
  db: Db,
  projectId: string,
  revisionId: string,
  contentHash: string,
  createdTaskIds: string[],
  result: unknown,
): boolean {
  const updated = db.prepare(
    `UPDATE planning_commits
     SET state = 'successful', created_task_ids = ?, result_json = ?,
         updated_at = ?
     WHERE project_id = ? AND revision_id = ? AND content_hash = ?
       AND state = 'pending'`,
  ).run(
    JSON.stringify(createdTaskIds),
    JSON.stringify(result),
    new Date().toISOString(),
    projectId,
    revisionId,
    contentHash,
  );
  return updated.changes === 1;
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
    runGeneration: Number(row.run_generation ?? 0),
    runExtraAttempts: Number(row.run_extra_attempts ?? 0),
    runModel: row.run_model
      ? (asStr(row.run_model) as Task["runModel"])
      : undefined,
    runExhaustedModels: row.run_exhausted_models
      ? json<Task["runExhaustedModels"]>(row.run_exhausted_models)
      : [],
    runRateLimitRetries: Number(row.run_rate_limit_retries ?? 0),
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

/**
 * O36: every non-terminal task whose assigned model is not in `knownModelIds`,
 * for the settings-save dangling-model warning. One statement replaces the
 * projects×tasks loop that read and mapped every task row on each save. The
 * CROSS JOIN pins the project→tasks join order so SQLite searches tasks
 * through `idx_tasks_project` instead of scanning the whole table, and the
 * ordering mirrors the replaced loop: newest project first, oldest task first.
 */
export function getDanglingModelTasks(
  db: Db,
  knownModelIds: readonly string[],
): Task[] {
  const missingModel = knownModelIds.length
    ? `AND t.assigned_model NOT IN (${knownModelIds.map(() => "?").join(", ")})`
    : "";
  return db
    .prepare(
      `SELECT t.*
       FROM projects AS p
       CROSS JOIN tasks AS t ON t.project_id = p.id
       WHERE t.status NOT IN ('done', 'failed') ${missingModel}
       ORDER BY p.created_at DESC, t.created_at ASC`,
    )
    .all(...knownModelIds)
    .map((r) => mapTask(r as Record<string, unknown>));
}

/** O35 durable generation maintained by SQLite triggers on every task write. */
export function getTaskGeneration(db: Db, projectId: string): number {
  const row = db
    .prepare("SELECT task_generation FROM projects WHERE id = ?")
    .get(projectId) as { task_generation: number } | undefined;
  return Number(row?.task_generation ?? 0);
}

/** O35 same-process edge token; durable correctness still comes from SQLite. */
export function getTaskWakeVersion(db: Db, projectId: string): number {
  return taskChangeBus(db).currentVersion(projectId);
}

/** Wait for a repository task write or the scheduler's bounded deadline. */
export function waitForTaskChange(
  db: Db,
  projectId: string,
  afterVersion: number,
  deadlineMs: number,
): Promise<TaskChangeWaitResult> {
  return taskChangeBus(db).waitForChange(projectId, afterVersion, deadlineMs);
}

export function createTask(
  db: Db,
  t: Omit<
    Task,
    | "createdAt"
    | "updatedAt"
    | "runGeneration"
    | "runExtraAttempts"
    | "runExhaustedModels"
    | "runRateLimitRetries"
  > &
    Partial<
      Pick<
        Task,
        | "runGeneration"
        | "runExtraAttempts"
        | "runExhaustedModels"
        | "runRateLimitRetries"
      >
    >,
): Task {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tasks (
       id, project_id, title, description, difficulty, status, depends_on,
       acceptance_criteria, assigned_model, role, scope_paths, attempts,
       max_attempts, run_generation, run_extra_attempts, run_model,
       run_exhausted_models, run_rate_limit_retries, dispatch_requested_at,
       created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    t.runGeneration ?? 0,
    t.runExtraAttempts ?? 0,
    t.runModel ?? null,
    JSON.stringify(t.runExhaustedModels ?? []),
    t.runRateLimitRetries ?? 0,
    t.dispatchRequestedAt ?? null,
    now,
    now,
  );
  const created = getTask(db, t.id)!;
  publishTaskChange(db, t.projectId);
  return created;
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
    runGeneration: "run_generation",
    runExtraAttempts: "run_extra_attempts",
    runModel: "run_model",
    runRateLimitRetries: "run_rate_limit_retries",
    dispatchRequestedAt: "dispatch_requested_at",
    statusReason: "status_reason",
  };
  const jsonCols = new Set([
    "dependsOn",
    "acceptanceCriteria",
    "scopePaths",
    "runExhaustedModels",
  ]);

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
  const changed = db
    .prepare(
      `UPDATE tasks SET ${set.join(", ")} WHERE id = ? RETURNING project_id`,
    )
    .get(...vals) as { project_id: string } | undefined;
  const task = getTask(db, id);
  if (changed) publishTaskChange(db, changed.project_id);
  return task;
}

/**
 * Start one new logical run for a retryable task. The conditional write and
 * audit insert share one SQLite transaction, so concurrent HTTP/Telegram
 * callers cannot both increment the generation or create duplicate audits.
 */
export function resetTaskForRetry(
  db: Db,
  id: string,
  actor: "human" | "telegram",
): Task | null {
  let projectId: string | undefined;
  const reset = db.transaction(() => {
    const now = new Date().toISOString();
    const won = db.prepare(
      `UPDATE tasks
       SET status = 'backlog',
           attempts = 0,
           run_generation = run_generation + 1,
           run_extra_attempts = 0,
           run_model = NULL,
           run_exhausted_models = '[]',
           run_rate_limit_retries = 0,
           pr_number = NULL,
           branch = NULL,
           worktree_path = NULL,
           dispatch_requested_at = ?,
           status_reason = NULL,
           updated_at = ?
       WHERE id = ?
         AND status IN ('failed', 'changes_requested', 'blocked')
       RETURNING project_id, title`,
    ).get(now, now, id) as { project_id: string; title: string } | undefined;
    if (!won) return null;
    projectId = won.project_id;

    createAuditEntry(db, {
      projectId: won.project_id,
      taskId: id,
      kind: "retry",
      actor,
      summary: `Retried "${won.title}"`,
    });
    return getTask(db, id);
  })();
  if (projectId) publishTaskChange(db, projectId);
  return reset;
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
  const cleared = requested.flatMap(({ id }) => {
    const task = getTask(db, id);
    return task ? [task] : [];
  });
  publishTaskChange(db, projectId);
  return cleared;
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
  const task = getTask(db, id);
  if (result.changes > 0 && task) publishTaskChange(db, task.projectId);
  return { changed: result.changes > 0, task };
}

/**
 * O14 phase one: durably claim a still-active task before crossing the
 * process-cancellation boundary. A crash after this write is recovered on
 * boot by finalizeTaskStop(); no unrelated task state is changed here.
 */
export function claimTaskStop(
  db: Db,
  id: string,
): { claimed: boolean; pending: boolean; task: Task | null } {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE tasks
       SET stop_requested_at = ?, updated_at = ?
       WHERE id = ?
         AND status IN ('in_progress', 'in_review')
         AND stop_requested_at IS NULL`,
    )
    .run(now, now, id);
  const task = getTask(db, id);
  const pending = Boolean(
    db
      .prepare("SELECT 1 FROM tasks WHERE id = ? AND stop_requested_at IS NOT NULL")
      .get(id),
  );
  if (result.changes > 0 && task) publishTaskChange(db, task.projectId);
  return { claimed: result.changes === 1, pending, task };
}

/** Cancellation was refused before any process was signalled; release only
 * the matching durable intent and leave task/run/audit state untouched. */
export function releaseTaskStop(db: Db, id: string): Task | null {
  const result = db
    .prepare(
      `UPDATE tasks
       SET stop_requested_at = NULL, updated_at = ?
       WHERE id = ? AND stop_requested_at IS NOT NULL`,
    )
    .run(new Date().toISOString(), id);
  const task = getTask(db, id);
  if (result.changes > 0 && task) publishTaskChange(db, task.projectId);
  return task;
}

export interface TaskStopTransition {
  changed: boolean;
  task: Task | null;
  runs: Run[];
  audit?: AuditEntry;
}

/**
 * O14 phase two: after cancellation is accepted, commit the task, every
 * still-running attempt, the audit entry, and intent removal atomically.
 * Callers broadcast only the returned post-commit rows.
 */
export function finalizeTaskStop(
  db: Db,
  id: string,
  actor: "human" | "telegram" = "human",
  reason = "Stopped by user",
): TaskStopTransition {
  let projectId: string | undefined;
  const outcome = db.transaction((): TaskStopTransition => {
    const before = db
      .prepare("SELECT project_id, title, stop_requested_at FROM tasks WHERE id = ?")
      .get(id) as
      | { project_id: string; title: string; stop_requested_at: string | null }
      | undefined;
    if (!before) return { changed: false, task: null, runs: [] };
    projectId = before.project_id;
    if (!before.stop_requested_at) {
      return { changed: false, task: getTask(db, id), runs: [] };
    }

    const now = new Date().toISOString();
    const changed = db
      .prepare(
        `UPDATE tasks
         SET status = 'blocked', status_reason = ?, dispatch_requested_at = NULL,
             stop_requested_at = NULL, updated_at = ?
         WHERE id = ?
           AND stop_requested_at IS NOT NULL
           AND status IN ('in_progress', 'in_review')`,
      )
      .run(reason, now, id).changes === 1;

    if (!changed) {
      db.prepare(
        "UPDATE tasks SET stop_requested_at = NULL, updated_at = ? WHERE id = ?",
      ).run(now, id);
      return { changed: false, task: getTask(db, id), runs: [] };
    }

    const runningIds = db
      .prepare("SELECT id FROM runs WHERE task_id = ? AND status = 'running'")
      .all(id) as { id: string }[];
    db.prepare(
      `UPDATE runs
       SET status = 'stopped', ended_at = ?, exit_reason = 'killed'
       WHERE task_id = ? AND status = 'running'`,
    ).run(now, id);
    const runs = runningIds.flatMap(({ id: runId }) => {
      const run = getRun(db, runId);
      return run ? [run] : [];
    });
    const audit = createAuditEntry(db, {
      projectId: before.project_id,
      taskId: id,
      kind: "stopped",
      actor,
      summary: `Stopped "${before.title}" — agent process aborted`,
    });
    return { changed: true, task: getTask(db, id), runs, audit };
  })();
  if (projectId) publishTaskChange(db, projectId);
  return outcome;
}

/** Complete every Stop intent left between cancellation and commit. This is
 * called before engine resume, so killed work can never enter orphan requeue. */
export function recoverInterruptedTaskStops(db: Db): TaskStopTransition[] {
  const ids = db
    .prepare("SELECT id FROM tasks WHERE stop_requested_at IS NOT NULL ORDER BY id")
    .all() as { id: string }[];
  return ids.map(({ id }) =>
    finalizeTaskStop(db, id, "human", "Stopped by user (recovered after restart)"),
  );
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

/**
 * O36: Fetch every task run for one project with the existing task/project
 * indexes. The caller groups this newest-first stream while it owns the task
 * order, avoiding one getRuns() query per task in a WebSocket catch-up.
 */
export function getRunsForProject(db: Db, projectId: string): Run[] {
  return db
    .prepare(
      `SELECT r.*
       FROM tasks AS t
       INNER JOIN runs AS r ON r.task_id = t.id
       WHERE t.project_id = ?
       ORDER BY r.started_at DESC`,
    )
    .all(projectId)
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
    approvalDelivery: row.approval_delivery
      ? (asStr(row.approval_delivery) as Notification["approvalDelivery"])
      : undefined,
    responseRecordedAt: row.response_recorded_at
      ? asStr(row.response_recorded_at)
      : undefined,
    responseAppliedAt: row.response_applied_at
      ? asStr(row.response_applied_at)
      : undefined,
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

/** B42: capability alerts must remain deduplicated across server restarts. */
export function getNotificationByCapabilityKey(
  db: Db,
  taskId: string,
  capabilityKey: string,
): Notification | null {
  const rows = db
    .prepare(
      `SELECT * FROM notifications
       WHERE task_id = ? AND context IS NOT NULL
       ORDER BY created_at DESC`,
    )
    .all(taskId) as Record<string, unknown>[];
  for (const row of rows) {
    const notification = mapNotification(row);
    if (notification.context?.capabilityKey === capabilityKey) {
      return notification;
    }
  }
  return null;
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
 * Never deletes a pending or recorded-but-unapplied approval regardless of
 * age. O14 may need either row after restart, so retention cannot erase the
 * durable inbox/outbox before delivery. Returns the number of rows deleted,
 * for a boot-time log line.
 */
export function pruneNotifications(db: Db, retentionDays: number): number {
  const cutoff = new Date(
    Date.now() - retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const result = db
    .prepare(
      `DELETE FROM notifications
       WHERE created_at < ?
         AND NOT (
           requires_approval = 1
           AND approval_delivery IN ('pending', 'recorded')
         )`,
    )
    .run(cutoff);
  return result.changes;
}

export function createNotification(
  db: Db,
  n: Omit<
    Notification,
    | "id"
    | "createdAt"
    | "approvalDelivery"
    | "responseRecordedAt"
    | "responseAppliedAt"
  > & { id?: string; approvalKey?: string },
): Notification {
  const id = n.id ?? crypto.randomUUID();
  const now = new Date().toISOString();
  const delivery = n.requiresApproval
    ? n.respondedWith === CANCELLED_STOP
      ? "cancelled"
      : n.respondedWith === EXPIRED_RESTART
        ? "expired_no_owner"
        : n.respondedWith
          ? "applied"
          : "pending"
    : null;
  db.prepare(
    `INSERT INTO notifications
       (id, project_id, task_id, severity, title, message, requires_approval,
        options, responded_with, approval_key, approval_delivery,
        response_recorded_at, response_applied_at, created_at, context)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    n.projectId,
    n.taskId ?? null,
    n.severity,
    n.title,
    n.message,
    n.requiresApproval ? 1 : 0,
    n.options ? JSON.stringify(n.options) : null,
    n.respondedWith ?? null,
    n.approvalKey ?? null,
    delivery,
    n.respondedWith ? now : null,
    delivery === "applied" ? now : null,
    now,
    n.context ? JSON.stringify(n.context) : null,
  );
  return getNotification(db, id)!;
}

type ApprovalNotificationInput = Omit<
  Parameters<typeof createNotification>[1],
  "id" | "approvalKey" | "respondedWith" | "requiresApproval"
> & { requiresApproval: true };

function approvalKey(n: ApprovalNotificationInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        n.projectId,
        n.taskId ?? null,
        n.title,
        n.message,
        n.options ?? [],
      ]),
    )
    .digest("hex");
}

/** Reattach restart recovery to the exact pending/recorded prompt. The
 * partial unique index is the final guard if two owners race this lookup. */
export function createOrReuseApprovalNotification(
  db: Db,
  n: ApprovalNotificationInput,
): { notification: Notification; created: boolean } {
  const key = approvalKey(n);
  return db.transaction(() => {
    const existing = db
      .prepare(
        `SELECT * FROM notifications
         WHERE approval_key = ?
           AND approval_delivery IN ('pending', 'recorded')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(key) as Record<string, unknown> | undefined;
    if (existing) {
      return { notification: mapNotification(existing), created: false };
    }
    return {
      notification: createNotification(db, { ...n, approvalKey: key }),
      created: true,
    };
  })();
}

export type ApprovalResponseOutcome =
  | "recorded"
  | "retry_recorded"
  | "already_applied"
  | "invalid_choice"
  | "conflict"
  | "terminal"
  | "not_found";

export interface ApprovalResponseResult {
  outcome: ApprovalResponseOutcome;
  notification: Notification | null;
}

/** O14 durable inbox claim: the choice and audit either both commit or both
 * roll back. No resolver, Git call, or broadcast runs inside this transaction. */
export function recordApprovalResponse(
  db: Db,
  id: string,
  choice: string,
  actor: "human" | "telegram" = "human",
): ApprovalResponseResult {
  return db.transaction((): ApprovalResponseResult => {
    const current = getNotification(db, id);
    if (!current) return { outcome: "not_found", notification: null };
    if (!current.requiresApproval) {
      return { outcome: "terminal", notification: current };
    }
    if (current.options && !current.options.includes(choice)) {
      return { outcome: "invalid_choice", notification: current };
    }
    if (current.approvalDelivery === "pending" && !current.respondedWith) {
      const now = new Date().toISOString();
      const won = db
        .prepare(
          `UPDATE notifications
           SET responded_with = ?, approval_delivery = 'recorded',
               response_recorded_at = ?
           WHERE id = ?
             AND responded_with IS NULL
             AND approval_delivery = 'pending'`,
        )
        .run(choice, now, id);
      if (won.changes !== 1) {
        const raced = getNotification(db, id);
        return { outcome: "conflict", notification: raced };
      }
      createAuditEntry(db, {
        projectId: current.projectId,
        taskId: current.taskId,
        kind: "approval_resolved",
        actor,
        summary: `${current.title} → ${choice} (recorded for delivery)`,
        detail: { approvalNotificationId: id, choice },
      });
      return { outcome: "recorded", notification: getNotification(db, id) };
    }
    if (
      current.approvalDelivery === "recorded" &&
      current.respondedWith === choice
    ) {
      return { outcome: "retry_recorded", notification: current };
    }
    if (
      current.approvalDelivery === "applied" &&
      current.respondedWith === choice
    ) {
      return { outcome: "already_applied", notification: current };
    }
    return {
      outcome:
        current.approvalDelivery === "cancelled" ||
        current.approvalDelivery === "expired_no_owner"
          ? "terminal"
          : "conflict",
      notification: current,
    };
  })();
}

/** Mark only the exact recorded choice as delivered. */
export function markApprovalApplied(
  db: Db,
  id: string,
  choice: string,
): Notification | null {
  const result = db
    .prepare(
      `UPDATE notifications
       SET approval_delivery = 'applied', response_applied_at = ?
       WHERE id = ?
         AND approval_delivery = 'recorded'
         AND responded_with = ?`,
    )
    .run(new Date().toISOString(), id, choice);
  if (result.changes !== 1) return null;
  return getNotification(db, id);
}

/** True when a recorded choice can still be attached after runtime recovery. */
export function hasRecoverableApprovalOwner(db: Db, id: string): boolean {
  const task = db
    .prepare(
      `SELECT 1
       FROM notifications n
       JOIN tasks t ON t.id = n.task_id
       WHERE n.id = ?
         AND n.approval_key IS NOT NULL
         AND t.status IN ('in_progress', 'in_review')`,
    )
    .get(id);
  if (task) return true;
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM rollback_jobs
         WHERE approval_notification_id = ?
           AND status NOT IN ('completed', 'rejected', 'conflicted', 'failed')`,
      )
      .get(id),
  );
}

/** A recorded response with no live or recoverable owner is terminal, but its
 * human choice remains visible and is never labeled as applied. */
export function expireRecordedApprovalNoOwner(
  db: Db,
  id: string,
): Notification | null {
  return db.transaction(() => {
    const current = getNotification(db, id);
    if (!current || current.approvalDelivery !== "recorded") return null;
    const changed = db
      .prepare(
        `UPDATE notifications
         SET approval_delivery = 'expired_no_owner'
         WHERE id = ? AND approval_delivery = 'recorded'`,
      )
      .run(id);
    if (changed.changes !== 1) return null;
    createAuditEntry(db, {
      projectId: current.projectId,
      taskId: current.taskId,
      kind: "approval_delivery_expired",
      actor: "engine",
      summary: `${current.title} → ${current.respondedWith ?? "unknown"} (not applied — no owner)`,
      detail: { approvalNotificationId: id },
    });
    return getNotification(db, id);
  })();
}

/** Compatibility helper for already-owned delivery sites. New route paths
 * must use recordApprovalResponse() before releasing a waiter. */
export function respondToNotification(
  db: Db,
  id: string,
  choice: string,
): Notification | null {
  const recorded = recordApprovalResponse(db, id, choice);
  if (
    recorded.outcome !== "recorded" &&
    recorded.outcome !== "retry_recorded" &&
    recorded.outcome !== "already_applied"
  ) {
    return recorded.notification;
  }
  return markApprovalApplied(db, id, choice) ?? recorded.notification;
}

/** Terminal response recorded when hard Stop aborts a live approval waiter. */
export const CANCELLED_STOP = "cancelled_stop";

/**
 * Cancel only an approval that is still pending. The conditional update makes
 * a concurrent human response and hard Stop single-winner: an answer already
 * persisted by the response path is never overwritten by cancellation.
 */
export function cancelPendingApproval(
  db: Db,
  id: string,
): Notification | null {
  const result = db
    .prepare(
      `UPDATE notifications
       SET responded_with = ?, approval_delivery = 'cancelled',
           response_recorded_at = ?
       WHERE id = ?
         AND requires_approval = 1
         AND responded_with IS NULL
         AND approval_delivery = 'pending'`,
    )
    .run(CANCELLED_STOP, new Date().toISOString(), id);
  return result.changes === 1 ? getNotification(db, id) : null;
}

/**
 * The legacy `responded_with` value used only for an unkeyed pre-O14 pending
 * row. Keyed pending/recorded rows now reattach after restart instead.
 */
export const EXPIRED_RESTART = "expired_restart";

/**
 * Compatibility migration/helper: expire only pending rows that lack O14's
 * durable approval identity. New engine-created approvals are never swept.
 */
export function expireStaleApprovals(db: Db): number {
  const result = db
    .prepare(
      `UPDATE notifications
       SET responded_with = ?, approval_delivery = 'expired_no_owner',
           response_recorded_at = ?
       WHERE requires_approval = 1
         AND responded_with IS NULL
         AND approval_delivery = 'pending'
         AND approval_key IS NULL`,
    )
    .run(EXPIRED_RESTART, new Date().toISOString());
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

// ── Persisted model cooldowns (B41) ──

export interface ModelCooldownRecord {
  modelId: ModelId;
  until: string;
  reason: string;
  updatedAt: string;
}

function mapModelCooldown(row: Record<string, unknown>): ModelCooldownRecord {
  return {
    modelId: asStr(row.model_id) as ModelId,
    until: asStr(row.until),
    reason: asStr(row.reason),
    updatedAt: asStr(row.updated_at),
  };
}

export function setModelCooldown(
  db: Db,
  modelId: ModelId,
  until: string,
  reason = "rate_limited",
): ModelCooldownRecord {
  const updatedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO model_cooldowns (model_id, until, reason, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(model_id) DO UPDATE SET
       until = excluded.until,
       reason = excluded.reason,
       updated_at = excluded.updated_at`,
  ).run(modelId, until, reason, updatedAt);
  return getModelCooldown(db, modelId)!;
}

export function getModelCooldown(
  db: Db,
  modelId: ModelId,
): ModelCooldownRecord | null {
  const row = db
    .prepare("SELECT * FROM model_cooldowns WHERE model_id = ?")
    .get(modelId) as Record<string, unknown> | undefined;
  return row ? mapModelCooldown(row) : null;
}

export function clearModelCooldown(db: Db, modelId: ModelId): void {
  db.prepare("DELETE FROM model_cooldowns WHERE model_id = ?").run(modelId);
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
