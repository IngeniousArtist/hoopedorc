import { randomUUID } from "node:crypto";
import type { PlanChangeReview, ReviewPlanChangesRequest, Settings, Task } from "@orc/types";
import type { Db } from "./db/index";
import * as repo from "./db/repo";

export class PlanChangeError extends Error {
  constructor(message: string, readonly code = "PLAN_CHANGES_STALE", readonly status = 409) { super(message); }
}

export function pendingPlanChange(db: Db, projectId: string): boolean {
  return !!db.prepare("SELECT 1 FROM plan_change_reviews WHERE project_id = ? AND state = 'applying'").get(projectId);
}

export function getPlanChange(db: Db, projectId: string, id: string): PlanChangeReview | null {
  const row = db.prepare("SELECT state, review_json FROM plan_change_reviews WHERE project_id = ? AND id = ?")
    .get(projectId, id) as { state: PlanChangeReview["state"]; review_json: string } | undefined;
  return row ? { ...JSON.parse(row.review_json) as PlanChangeReview, state: row.state } : null;
}

export function latestPlanChange(db: Db, projectId: string, revisionId: string): PlanChangeReview | null {
  const row = db.prepare("SELECT id FROM plan_change_reviews WHERE project_id = ? AND revision_id = ? ORDER BY (state = 'applying') DESC, rowid DESC LIMIT 1")
    .get(projectId, revisionId) as { id: string } | undefined;
  return row ? getPlanChange(db, projectId, row.id) : null;
}

export function taskCanBeRevised(task: Task): boolean {
  return ["ready", "backlog", "blocked"].includes(task.status) && task.attempts === 0 &&
    task.runGeneration === 0 && !task.branch && !task.worktreePath && task.prNumber === undefined;
}

export function assertPlanChangeCurrent(db: Db, review: PlanChangeReview, retry = false): void {
  const session = repo.getPlanningSession(db, review.projectId);
  if (session.revisionId !== review.input.revisionId || (!retry && session.sessionVersion !== review.input.sessionVersion) ||
      repo.getTaskGeneration(db, review.projectId) !== review.input.taskGeneration) {
    throw new PlanChangeError("The plan or task state changed after this comparison. Refresh and review the changes again.");
  }
}

/** Validate at the untrusted API boundary before any reviewed intent is stored. */
export function validatePlanChangeInput(value: unknown): asserts value is ReviewPlanChangesRequest {
  const bad = () => { throw new PlanChangeError("A versioned brief and valid task/dependency list are required.", "INVALID_PLAN_CHANGES", 400); };
  if (!value || typeof value !== "object") return bad();
  const v = value as Partial<ReviewPlanChangesRequest>;
  if (typeof v.revisionId !== "string" || typeof v.prdMarkdown !== "string" || !v.prdMarkdown.trim() ||
      (v.agentsMd !== undefined && typeof v.agentsMd !== "string") ||
      !Number.isSafeInteger(v.sessionVersion) || (v.sessionVersion ?? -1) < 0 ||
      !Number.isSafeInteger(v.taskGeneration) || (v.taskGeneration ?? -1) < 0 ||
      !Array.isArray(v.tasks) || !v.tasks.length || v.tasks.length > 500) return bad();
  const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every((item) => typeof item === "string");
  for (const t of v.tasks) {
    if (!t || typeof t.title !== "string" || !t.title.trim() || typeof t.description !== "string" ||
        !["easy", "medium", "hard"].includes(t.difficulty) || typeof t.assignedModel !== "string" ||
        (t.role !== undefined && !["planner", "frontend", "hard", "medium", "docs", "validator", "updates"].includes(t.role)) ||
        (t.existingTaskId !== undefined && (typeof t.existingTaskId !== "string" || !t.existingTaskId.trim())) ||
        !strings(t.acceptanceCriteria) || !strings(t.scopePaths) || !strings(t.existingDependsOn) ||
        !Array.isArray(t.dependsOn) || t.dependsOn.some((n) => !Number.isSafeInteger(n) || n < 0 || n >= v.tasks!.length)) return bad();
  }
}

