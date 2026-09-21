import { randomUUID } from "node:crypto";
import { completeCriterionEvidence, milestoneGatesPassed, type GateResult, type MergeDecision, type Project, type Task } from "@orc/types";
import type { SchedulerDeps } from "./index.js";
import { taskRunId } from "./task-run.js";

/** One verification job owned, cancelled and cleaned up by the ordinary scheduler. */
export async function verifyMilestone(project: Project, task: Task, deps: SchedulerDeps, signal: AbortSignal): Promise<MergeDecision> {
  if (!deps.git.verificationRevision) throw new Error("This Git runtime cannot provide revision-bound milestone evidence.");
  const tasks = deps.getTasks?.() ?? [];
  const dependencies = task.dependsOn.map((id) => {
    const dependency = tasks.find((item) => item.id === id);
    if (!dependency || dependency.status !== "done") throw new Error("Milestone contributors are not all complete.");
    return dependency;
  });
  if (!dependencies.length || !task.acceptanceCriteria.length) throw new Error("A milestone needs contributing tasks and explicit brief criteria.");
  const settings = deps.getSettings?.() ?? deps.settings;
  const reviewer = settings.routing.validatorByDifficulty[task.difficulty];
  if (dependencies.some((item) => (item.runModel ?? item.assignedModel) === reviewer)) {
    throw new Error("Milestone review must use a model different from every contributing author. Choose an independent validator in Settings.");
  }
  const before = await deps.git.verificationRevision(project, task, signal);
  const gate = await deps.gates.run(project, task, signal);
  const restored = await deps.worktrees.restoreToHead(task);
  if (!restored.ok) { gate.tests = false; gate.details.tests = `Cannot restore the verification worktree: ${restored.error}`; }
  signal.throwIfAborted();
  const afterGates = await deps.git.verificationRevision(project, task, signal);
  if (before !== afterGates) throw new Error("The verification revision changed while checks ran.");
  let decision: MergeDecision;
  if (milestoneGatesPassed(gate)) {
    decision = await deps.validator.review(project, task, gate, dependencies[0]!.runModel ?? dependencies[0]!.assignedModel,
      (message) => deps.events.onLog({ projectId: project.id, taskId: task.id, runId: taskRunId(task), ts: new Date().toISOString(), level: "debug", source: "validator", message }), signal);
  } else {
    decision = failedDecision(project, task, reviewer, gate, "Milestone verification requires passing gates and an executed test command. Missing or skipped tests are not evidence.");
  }
  if (await deps.git.verificationRevision(project, task, signal) !== before) throw new Error("The reviewer changed the verification revision.");
  if (await deps.git.verificationRevision(project, undefined, signal) !== before) {
    decision.verdict = "request_changes"; decision.reasons.unshift("The primary checkout and verification worktree have different revisions. Safely update the primary checkout, then recheck.");
  }
  const fresh = deps.getTasks?.() ?? [];
  if (dependencies.some((old) => { const current = fresh.find((item) => item.id === old.id); return !current || current.status !== "done" || current.runGeneration !== old.runGeneration || current.attempts !== old.attempts; })) {
    decision.verdict = "request_changes"; decision.reasons.unshift("A contributing task changed during verification.");
  }
  if (decision.verdict === "approve" && !completeCriterionEvidence(task.acceptanceCriteria, decision.criterionEvidence)) {
    decision.verdict = "request_changes"; decision.reasons.unshift("The reviewer did not provide passing evidence for every original criterion.");
  }
  decision.milestoneProof = { headSha: before, criteria: [...task.acceptanceCriteria], dependencies: dependencies.map(({ id, runGeneration, attempts, status }) => ({ id, runGeneration, attempts, status })), environment: `${gate.environment ?? "Gate runtime unreported"}; reviewer: ${reviewer}`, checkedAt: new Date().toISOString() };
  return decision;
}
function failedDecision(project: Project, task: Task, reviewer: string, gate: GateResult, reason: string): MergeDecision {
  return { id: randomUUID(), projectId: project.id, taskId: task.id, runId: taskRunId(task), validatorModel: reviewer, verdict: "request_changes", confidence: 0, reasons: [reason], gate, ts: new Date().toISOString() };
}
