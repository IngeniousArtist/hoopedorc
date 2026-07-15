import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { InvocationStage, ModelInvocation, Project, Task } from "@orc/types";
import { checkModelQuota } from "./budget.js";
import { defaultSettings } from "./config.js";
import { initDb } from "./db/index.js";
import * as repo from "./db/repo.js";
import { persistInvocationEvent } from "./invocation-ledger.js";

function seedProject(db: ReturnType<typeof initDb>): { project: Project; task: Task } {
  const project = repo.createProject(db, {
    id: "p1",
    name: "Ledger",
    repoUrl: "https://github.com/x/y",
    defaultBranch: "main",
    localPath: "/tmp/ledger",
    status: "created",
  });
  const task = repo.createTask(db, {
    id: "t1",
    projectId: project.id,
    title: "Task",
    description: "",
    difficulty: "medium",
    status: "ready",
    dependsOn: [],
    acceptanceCriteria: [],
    assignedModel: "deepseek-flash",
    scopePaths: [],
    attempts: 0,
    maxAttempts: 3,
  });
  return { project, task };
}

function invocation(
  id: string,
  stage: InvocationStage,
  over: Partial<ModelInvocation> = {},
): ModelInvocation {
  return {
    id,
    projectId: stage === "health" ? undefined : "p1",
    taskId: ["author", "validator", "docs"].includes(stage) ? "t1" : undefined,
    runId: ["author", "docs"].includes(stage) ? id : undefined,
    stage,
    model: "deepseek-flash",
    runner: "opencode",
    effort: "high",
    startedAt: "2026-07-15T00:00:00.000Z",
    outcome: "running",
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    tokensCached: 0,
    ...over,
  };
}

test("B40: every stage counts in one ledger and terminal billing is exactly once", () => {
  const db = initDb(":memory:");
  const settings = defaultSettings();
  repo.upsertSettings(db, settings);
  seedProject(db);

  const stages: InvocationStage[] = [
    "planner",
    "deconstructor",
    "author",
    "validator",
    "docs",
    "health",
  ];
  for (const [index, stage] of stages.entries()) {
    const start = invocation(`inv-${stage}`, stage);
    persistInvocationEvent(db, start);
    const terminal = persistInvocationEvent(db, {
      ...start,
      endedAt: `2026-07-15T00:00:0${index + 1}.000Z`,
      outcome: "completed",
      exitReason: "completed",
      costUsd: stage === "author" ? 0.25 : stage === "validator" ? 0.5 : 0,
      tokensIn: 10 + index,
      tokensOut: 2,
      tokensCached: 1,
    });
    assert.equal(terminal.transitioned, true);
  }

  const duplicate = persistInvocationEvent(db, {
    ...invocation("inv-author", "author"),
    endedAt: "2026-07-15T00:10:00.000Z",
    outcome: "failed",
    exitReason: "error",
    costUsd: 99,
    tokensIn: 999,
  });
  assert.equal(duplicate.transitioned, false);
  assert.equal(duplicate.invocation.outcome, "completed");
  assert.equal(duplicate.invocation.costUsd, 0.25);

  assert.deepEqual(repo.getModelUsageSince(db, "deepseek-flash", "2026-07-14"), {
    runs: 6,
    costUsd: 0.75,
  });
  assert.equal(repo.getCosts(db, "p1").length, 2, "only positive project costs project");
  assert.equal(new Set(repo.getCosts(db, "p1").map((cost) => cost.invocationId)).size, 2);
  assert.equal(repo.getCostSummary(db, "p1").totalUsd, 0.75);
  assert.equal(repo.getCostAnalytics(db, "p1").byModel[0]?.runs, 5);
  assert.equal(repo.getModelRunStats(db)[0]?.totalRuns, 6);

  const quotaSettings = repo.upsertSettings(db, {
    ...settings,
    models: settings.models.map((model) =>
      model.id === "deepseek-flash"
        ? { ...model, quota: { windowHours: 24 * 365, maxRuns: 6 } }
        : model,
    ),
  });
  assert.match(
    checkModelQuota(db, "deepseek-flash", quotaSettings) ?? "",
    /6\/6 calls/,
  );
});

