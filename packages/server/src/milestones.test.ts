import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_MILESTONE_POLICY, type MergeDecision, type MilestoneRepairDraftRequest } from "@orc/types";
import { taskRunId } from "@orc/engine";
import { initDb } from "./db/index";
import * as repo from "./db/repo";
import { defaultSettings } from "./config";
import { assertRepairProposal, createMilestoneRepairDraft, milestoneOutcomes, milestoneUsage, requeueMilestoneChecks, reserveMilestoneCall, startMilestoneBudget, validateMilestoneDrafts, withMilestoneDraft } from "./milestones";
import { reviewPlanChanges, taskCanBeRevised } from "./plan-changes";
import { commitPlanningDraft, planningContentHash } from "./planning-commit";
import { ResourceManager } from "./resources";

function fixture(path = ":memory:") {
  const db = initDb(path); const settings = defaultSettings(); repo.upsertSettings(db, settings);
  const project = repo.createProject(db, { id: "p", name: "Milestone", repoUrl: "https://example.com/p", localPath: "/unused", defaultBranch: "main", status: "paused" });
  repo.updateProject(db, project.id, { prd: "# Original outcome" }); project.prd = "# Original outcome";
  const contributor = repo.createTask(db, { id: "feature", projectId: project.id, title: "Feature", description: "Feature", difficulty: "medium", status: "done", dependsOn: [], acceptanceCriteria: ["Original outcome"], assignedModel: settings.routing.byDifficulty.medium, scopePaths: ["src/**", "test/**"], attempts: 1, maxAttempts: 2 });
  const root = repo.createTask(db, { ...contributor, id: "outcome", title: "Integrated outcome", milestone: { ...DEFAULT_MILESTONE_POLICY, maxRepairRounds: 1 }, dependsOn: [contributor.id], status: "failed", attempts: 1 });
  const revisionId = repo.ensurePlanningRevision(db, project.id);
  const input = (): MilestoneRepairDraftRequest => ({ revisionId, sessionVersion: repo.getPlanningSession(db, project.id).sessionVersion, taskGeneration: repo.getTaskGeneration(db, project.id) });
  return { db, settings, project, contributor, root, revisionId, input };
}
function approval(f: ReturnType<typeof fixture>): MergeDecision {
  return { id: "proof", projectId: "p", taskId: f.root.id, runId: taskRunId(f.root), validatorModel: f.settings.routing.validatorByDifficulty.medium, verdict: "approve", reasons: [], confidence: 1,
    gate: { typecheck: true, lint: true, build: true, tests: true, noConflicts: true, inScope: true, vacuous: false, executed: ["tests"], details: { tests: "Integration test passed" } },
    criterionEvidence: [{ criterion: "Original outcome", passed: true, evidence: "test/outcome.test.ts:7 verifies the combined workflow" }],
    milestoneProof: { headSha: "a".repeat(40), criteria: ["Original outcome"], dependencies: [{ id: f.contributor.id, status: "done", attempts: 1, runGeneration: 0 }], environment: "local fixture", checkedAt: new Date().toISOString() }, ts: new Date().toISOString() };
}

test("VW15: only complete current revision evidence accepts an outcome; retry, missing tests, dirty/mock and drift fail closed", async () => {
  const f = fixture();
  try {
    const git = { verificationRevision() { return Promise.resolve("a".repeat(40)); } };
    repo.updateTask(f.db, f.root.id, { status: "done" });
    assert.equal((await milestoneOutcomes(f.db, f.project, git)).milestones[0]?.state, "needs_attention");
    repo.createMergeDecision(f.db, approval(f));
    assert.equal((await milestoneOutcomes(f.db, f.project, git)).milestones[0]?.state, "accepted");
    assert.equal((await milestoneOutcomes(f.db, f.project, git, true)).milestones[0]?.state, "unavailable");
    assert.equal((await milestoneOutcomes(f.db, f.project, { verificationRevision() { return Promise.resolve("b".repeat(40)); } })).milestones[0]?.state, "stale");
    repo.updateTask(f.db, f.contributor.id, { runGeneration: 1 });
    assert.equal((await milestoneOutcomes(f.db, f.project, git)).milestones[0]?.state, "stale");
    const queued = requeueMilestoneChecks(f.db, "p"); assert.equal(queued.length, 1); assert.equal(queued[0]?.runGeneration, 1);
    assert.equal(requeueMilestoneChecks(f.db, "p").length, 0);
    assert.equal(repo.getMergeDecisions(f.db, f.root.id).length, 1);
    const broken = approval(f); broken.gate.executed = []; broken.id = "missing-tests"; broken.runId = taskRunId(queued[0]);
    repo.createMergeDecision(f.db, broken); repo.updateTask(f.db, f.root.id, { status: "done" });
    assert.equal((await milestoneOutcomes(f.db, f.project, git)).milestones[0]?.state, "needs_attention");
    assert.equal(taskCanBeRevised({ ...f.root, attempts: 0, status: "ready" }), false);
  } finally { f.db.close(); }
});

