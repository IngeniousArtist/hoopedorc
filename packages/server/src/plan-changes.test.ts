import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ReviewPlanChangesRequest } from "@orc/types";
import { defaultSettings } from "./config";
import { initDb } from "./db/index";
import * as repo from "./db/repo";
import { assertPlanChangeCurrent, getPlanChange, latestPlanChange, pendingPlanChange, reviewPlanChanges } from "./plan-changes";
import { commitPlanningDraft } from "./planning-commit";

function fixture(path = ":memory:") {
  const db = initDb(path);
  const settings = defaultSettings();
  repo.upsertSettings(db, settings);
  const project = repo.createProject(db, { id: "p", name: "Changes", repoUrl: "https://example.com/p", localPath: "/unused", defaultBranch: "main", status: "paused" });
  repo.updateProject(db, "p", { prd: "# Accepted" });
  const task = repo.createTask(db, { id: "pending", projectId: "p", title: "Original", description: "Keep identity", difficulty: "medium", assignedModel: settings.routing.byDifficulty.medium,
    status: "ready", acceptanceCriteria: ["Existing"], dependsOn: [], scopePaths: ["src/**"], attempts: 0, maxAttempts: 3 });
  const revisionId = repo.ensurePlanningRevision(db, "p");
  const input: ReviewPlanChangesRequest = { revisionId, sessionVersion: 0, taskGeneration: repo.getTaskGeneration(db, "p"), prdMarkdown: "# Revised", agentsMd: "# Guidance", tasks: [
    { title: "Revised task", description: "New handoff", difficulty: "medium", assignedModel: task.assignedModel, acceptanceCriteria: ["New"], dependsOn: [], scopePaths: ["src/**"], existingDependsOn: [], existingTaskId: task.id },
    { title: "Follow-up", description: "Validate", difficulty: "medium", assignedModel: task.assignedModel, acceptanceCriteria: ["Works"], dependsOn: [0], scopePaths: ["test/**"], existingDependsOn: [] },
  ] };
  return { db, project, task, settings, input };
}

test("VW07: immutable review preserves accepted/active work and validates identities and the combined DAG", () => {
  const f = fixture();
  try {
    const active = repo.createTask(f.db, { ...f.task, id: "active", status: "in_progress", attempts: 1 });
    f.input.taskGeneration = repo.getTaskGeneration(f.db, "p");
    const review = reviewPlanChanges(f.db, "p", f.input, f.settings);
    assert.equal(review.changes[0]?.after.id, "pending");
    assert.equal(review.retainedTasks[0]?.id, active.id);
    assert.equal(repo.getTask(f.db, "pending")?.title, "Original");
    assert.equal(repo.getProject(f.db, "p")?.prd, "# Accepted");
    assert.equal(getPlanChange(f.db, "other", review.id), null);
    for (const tasks of [
      [{ ...f.input.tasks[0]!, existingTaskId: "active" }],
      [{ ...f.input.tasks[0]!, existingTaskId: "other-project-task" }],
      [{ ...f.input.tasks[0]!, existingDependsOn: ["unknown"] }],
      [{ ...f.input.tasks[0]!, dependsOn: [1] }, { ...f.input.tasks[1]!, dependsOn: [0] }],
      [{ ...f.input.tasks[0]! }, { ...f.input.tasks[0]! }],
    ]) assert.throws(() => reviewPlanChanges(f.db, "p", { ...f.input, tasks }, f.settings));
  } finally { f.db.close(); }
});

test("VW07: changes to task generation or draft version refuse a previously reviewed apply", () => {
  const f = fixture();
  try {
    const review = reviewPlanChanges(f.db, "p", f.input, f.settings);
    repo.updateTask(f.db, f.task.id, { status: "in_progress", attempts: 1 });
    assert.throws(() => assertPlanChangeCurrent(f.db, review), /changed after/);
    f.input.taskGeneration = repo.getTaskGeneration(f.db, "p");
    f.input.tasks = [{ ...f.input.tasks[1]!, dependsOn: [] }];
    const fresh = reviewPlanChanges(f.db, "p", f.input, f.settings);
    repo.savePlanningSession(f.db, "p", { prd: "Newer draft" });
    assert.throws(() => assertPlanChangeCurrent(f.db, fresh), /changed after/);
  } finally { f.db.close(); }
});