test("B40: startup closes an in-flight invocation as interrupted", () => {
  const dir = mkdtempSync(join(tmpdir(), "hoopedorc-invocation-restart-"));
  const path = join(dir, "orc.db");
  try {
    const first = initDb(path);
    repo.createInvocation(first, invocation("in-flight", "health"));
    first.close();

    const reopened = initDb(path);
    const recovered = repo.getInvocation(reopened, "in-flight")!;
    assert.equal(recovered.outcome, "interrupted");
    assert.equal(recovered.exitReason, "process_restart");
    assert.ok(recovered.endedAt);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B40: legacy run, cost, and model-check history backfills without duplication", () => {
  const dir = mkdtempSync(join(tmpdir(), "hoopedorc-invocation-backfill-"));
  const path = join(dir, "orc.db");
  try {
    const legacy = initDb(path);
    seedProject(legacy);
    repo.createRun(legacy, {
      id: "legacy-author",
      projectId: "p1",
      taskId: "t1",
      model: "deepseek-flash",
      attempt: 1,
      status: "passed",
      startedAt: "2026-07-15T00:00:00.000Z",
      endedAt: "2026-07-15T00:00:01.000Z",
      exitReason: "completed",
      costUsd: 0.2,
      tokensIn: 1,
      tokensOut: 1,
    });
    repo.createCost(legacy, {
      id: "legacy-validator-cost",
      projectId: "p1",
      taskId: "t1",
      model: "claude",
      costUsd: 0.4,
      tokensIn: 4,
      tokensOut: 2,
      ts: "2026-07-15T00:01:00.000Z",
    });
    repo.createModelCheck(legacy, {
      id: "legacy-check",
      modelId: "claude",
      displayName: "Claude",
      ok: true,
      costUsd: 0,
      ms: 100,
      ts: "2026-07-15T00:02:00.000Z",
    });
    legacy.exec("DROP TABLE model_invocations");
    legacy.exec("UPDATE costs SET invocation_id = NULL");
    // Simulate the pre-ledger runner writing the same terminal cost more than
    // once. The newest row is retained as the sole visible projection while
    // the run row remains the authoritative invocation/accounting source.
    legacy.prepare(
      `INSERT INTO costs (
         id, invocation_id, project_id, model, task_id, run_id,
         cost_usd, tokens_in, tokens_out, tokens_cached, ts
       ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "legacy-author-duplicate",
      "p1",
      "deepseek-flash",
      "t1",
      "legacy-author",
      0.2,
      1,
      1,
      0,
      "2026-07-15T00:00:02.000Z",
    );
    legacy.close();

    const migrated = initDb(path);
    const rows = repo.getInvocations(migrated);
    assert.deepEqual(
      rows.map((row) => row.stage).sort(),
      ["author", "health", "validator"],
    );
    assert.ok(
      Math.abs(repo.getCostSummary(migrated, "p1").totalUsd - 0.6) < Number.EPSILON,
    );
    assert.deepEqual(
      repo.getCosts(migrated, "p1").map((cost) => cost.invocationId).sort(),
      ["legacy-author", "legacy-cost:legacy-validator-cost"],
    );

    const health = invocation("linked-health", "health");
    persistInvocationEvent(migrated, health);
    persistInvocationEvent(migrated, {
      ...health,
      endedAt: "2026-07-15T00:03:00.000Z",
      outcome: "completed",
      exitReason: "completed",
    });
    repo.createModelCheck(migrated, {
      id: "linked-check",
      invocationId: health.id,
      modelId: health.model,
      displayName: "DeepSeek Flash",
      ok: true,
      costUsd: 0,
      ms: 80,
      ts: "2026-07-15T00:03:00.000Z",
    });

    // Idempotent on another boot.
    migrated.close();
    const twice = initDb(path);
    assert.equal(repo.getInvocations(twice).length, 4);
    assert.ok(
      Math.abs(repo.getCostSummary(twice, "p1").totalUsd - 0.6) < Number.EPSILON,
    );
    assert.equal(
      repo.getInvocations(twice).filter((row) => row.id === health.id).length,
      1,
    );
    twice.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