test("VW15: one immutable repair draft survives restart, exact-content Git approval and repeated apply without duplicate tasks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "milestone-repair-")); const file = join(dir, "state.sqlite"); let f = fixture(file);
  try {
    const draft = createMilestoneRepairDraft(f.db, f.project, f.root.id, f.input());
    assert.deepEqual(createMilestoneRepairDraft(f.db, f.project, f.root.id, f.input()), draft);
    f.db.close(); f = { ...f, db: initDb(file) };
    assert.deepEqual(createMilestoneRepairDraft(f.db, f.project, f.root.id, { revisionId: draft.revisionId, sessionVersion: draft.sessionVersion, taskGeneration: repo.getTaskGeneration(f.db, "p") }), draft);
    assert.throws(() => assertRepairProposal(f.db, "p", draft.revisionId, draft.tasks.map((task) => ({ ...task, acceptanceCriteria: ["Weaker"] })), draft.prdMarkdown), /preserve/);
    assert.throws(() => assertRepairProposal(f.db, "p", draft.revisionId, draft.tasks, "# Weaker brief"), /preserve/);
    const review = reviewPlanChanges(f.db, "p", { ...draft, taskGeneration: repo.getTaskGeneration(f.db, "p") }, f.settings);
    const writes: string[][] = [];
    const apply = () => commitPlanningDraft(f.db, f.project, { ...review.input, review }, f.settings, "planner", true, () => {}, { git: { commitFiles(_project, files) { writes.push(files.map((item) => item.path)); assert.ok(files.some((item) => item.path.endsWith(".json") && item.content.includes("Original outcome"))); return Promise.resolve(); } }, recordArchive: () => ({ ok: true }) });
    const result = await apply(); const replay = await apply();
    assert.equal(result.createdTasks.length, 2); assert.equal(replay.createdTasks.length, 0); assert.equal(writes.length, 1);
    assert.equal(repo.getTasks(f.db, "p").length, 4); assert.deepEqual(repo.getTask(f.db, f.root.id)?.acceptanceCriteria, ["Original outcome"]);
    assert.equal(milestoneUsage(f.db, f.root).repairRounds, 1);
    for (const task of result.createdTasks) repo.updateTask(f.db, task.id, { status: "failed" });
    const nextRevision = repo.ensurePlanningRevision(f.db, "p");
    assert.throws(() => createMilestoneRepairDraft(f.db, f.project, f.root.id, { revisionId: nextRevision, sessionVersion: repo.getPlanningSession(f.db, "p").sessionVersion, taskGeneration: repo.getTaskGeneration(f.db, "p") }), /round-limit|round limit/);
  } finally { f.db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("VW15: durable call admissions are exactly once for metered/subscription work and enforce observed cost, count and deadline", () => {
  const f = fixture();
  try {
    const now = Date.now(); const deadline = startMilestoneBudget(f.db, f.root, now);
    reserveMilestoneCall(f.db, "one", f.root.id, now); reserveMilestoneCall(f.db, "one", f.root.id, now);
    assert.equal(milestoneUsage(f.db, f.root).calls, 1);
    assert.throws(() => reserveMilestoneCall(f.db, "late", f.root.id, deadline), /time budget/);
    const manager = new ResourceManager(f.db, () => now);
    manager.reserve({ id: "two", model: f.root.assignedModel, stage: "author", projectId: "p", taskId: f.root.id });
    assert.equal(milestoneUsage(f.db, f.root).calls, 2);
    for (let i = 2; i < f.root.milestone!.maxInvocations; i++) reserveMilestoneCall(f.db, `call-${i}`, f.root.id, now);
    assert.throws(() => reserveMilestoneCall(f.db, "over", f.root.id, now), /invocation budget/);
    assert.equal(started(f.db, f.root.id), new Date(now).toISOString());
  } finally { f.db.close(); }
});
function started(db: ReturnType<typeof initDb>, id: string) { return (db.prepare("SELECT started_at FROM milestone_budgets WHERE task_id = ?").get(id) as { started_at: string }).started_at; }

test("VW15: reviewed integration drafts map all criteria to contributors and participate in the content hash", () => {
  const f = fixture();
  try {
    const tasks = withMilestoneDraft([{ title: "Feature", description: "Feature", difficulty: "medium", assignedModel: f.root.assignedModel, acceptanceCriteria: ["Original outcome"], dependsOn: [], scopePaths: ["src/**"] }]);
    validateMilestoneDrafts(tasks); assert.deepEqual(tasks[1]?.dependsOn, [0]);
    const a = planningContentHash(f.project, { revisionId: f.revisionId, tasks });
    tasks[1].milestone!.maxRepairRounds++;
    assert.notEqual(planningContentHash(f.project, { revisionId: f.revisionId, tasks }), a);
    tasks[1].dependsOn = []; assert.throws(() => validateMilestoneDrafts(tasks), /contributing/);
    repo.savePlanningSession(f.db, "p", { messages: [{ role: "user", content: "My unsent work" }] });
    assert.throws(() => createMilestoneRepairDraft(f.db, f.project, f.root.id, f.input()), /contains work/);
    assert.equal(repo.getPlanningSession(f.db, "p").messages[0]?.content, "My unsent work");
  } finally { f.db.close(); }
});

test("VW15: subscription activity counts without metered spend; observed metered cost refuses another admission", () => {
  const f = fixture();
  try {
    reserveMilestoneCall(f.db, "subscription", f.root.id);
    const event = { projectId: "p", taskId: f.root.id, stage: "validator" as const, model: f.root.assignedModel, runner: "unknown" as const, effort: "default", startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), outcome: "completed" as const, tokensIn: 1, tokensOut: 1, tokensCached: 0 };
    repo.createInvocation(f.db, { ...event, id: "subscription", accounting: { billing: "subscription" }, reportedCostUsd: 300, costUsd: 0 });
    assert.equal(milestoneUsage(f.db, f.root).calls, 1); assert.equal(milestoneUsage(f.db, f.root).observedCostUsd, 0);
    reserveMilestoneCall(f.db, "metered", f.root.id);
    repo.createInvocation(f.db, { ...event, id: "metered", accounting: { billing: "metered" }, costUsd: f.root.milestone!.maxCostUsd });
    assert.throws(() => reserveMilestoneCall(f.db, "after-cost", f.root.id), /spending limit/);
  } finally { f.db.close(); }
});

test("VW15: clearing an unapplied draft permits a new proposal without spending a round or losing its audit history", () => {
  const f = fixture();
  try {
    const first = createMilestoneRepairDraft(f.db, f.project, f.root.id, f.input());
    repo.savePlanningSession(f.db, "p", { messages: [], prd: null, draftTasks: null, revisionId: null });
    const revisionId = repo.ensurePlanningRevision(f.db, "p");
    const second = createMilestoneRepairDraft(f.db, f.project, f.root.id, { ...f.input(), revisionId });
    assert.notEqual(first.revisionId, second.revisionId); assert.equal(second.tasks[0]?.repairFor?.round, 1);
    assert.equal(milestoneUsage(f.db, f.root).repairRounds, 0);
    assert.equal(repo.getAuditLog(f.db, "p").filter((item) => item.kind === "milestone_repair_discarded").length, 1);
  } finally { f.db.close(); }
});
