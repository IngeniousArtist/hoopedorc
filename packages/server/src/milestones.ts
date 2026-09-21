import { DEFAULT_MILESTONE_POLICY, ResourceUnavailableError, completeCriterionEvidence, milestoneGatesPassed, validMilestonePolicy, type DraftTask, type MilestoneOutcome, type MilestoneRepairDraftRequest, type MilestoneRepairDraftResponse, type PlanChangeTask, type Project, type Task } from "@orc/types";
import { taskRunId, type GitService } from "@orc/engine";
import type { Db } from "./db/index";
import * as repo from "./db/repo";

function canonical(value: unknown): string {
  const normalize = (item: unknown): unknown => Array.isArray(item) ? item.map(normalize) : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).filter(([, field]) => field !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, field]) => [key, normalize(field)])) : item;
  return JSON.stringify(normalize(value));
}

export class MilestoneError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}
export function validateMilestoneDrafts(tasks: DraftTask[], allowRepair = false): void {
  for (const [index, task] of tasks.entries()) {
    if (!task || typeof task !== "object") throw new MilestoneError("A valid task draft is required.", 400);
    if (task.existingDependsOn !== undefined && (!Array.isArray(task.existingDependsOn) || task.existingDependsOn.some((id) => typeof id !== "string" || !id.trim()))) throw new MilestoneError("Existing dependencies must be valid task IDs.", 400);
    if (!allowRepair && task.existingDependsOn?.length) throw new MilestoneError("Dependencies on existing work require Review plan changes.", 400);
    if ((task.milestone || task.repairFor) && (!Array.isArray(task.dependsOn) || !Array.isArray(task.acceptanceCriteria) || !Array.isArray(task.scopePaths) || task.dependsOn.some((dependency) => !Number.isInteger(dependency) || dependency < 0 || dependency >= tasks.length || dependency === index))) throw new MilestoneError("Milestone task dependencies must reference other tasks in the reviewed draft.", 400);
    if (task.repairFor && (!allowRepair || typeof task.repairFor.milestoneId !== "string" || !Number.isInteger(task.repairFor.round) || task.repairFor.round < 1 || task.repairFor.round > 5)) throw new MilestoneError("Repair work must come from a versioned milestone repair draft.", 400);
    if (!task.milestone) continue;
    if (!validMilestonePolicy(task.milestone) || !task.dependsOn.length && !(task as PlanChangeTask).existingDependsOn?.length || !task.acceptanceCriteria.length || task.acceptanceCriteria.length > 100 || task.acceptanceCriteria.some((item) => typeof item !== "string" || !item.trim() || item.length > 4000)) {
      throw new MilestoneError("A milestone needs contributing tasks, 1–100 explicit criteria and valid repair limits.", 400);
    }
  }
}
/** Visible before approval; removing this draft is respected. No post-approval insertion. */
export function withMilestoneDraft(tasks: DraftTask[]): DraftTask[] {
  if (!tasks.length || tasks.some((task) => task.milestone)) return tasks;
  const criteria = [...new Set(tasks.filter((task) => task.role !== "docs").flatMap((task) => task.acceptanceCriteria).filter((item) => item.trim()))];
  if (!criteria.length) return tasks;
  const milestones: DraftTask[] = [];
  for (let start = 0; start < criteria.length; start += 100) {
    milestones.push({ title: criteria.length > 100 ? `Verify brief milestone ${milestones.length + 1}` : "Verify the integrated brief", description: "Review the approved PRD and the complete combined implementation. Verify the user journey against every criterion below, including error and recovery behavior. Cite concrete repository and test evidence for each criterion. This task verifies existing code; it does not author or merge changes.", difficulty: "hard", assignedModel: tasks.find((task) => task.difficulty === "hard")?.assignedModel ?? tasks[0]!.assignedModel, acceptanceCriteria: criteria.slice(start, start + 100), dependsOn: tasks.map((_, index) => index), scopePaths: [...new Set(tasks.flatMap((task) => task.scopePaths))], milestone: { ...DEFAULT_MILESTONE_POLICY } });
  }
  return [...tasks, ...milestones];
}
function activeRepairWork(tasks: Task[], rootId: string): boolean {
  return tasks.some((task) => {
    if (task.repairFor?.milestoneId !== rootId || ["done", "failed"].includes(task.status)) return false;
    // A verification blocked behind a failed repair is history, not live ownership.
    if (task.milestone && task.status === "backlog" && task.dependsOn.some((id) => tasks.find((dependency) => dependency.id === id)?.status === "failed")) return false;
    return true;
  });
}
function rootFor(db: Db, task: Task): Task | undefined {
  const root = task.repairFor ? repo.getTask(db, task.repairFor.milestoneId) : task.milestone ? task : undefined;
  if (!root && task.repairFor) throw new ResourceUnavailableError("The original milestone is unavailable.", false);
  if (!root) return undefined;
  if (!validMilestonePolicy(root.milestone) || root.repairFor || root.projectId !== task.projectId) throw new ResourceUnavailableError("The original milestone is unavailable.", false);
  return root;
}
export function milestoneUsage(db: Db, root: Task) {
  const startedAt = (db.prepare("SELECT started_at FROM milestone_budgets WHERE task_id = ?").get(root.id) as { started_at: string } | undefined)?.started_at;
  const usage = db.prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(i.cost_usd), 0) AS cost,
    COALESCE(SUM(i.outcome IN ('running', 'interrupted') OR i.id IS NULL), 0) AS unknown
    FROM milestone_calls c LEFT JOIN model_invocations i ON i.id = c.invocation_id WHERE c.milestone_id = ?`).get(root.id) as { calls: number; cost: number; unknown: number };
  const rounds = (db.prepare("SELECT COALESCE(MAX(round), 0) AS rounds FROM milestone_repairs WHERE milestone_id = ? AND applied = 1").get(root.id) as { rounds: number }).rounds;
  return { startedAt, deadline: startedAt ? new Date(new Date(startedAt).getTime() + root.milestone!.maxDurationMinutes * 60_000).toISOString() : undefined,
    calls: usage.calls, observedCostUsd: usage.cost, unknownSpendCalls: usage.unknown, repairRounds: rounds };
}
function limitReason(root: Task, usage: ReturnType<typeof milestoneUsage>, now: number): string | undefined {
  if (usage.deadline && now >= new Date(usage.deadline).getTime()) return "Milestone time budget is exhausted.";
  if (usage.calls >= root.milestone!.maxInvocations) return "Milestone invocation budget is exhausted.";
  if (usage.observedCostUsd >= root.milestone!.maxCostUsd) return "Milestone observed spending limit is reached.";
  return undefined;
}
/** Receipt survives retries/restarts and includes subscription calls. Call inside admission's transaction. */
export function reserveMilestoneCall(db: Db, invocationId: string, taskId?: string, now = Date.now()): void {
  const task = taskId ? repo.getTask(db, taskId) : null;
  if (!task) return;
  const root = rootFor(db, task); if (!root) return;
  const old = db.prepare("SELECT milestone_id, task_id FROM milestone_calls WHERE invocation_id = ?").get(invocationId) as { milestone_id: string; task_id: string } | undefined;
  if (old) { if (old.milestone_id !== root.id || old.task_id !== task.id) throw new ResourceUnavailableError("Milestone invocation identity changed.", false); return; }
  startMilestoneBudget(db, task, now);
  const reason = limitReason(root, milestoneUsage(db, root), now);
  if (reason) throw new ResourceUnavailableError(reason, false);
  db.prepare("INSERT INTO milestone_calls (invocation_id, milestone_id, task_id, created_at) VALUES (?, ?, ?, ?)").run(invocationId, root.id, task.id, new Date(now).toISOString());
}
export function startMilestoneBudget(db: Db, task: Task, now = Date.now()): number {
  const root = rootFor(db, task); if (!root) throw new ResourceUnavailableError("Milestone policy is unavailable.", false);
  const reason = limitReason(root, milestoneUsage(db, root), now);
  if (reason) throw new ResourceUnavailableError(reason, false);
  db.prepare("INSERT OR IGNORE INTO milestone_budgets (task_id, started_at) VALUES (?, ?)").run(root.id, new Date(now).toISOString());
  return new Date(milestoneUsage(db, root).deadline!).getTime();
}
export async function milestoneOutcomes(db: Db, project: Project, git: Pick<GitService, "verificationRevision">, mock = false): Promise<{ milestones: MilestoneOutcome[]; repositoryError?: string; taskGeneration: number }> {
  if (!repo.getTasks(db, project.id).some((task) => task.milestone && !task.repairFor)) return { milestones: [], taskGeneration: repo.getTaskGeneration(db, project.id) };
  let head: string | undefined; let repositoryError: string | undefined;
  try { if (mock) throw new Error("Mock mode has no verified repository revision."); if (!git.verificationRevision) throw new Error("Repository verification is unavailable."); head = await git.verificationRevision(project); }
  catch (error) { repositoryError = error instanceof Error ? error.message : String(error); }
  // Read task state after the asynchronous Git boundary, then return its version.
  const tasks = repo.getTasks(db, project.id); const taskGeneration = repo.getTaskGeneration(db, project.id);
  const roots = tasks.filter((task) => task.milestone && !task.repairFor);
  const milestones = roots.map((root): MilestoneOutcome => {
    const verification = tasks.filter((task) => task.milestone && (task.id === root.id || task.repairFor?.milestoneId === root.id)).sort((a, b) => (b.repairFor?.round ?? 0) - (a.repairFor?.round ?? 0))[0]!;
    const decision = repo.getMergeDecisions(db, verification.id).find((item) => item.runId === taskRunId(verification));
    const proof = decision?.milestoneProof;
    let state: MilestoneOutcome["state"] = ["in_progress", "in_review"].includes(verification.status) ? "checking" : "pending";
    let reason = "Waiting for contributing work and integrated verification.";
    if (verification.status === "failed" || verification.status === "blocked") { state = "needs_attention"; reason = verification.statusReason ?? "Verification needs attention."; }
    if (verification.status === "done") {
      if (!proof || !decision || decision.verdict !== "approve" || !milestoneGatesPassed(decision.gate) || !completeCriterionEvidence(root.acceptanceCriteria, decision.criterionEvidence) || JSON.stringify(proof.criteria) !== JSON.stringify(root.acceptanceCriteria)) {
        state = "needs_attention"; reason = "Task completion has no complete milestone acceptance receipt.";
      } else if (!head) { state = "unavailable"; reason = repositoryError!; }
      else if (proof.headSha !== head || proof.dependencies.some((old) => { const current = tasks.find((task) => task.id === old.id); return !current || current.status !== "done" || current.runGeneration !== old.runGeneration || current.attempts !== old.attempts; })) {
        state = "stale"; reason = "The repository or a contributing task changed after verification. Resume the project to recheck within the original limits.";
      } else { state = "accepted"; reason = "Every original criterion has review evidence and passing tests at the current combined revision."; }
    }
    const usage = milestoneUsage(db, root);
    const unfinished = root.dependsOn.some((id) => tasks.find((task) => task.id === id)?.status !== "done");
    const pending = db.prepare("SELECT 1 FROM milestone_repairs WHERE milestone_id = ? AND applied = 0 AND revision_id = (SELECT planning_revision_id FROM projects WHERE id = ?)").get(root.id, project.id);
    const activeRepair = activeRepairWork(tasks, root.id);
    const repairUnavailableReason = state === "accepted" ? "This milestone is accepted." : limitReason(root, usage, Date.now()) ??
      (unfinished ? "Finish or retry the contributing tasks first." : activeRepair ? "Finish the current repair work first." : pending ? "A repair draft already exists in Plan." : usage.repairRounds >= root.milestone!.maxRepairRounds ? "The approved repair-round limit is reached." : undefined);
    return { task: root, verificationTask: verification, contributors: root.dependsOn.map((id) => { const contributor = tasks.find((task) => task.id === id); return { id, title: contributor?.title ?? "Unavailable task", status: contributor?.status ?? "blocked" }; }), state, reason, decision, currentHead: head, ...usage, repairUnavailableReason };
  });
  return { milestones, repositoryError, taskGeneration };
}

export function createMilestoneRepairDraft(db: Db, project: Project, rootId: string, input: MilestoneRepairDraftRequest): MilestoneRepairDraftResponse {
  return db.transaction(() => {
    const root = repo.getTask(db, rootId); if (!root?.milestone || root.repairFor || root.projectId !== project.id) throw new MilestoneError("Milestone not found.", 404);
    const session = repo.getPlanningSession(db, project.id);
    const old = db.prepare("SELECT draft_json FROM milestone_repairs WHERE milestone_id = ? AND revision_id = ?").get(root.id, input.revisionId) as { draft_json: string } | undefined;
    if (old && session.revisionId === input.revisionId) {
      const draft = JSON.parse(old.draft_json) as MilestoneRepairDraftResponse;
      if (canonical(session.draftTasks) !== canonical(draft.tasks)) throw new MilestoneError("The repair draft was edited. Review the saved work in Plan.");
      return { ...draft, sessionVersion: session.sessionVersion };
    }
    if (session.revisionId !== input.revisionId || session.sessionVersion !== input.sessionVersion || repo.getTaskGeneration(db, project.id) !== input.taskGeneration) throw new MilestoneError("The plan or task state changed. Refresh before preparing a repair.");
    if (session.draftTasks?.length || session.messages.length || session.prd?.trim()) throw new MilestoneError("Your planning session contains work. Commit or explicitly clear it before preparing a milestone repair.");
    const tasks = repo.getTasks(db, project.id);
    if (root.dependsOn.some((id) => tasks.find((task) => task.id === id)?.status !== "done")) throw new MilestoneError("Finish or retry the contributing tasks first.");
    if (activeRepairWork(tasks, root.id)) throw new MilestoneError("Finish the current repair work first.");
    const previousDraft = db.prepare("SELECT revision_id, draft_json FROM milestone_repairs WHERE milestone_id = ? AND applied = 0").get(root.id) as { revision_id: string; draft_json: string } | undefined;
    if (previousDraft) {
      if (previousDraft.revision_id === session.revisionId) throw new MilestoneError("A repair draft already exists. Review it in Plan.");
      // An explicit session reset made the old review stale. Keep its audit
      // history; it never consumed an approved repair round or model call.
      repo.createAuditEntry(db, { projectId: project.id, taskId: root.id, kind: "milestone_repair_discarded", actor: "human", summary: "Unapplied repair draft superseded after planning-session reset", detail: { draft: JSON.parse(previousDraft.draft_json) } });
      db.prepare("DELETE FROM milestone_repairs WHERE milestone_id = ? AND applied = 0").run(root.id);
    }
    const usage = milestoneUsage(db, root); const reason = limitReason(root, usage, Date.now());
    if (reason) throw new MilestoneError(reason);
    if (usage.repairRounds >= root.milestone.maxRepairRounds) throw new MilestoneError("The approved repair-round limit is reached.");
    const round = usage.repairRounds + 1; const repairFor = { milestoneId: root.id, round };
    const latest = tasks.filter((task) => task.milestone && (task.id === root.id || task.repairFor?.milestoneId === root.id)).sort((a, b) => (b.repairFor?.round ?? 0) - (a.repairFor?.round ?? 0))[0]!;
    const reasons = repo.getMergeDecisions(db, latest.id)[0]?.reasons.join("\n") ?? latest.statusReason ?? "Integrated verification has no complete evidence.";
    const common = { difficulty: root.difficulty, assignedModel: root.assignedModel, acceptanceCriteria: [...root.acceptanceCriteria], scopePaths: [...root.scopePaths], existingDependsOn: [...root.dependsOn], repairFor };
    const draftTasks: PlanChangeTask[] = [
      { ...common, title: `Repair ${round}: ${root.title}`, description: `Preserve the original brief and all criteria. Make the smallest scoped repair and add regression coverage.\n\nObserved verification failure:\n${reasons}`, dependsOn: [] },
      { ...common, title: `Recheck ${round}: ${root.title}`, description: root.description, dependsOn: [0], milestone: { ...root.milestone } },
    ];
    if (!repo.savePlanningSessionForRevision(db, project.id, input.revisionId, { prd: project.prd ?? "", draftTasks })) throw new MilestoneError("The planning session changed before the repair draft could be saved.");
    const draft: MilestoneRepairDraftResponse = { revisionId: input.revisionId, sessionVersion: repo.getPlanningSession(db, project.id).sessionVersion, tasks: draftTasks, prdMarkdown: project.prd ?? "" };
    db.prepare("INSERT INTO milestone_repairs (milestone_id, round, revision_id, draft_json) VALUES (?, ?, ?, ?)").run(root.id, round, input.revisionId, JSON.stringify(draft));
    return draft;
  })();
}
/** A repair cannot be disguised as a mutable replacement or expand its approved scope. */
export function assertRepairProposal(db: Db, projectId: string, revisionId: string, tasks: PlanChangeTask[], prd: string): void {
  if (!tasks.some((task) => task.repairFor)) return;
  const repair = tasks[0]?.repairFor;
  const row = repair && db.prepare("SELECT draft_json FROM milestone_repairs WHERE milestone_id = ? AND round = ? AND revision_id = ? AND applied = 0").get(repair.milestoneId, repair.round, revisionId) as { draft_json: string } | undefined;
  if (!row) throw new MilestoneError("This repair does not own an approved milestone draft.");
  const expected = JSON.parse(row.draft_json) as MilestoneRepairDraftResponse;
  const identity = (items: PlanChangeTask[]) => canonical(items.map((item) => Object.fromEntries(Object.entries(item).filter(([key]) => !["assignedModel", "description", "title"].includes(key)))));
  if (repo.getTask(db, repair.milestoneId)?.projectId !== projectId || prd !== expected.prdMarkdown || identity(tasks) !== identity(expected.tasks)) throw new MilestoneError("Repair proposals must preserve the original brief, criteria, two-task scope, dependencies and limits. Only titles, descriptions and model choices may be edited.");
}

/** Rechecking uses the same task identity with a new logical generation; proof history remains. */
export function requeueMilestoneChecks(db: Db, projectId: string, onlyIds?: string[]): Task[] {
  return db.transaction(() => {
    const tasks = repo.getTasks(db, projectId); const updated: Task[] = [];
    for (const task of tasks) {
      if (!task.milestone || task.status !== "done" || onlyIds && !onlyIds.includes(task.id)) continue;
      // Superseded verification remains historical, not another runnable branch.
      const rootId = task.repairFor?.milestoneId ?? task.id;
      if (tasks.some((other) => other.milestone && other.repairFor?.milestoneId === rootId && other.repairFor.round > (task.repairFor?.round ?? 0))) continue;
      const next = repo.updateTask(db, task.id, { status: task.dependsOn.every((id) => tasks.find((item) => item.id === id)?.status === "done") ? "ready" : "backlog",
        attempts: 0, runGeneration: task.runGeneration + 1, runExtraAttempts: 0, runExhaustedModels: [], runRateLimitRetries: 0, runModel: undefined,
        branch: undefined, worktreePath: undefined, prNumber: undefined, statusReason: "The repository changed after verification. Rechecking within the original limits." });
      if (next) updated.push(next);
    }
    return updated;
  })();
}