export function reviewPlanChanges(db: Db, projectId: string, input: ReviewPlanChangesRequest, settings: Settings): PlanChangeReview {
  validatePlanChangeInput(input);
  return db.transaction(() => {
    if (pendingPlanChange(db, projectId) || repo.getPlanningCommitReceipt(db, projectId, input.revisionId)?.state === "pending") {
      throw new PlanChangeError("Finish the pending plan application before creating another comparison.");
    }
    const project = repo.getProject(db, projectId);
    if (!project) throw new PlanChangeError("Project not found.", "NOT_FOUND", 404);
    const tasks = repo.getTasks(db, projectId);
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const seen = new Set<string>();
    const ids = input.tasks.map((t) => t.existingTaskId ?? randomUUID());
    const now = new Date().toISOString();
    const changes = input.tasks.map((draft, index) => {
      const before = draft.existingTaskId ? byId.get(draft.existingTaskId) : undefined;
      if (draft.existingTaskId && (!before || !taskCanBeRevised(before) || repo.getRuns(db, before.id).length || seen.has(before.id))) {
        throw new PlanChangeError("Only never-started pending tasks can be edited once per proposal. Add a follow-up for active or completed work.", "TASK_NOT_EDITABLE");
      }
      if (before) seen.add(before.id);
      if (draft.existingDependsOn.some((id) => !byId.has(id))) throw new PlanChangeError("A dependency is not part of this project.", "INVALID_DEPENDENCY", 400);
      const model = settings.models.find((m) => m.id === draft.assignedModel);
      if (!model?.enabled || settings.routing.validatorByDifficulty[draft.difficulty] === draft.assignedModel) {
        throw new PlanChangeError("Choose an enabled author model different from this task's validator.", "INVALID_MODEL", 400);
      }
      const dependsOn = [...new Set([...draft.dependsOn.map((n) => ids[n]!), ...draft.existingDependsOn])];
      const after: Task = {
        ...(before ?? { id: ids[index]!, projectId, createdAt: now, attempts: 0, maxAttempts: project.config?.maxAttempts ?? 3,
          runGeneration: 0, runExtraAttempts: 0, runExhaustedModels: [], runRateLimitRetries: 0 }),
        title: draft.title, description: draft.description, difficulty: draft.difficulty,
        role: draft.role, assignedModel: draft.assignedModel, acceptanceCriteria: draft.acceptanceCriteria,
        scopePaths: draft.scopePaths, dependsOn, status: dependsOn.length ? "backlog" : "ready",
        statusReason: undefined, dispatchRequestedAt: undefined, updatedAt: now,
      };
      return { before, after };
    });
    const combined = new Map(tasks.map((t) => [t.id, t.dependsOn]));
    for (const c of changes) combined.set(c.after.id, c.after.dependsOn);
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) throw new PlanChangeError("The proposed dependencies contain a cycle.", "INVALID_DEPENDENCY", 400);
      if (visited.has(id)) return;
      const deps = combined.get(id);
      if (!deps) throw new PlanChangeError("The task graph has a missing dependency.", "INVALID_DEPENDENCY", 400);
      visiting.add(id); for (const dep of deps) visit(dep); visiting.delete(id); visited.add(id);
    };
    for (const id of combined.keys()) visit(id);
    const review: PlanChangeReview = { id: randomUUID(), projectId, state: "reviewed", createdAt: now, input,
      previousPrd: project.prd ?? "", changes, retainedTasks: tasks.filter((t) => !seen.has(t.id)) };
    assertPlanChangeCurrent(db, review);
    db.prepare("INSERT INTO plan_change_reviews (id, project_id, revision_id, state, review_json) VALUES (?, ?, ?, 'reviewed', ?)")
      .run(review.id, projectId, input.revisionId, JSON.stringify(review));
    return review;
  })();
}

/** Called only inside approval's transaction, after the existing durable Git boundary. */
export function finalizePlanChanges(db: Db, review: PlanChangeReview): Task[] {
  assertPlanChangeCurrent(db, review, true);
  const changed = db.prepare("UPDATE plan_change_reviews SET state = 'applied' WHERE id = ? AND state = 'applying'").run(review.id);
  if (changed.changes !== 1) throw new PlanChangeError("This comparison no longer owns plan application.");
  return review.changes.map(({ before, after }) => before
    ? repo.updateTask(db, before.id, { title: after.title, description: after.description, difficulty: after.difficulty,
      assignedModel: after.assignedModel, role: after.role, scopePaths: after.scopePaths,
      acceptanceCriteria: after.acceptanceCriteria, dependsOn: after.dependsOn, status: after.status,
      statusReason: undefined, dispatchRequestedAt: undefined })!
    : repo.createTask(db, after));
}