test("VW07: application reserves one durable owner and blocks writes until atomic finalization", async () => {
  const f = fixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let commits = 0;
  try {
    const review = reviewPlanChanges(f.db, "p", f.input, f.settings);
    const apply = () => commitPlanningDraft(f.db, f.project, { ...review.input, review }, f.settings, "planner", true, () => {}, {
      git: { async commitFiles() { commits++; await held; } }, recordArchive: () => ({ ok: true }),
    });
    const newer = reviewPlanChanges(f.db, "p", f.input, f.settings);
    assert.equal(latestPlanChange(f.db, "p", f.input.revisionId)?.id, newer.id);
    const first = apply(); const duplicate = apply();
    assert.equal(pendingPlanChange(f.db, "p"), true);
    assert.equal(latestPlanChange(f.db, "p", f.input.revisionId)?.id, review.id, "reopening must find the actual pending owner, even if another review was prepared later");
    assert.throws(() => repo.updateTask(f.db, "pending", { title: "Racing edit" }), /application is pending/);
    assert.throws(() => repo.createTask(f.db, { ...f.task, id: "racing" }), /application is pending/);
    assert.throws(() => f.db.prepare("DELETE FROM tasks WHERE id = 'pending'").run(), /application is pending/);
    release();
    const result = await first; const replay = await duplicate;
    assert.equal(commits, 1);
    assert.equal(result.project.status, "paused");
    assert.equal(result.createdTasks.length, 2);
    assert.equal(replay.createdTasks.length, 0);
    assert.equal(repo.getTask(f.db, "pending")?.title, "Revised task");
    assert.deepEqual(result.tasks.find((t) => t.id !== "pending")?.dependsOn, ["pending"]);
    assert.equal(pendingPlanChange(f.db, "p"), false);
    assert.equal((await apply()).createdTasks.length, 0);
    assert.equal(commits, 1);
  } finally { release(); f.db.close(); }
});

test("VW07: push failure survives database reopen and retries the exact review and task IDs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hoopedorc-vw07-"));
  const path = join(dir, "db.sqlite");
  const f = fixture(path);
  const review = reviewPlanChanges(f.db, "p", f.input, f.settings);
  let db = f.db;
  try {
    await assert.rejects(commitPlanningDraft(db, f.project, { ...review.input, review }, f.settings, "planner", true, () => {}, {
      git: { commitFiles() { return Promise.reject(new Error("push unavailable")); } },
    }), /push unavailable/);
    db.close(); db = initDb(path);
    assert.equal(getPlanChange(db, "p", review.id)?.state, "applying");
    assert.equal(repo.getTask(db, "pending")?.title, "Original");
    const result = await commitPlanningDraft(db, repo.getProject(db, "p")!, { ...review.input, review: getPlanChange(db, "p", review.id)! }, f.settings, "planner", true, () => {}, {
      git: { commitFiles() { return Promise.resolve(); } }, recordArchive: () => ({ ok: true }),
    });
    assert.deepEqual(result.createdTasks.map((t) => t.id), review.changes.map((c) => c.after.id));
    assert.equal(repo.getTasks(db, "p").length, 2);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("VW07: failed finalization rolls back task changes and retains the application lock", async () => {
  const f = fixture();
  try {
    const review = reviewPlanChanges(f.db, "p", f.input, f.settings);
    f.db.exec("CREATE TRIGGER fail_review_task BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT, 'injected write failure'); END");
    await assert.rejects(commitPlanningDraft(f.db, f.project, { ...review.input, review }, f.settings, "planner", true, () => {}, {
      git: { commitFiles() { return Promise.resolve(); } }, recordArchive: () => ({ ok: true }),
    }), /injected write failure/);
    assert.equal(repo.getTask(f.db, "pending")?.title, "Original");
    assert.equal(pendingPlanChange(f.db, "p"), true);
    assert.equal(repo.getTasks(f.db, "p").length, 1);
  } finally { f.db.close(); }
});
