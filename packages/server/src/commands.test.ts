import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultSettings } from "./config.js";
import { initDb } from "./db/index.js";
import * as repo from "./db/repo.js";
import { EngineRunner } from "./engine-runner.js";
import { WsHub } from "./ws-hub.js";
import { SqliteTelegramUpdateStore } from "./telegram-inbox.js";
import {
  findProjectByPrefix,
  findTaskByIdPrefix,
  notifyTelegramApprovalFailure,
  pauseProject,
  resendPendingApprovals,
  retryTask,
  setMergePolicy,
  setTelegramDigest,
  startProject,
  stopAllProjects,
} from "./commands.js";

function setup() {
  const db = initDb(":memory:");
  repo.upsertSettings(db, defaultSettings());
  return db;
}

function project(db: ReturnType<typeof initDb>, id: string) {
  return repo.createProject(db, {
    id,
    name: id,
    repoUrl: "https://github.com/x/y",
    defaultBranch: "main",
    localPath: `/tmp/${id}`,
    status: "created",
  });
}

function task(
  db: ReturnType<typeof initDb>,
  id: string,
  projectId: string,
  status: string,
) {
  return repo.createTask(db, {
    id,
    projectId,
    title: `Task ${id}`,
    description: "",
    difficulty: "medium",
    status: status as never,
    dependsOn: [],
    acceptanceCriteria: [],
    assignedModel: "deepseek-flash" as never,
    scopePaths: [],
    attempts: 0,
    maxAttempts: 3,
    runGeneration: 0,
    runExtraAttempts: 0,
    runExhaustedModels: [],
    runRateLimitRetries: 0,
  });
}

function telegramAction(
  db: ReturnType<typeof initDb>,
  updateId: number,
  kind: string,
): string {
  new SqliteTelegramUpdateStore(db).claim(
    {
      update_id: updateId,
      message: {
        chat: { id: 42, type: "private" },
        from: { id: 42 },
        text: `/${kind}`,
      },
    },
    `command:${kind}`,
    { kind, payload: {} },
  );
  return `telegram:${updateId}`;
}

test("setMergePolicy: flips the policy, persists it, and audit-logs against every project", () => {
  const db = setup();
  project(db, "p1");
  project(db, "p2");

  setMergePolicy(db, "fully_autonomous", "telegram");

  const saved = repo.getSettings(db)!;
  assert.equal(saved.mergePolicy, "fully_autonomous");

  for (const pid of ["p1", "p2"]) {
    const entries = repo.getAuditLog(db, pid);
    const match = entries.find((e) => e.kind === "settings_changed");
    assert.ok(match, `expected a settings_changed audit entry for ${pid}`);
    assert.equal(match!.actor, "telegram");
    assert.match(match!.summary, /fully_autonomous/);
  }
});

test("setMergePolicy: flipping back to hard_gate_flag_risky persists that too", () => {
  const db = setup();
  project(db, "p1");
  setMergePolicy(db, "fully_autonomous", "telegram");
  setMergePolicy(db, "hard_gate_flag_risky", "telegram");
  assert.equal(repo.getSettings(db)!.mergePolicy, "hard_gate_flag_risky");
});

test("B37: Telegram policy changes pass through the shared settings validator", () => {
  const db = setup();
  assert.throws(
    () => setMergePolicy(db, "invalid" as never, "telegram"),
    /mergePolicy must be one of/,
  );
  assert.equal(repo.getSettings(db)!.mergePolicy, "hard_gate_flag_risky");
});

test("findTaskByIdPrefix: a unique prefix match resolves to that task", () => {
  const db = setup();
  project(db, "p1");
  task(db, "abc123", "p1", "failed");
  task(db, "def456", "p1", "failed");

  const result = findTaskByIdPrefix(db, "abc");
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.task.id, "abc123");
});

test("findTaskByIdPrefix: no match returns a clear error", () => {
  const db = setup();
  project(db, "p1");
  task(db, "abc123", "p1", "failed");

  const result = findTaskByIdPrefix(db, "zzz");
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.error : "", /No task matches/);
});

test("findTaskByIdPrefix: an ambiguous prefix lists every candidate instead of guessing", () => {
  const db = setup();
  project(db, "p1");
  task(db, "abc111", "p1", "failed");
  task(db, "abc222", "p1", "blocked");

  const result = findTaskByIdPrefix(db, "abc");
  assert.equal(result.ok, false);
  const error = result.ok ? "" : result.error;
  assert.match(error, /Ambiguous/);
  assert.match(error, /abc111/);
  assert.match(error, /abc222/);
});

test("F49: project resolver accepts unique name/id prefixes and rejects ambiguity", () => {
  const db = setup();
  project(db, "alpha-one");
  project(db, "alpha-two");
  repo.updateProject(db, "alpha-one", { name: "Payments API" });
  repo.updateProject(db, "alpha-two", { name: "Payments Web" });

  const exactName = findProjectByPrefix(db, "payments api");
  assert.equal(exactName.ok && exactName.project.id, "alpha-one");
  const idPrefix = findProjectByPrefix(db, "alpha-t");
  assert.equal(idPrefix.ok && idPrefix.project.id, "alpha-two");
  const ambiguous = findProjectByPrefix(db, "pay");
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.ok ? "" : ambiguous.error, /Payments API/);
  assert.match(ambiguous.ok ? "" : ambiguous.error, /Payments Web/);
});

test("F49: HTTP and Telegram can share the same Start/Pause runtime actions", async () => {
  const db = setup();
  project(db, "p1");
  const calls: string[] = [];
  const fakeEngine = {
    start: async () => { calls.push("start"); },
    pause: async () => { calls.push("pause"); },
  } as unknown as EngineRunner;
  const broadcasts: unknown[] = [];

  const started = await startProject(db, fakeEngine, (event) => broadcasts.push(event), "p1");
  assert.equal(started.ok && started.project.status, "running");
  const paused = await pauseProject(db, fakeEngine, (event) => broadcasts.push(event), "p1");
  assert.equal(paused.ok && paused.project.status, "paused");
  assert.deepEqual(calls, ["start", "pause"]);
  assert.equal(broadcasts.length, 2);
});

test("O15: replayed Telegram Start cannot start a completed run again", async () => {
  const db = setup();
  project(db, "p1");
  const key = telegramAction(db, 10, "command_start");
  let active = false;
  let starts = 0;
  const engine = {
    hasActivity: () => active,
    start: () => {
      starts++;
      active = true;
      return Promise.resolve();
    },
  } as unknown as EngineRunner;

  assert.equal((await startProject(db, engine, () => {}, "p1", key)).ok, true);
  // The run settled after the first handler, but the process lost the inbox
  // completion write. Its replay must observe the newer terminal state.
  active = false;
  repo.updateProject(db, "p1", { status: "completed" });
  assert.equal((await startProject(db, engine, () => {}, "p1", key)).ok, true);
  assert.equal(starts, 1);
  assert.equal(repo.getProject(db, "p1")?.status, "completed");
});

test("O15: refused Telegram Start atomically restores status and replays the refusal", async () => {
  const db = setup();
  project(db, "p1");
  const key = telegramAction(db, 15, "command_start");
  let starts = 0;
  const engine = {
    hasActivity: () => false,
    start: () => {
      starts++;
      return Promise.reject(new Error("rollback active"));
    },
  } as unknown as EngineRunner;

  const first = await startProject(db, engine, () => {}, "p1", key);
  const replay = await startProject(db, engine, () => {}, "p1", key);
  assert.equal(first.ok, false);
  assert.deepEqual(replay, first);
  assert.equal(starts, 1);
  assert.equal(repo.getProject(db, "p1")?.status, "created");
});

test("O15: Telegram Pause persists desired state once and reconciles one runtime", async () => {
  const db = setup();
  project(db, "p1");
  repo.updateProject(db, "p1", { status: "running" });
  const key = telegramAction(db, 11, "command_pause");
  let active = true;
  let pauses = 0;
  const engine = {
    hasActivity: () => active,
    pause: () => {
      pauses++;
      active = false;
      return Promise.resolve();
    },
  } as unknown as EngineRunner;

  await pauseProject(db, engine, () => {}, "p1", true, key);
  await pauseProject(db, engine, () => {}, "p1", true, key);
  assert.equal(pauses, 1);
  assert.equal(repo.getProject(db, "p1")?.status, "paused");
});

test("F49: restart recovery re-sends only still-pending approvals", () => {
  const db = setup();
  project(db, "p1");
  repo.createNotification(db, {
    id: "pending",
    projectId: "p1",
    severity: "action_required",
    title: "Pending",
    message: "Needs a decision",
    requiresApproval: true,
    context: { prUrl: "https://github.com/x/y/pull/1" },
  });
  repo.createNotification(db, {
    id: "resolved",
    projectId: "p1",
    severity: "action_required",
    title: "Resolved",
    message: "Already decided",
    requiresApproval: true,
  });
  repo.respondToNotification(db, "resolved", "approve");
  const sent: string[] = [];
  const count = resendPendingApprovals(db, {
    approvalRequested: (notification) => sent.push(notification.id),
  });
  assert.equal(count, 1);
  assert.deepEqual(sent, ["pending"]);
});

test("F49: failed approval delivery creates one web warning and keeps approval pending", () => {
  const db = setup();
  project(db, "p1");
  repo.createNotification(db, {
    id: "approval",
    projectId: "p1",
    severity: "action_required",
    title: "Approval",
    message: "Needs a decision",
    requiresApproval: true,
  });
  const broadcasts: unknown[] = [];
  assert.equal(
    notifyTelegramApprovalFailure(
      db,
      (event) => broadcasts.push(event),
      "approval",
      "network timeout",
    ),
    true,
  );
  assert.equal(
    notifyTelegramApprovalFailure(db, () => {}, "approval", "again"),
    false,
  );
  assert.equal(repo.getNotification(db, "approval")?.respondedWith, undefined);
  const warning = repo.getNotification(db, "telegram-delivery:approval");
  assert.equal(warning?.severity, "warn");
  assert.match(warning?.message ?? "", /network timeout/);
  assert.equal(broadcasts.length, 1);
});

test("retryTask: a task not in a retryable status is rejected without touching the engine", async () => {
  const db = setup();
  const hub = new WsHub();
  const engine = new EngineRunner(db, hub);
  project(db, "p1");
  task(db, "t1", "p1", "in_progress");

  const result = await retryTask(db, engine, () => {}, "t1", "telegram");
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.error : "", /only failed\/changes_requested\/blocked can be retried/);
});

test("retryTask: an unknown task id is rejected", async () => {
  const db = setup();
  const hub = new WsHub();
  const engine = new EngineRunner(db, hub);

  const result = await retryTask(db, engine, () => {}, "nope", "telegram");
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.error : "", /task not found/);
});

test("B42: a blocked task keeps a repaired/reassigned model and Retry clears stale execution state", async () => {
  const db = setup();
  project(db, "p1");
  task(db, "figma-task", "p1", "blocked");
  repo.updateTask(db, "figma-task", {
    assignedModel: "deepseek-pro",
    attempts: 1,
    runGeneration: 2,
    runExtraAttempts: 3,
    runModel: "deepseek-pro",
    runExhaustedModels: ["deepseek-flash"],
    runRateLimitRetries: 1,
    branch: "orc/figma-task",
    worktreePath: "/tmp/figma-task",
    prNumber: 42,
    statusReason: "Fix Figma MCP, then Retry.",
  });
  const dispatches: string[] = [];
  const engine = {
    async dispatchOne(_project: unknown, taskId: string) {
      dispatches.push(taskId);
      return repo.getTask(db, taskId)!;
    },
  } as unknown as EngineRunner;

  const result = await retryTask(
    db,
    engine,
    () => {},
    "figma-task",
    "human",
  );

  assert.equal(result.ok, true);
  const reset = repo.getTask(db, "figma-task")!;
  assert.equal(reset.assignedModel, "deepseek-pro");
  assert.equal(reset.status, "backlog");
  assert.equal(reset.attempts, 0);
  assert.equal(reset.runGeneration, 3);
  assert.equal(reset.runExtraAttempts, 0);
  assert.equal(reset.runModel, undefined);
  assert.deepEqual(reset.runExhaustedModels, []);
  assert.equal(reset.runRateLimitRetries, 0);
  assert.equal(reset.branch, undefined);
  assert.equal(reset.worktreePath, undefined);
  assert.equal(reset.prNumber, undefined);
  assert.equal(reset.statusReason, undefined);
  assert.deepEqual(dispatches, ["figma-task"]);
});

test("O34: concurrent Retry requests start one logical run and create one audit entry", async () => {
  const db = setup();
  project(db, "p1");
  task(db, "retry-race", "p1", "failed");
  const dispatches: string[] = [];
  const engine = {
    async dispatchOne(_project: unknown, taskId: string) {
      dispatches.push(taskId);
      await Promise.resolve();
      return repo.getTask(db, taskId)!;
    },
  } as unknown as EngineRunner;

  const [human, telegram] = await Promise.all([
    retryTask(db, engine, () => {}, "retry-race", "human"),
    retryTask(db, engine, () => {}, "retry-race", "telegram"),
  ]);

  assert.deepEqual(
    [human.ok, telegram.ok].sort(),
    [false, true],
    "exactly one caller wins",
  );
  const loser = human.ok ? telegram : human;
  assert.equal(loser.ok, false);
  assert.equal(!loser.ok && loser.status, 409);
  assert.equal(repo.getTask(db, "retry-race")!.runGeneration, 1);
  assert.deepEqual(dispatches, ["retry-race"]);
  assert.equal(
    repo
      .getAuditLog(db, "p1")
      .filter((entry) => entry.kind === "retry").length,
    1,
  );
});

test("O15: Telegram Retry replay keeps one generation, audit, and dispatch", async () => {
  const db = setup();
  project(db, "p1");
  task(db, "retry-once", "p1", "failed");
  const key = telegramAction(db, 12, "command_retry");
  let dispatches = 0;
  const engine = {
    dispatchOne: (_project: unknown, taskId: string) => {
      dispatches++;
      return Promise.resolve(repo.getTask(db, taskId)!);
    },
    resumeQueued: () => false,
  } as unknown as EngineRunner;

  assert.equal(
    (await retryTask(db, engine, () => {}, "retry-once", "telegram", key)).ok,
    true,
  );
  assert.equal(
    (await retryTask(db, engine, () => {}, "retry-once", "telegram", key)).ok,
    true,
  );
  assert.equal(dispatches, 1);
  assert.equal(repo.getTask(db, "retry-once")?.runGeneration, 1);
  assert.equal(
    repo.getAuditLog(db, "p1").filter((entry) => entry.kind === "retry").length,
    1,
  );
});

test("stopAllProjects: updates status, broadcasts, and audit-logs only for whatever the engine reports as actually stopped", async () => {
  const db = setup();
  project(db, "p1");
  project(db, "p2");
  // A minimal fake standing in for a real EngineRunner here — same
  // narrow-fake-object pattern gate-runner.test.ts uses for WorktreeManager
  // — so this test exercises stopAllProjects' own DB/broadcast/audit
  // handling deterministically, without needing a real orchestrator
  // actually running (that's the engine's own concern, already covered by
  // its own tests; this only reuses engine.stopAll's *result*).
  const fakeEngine = { stopAll: async () => ["p1"] } as unknown as EngineRunner;
  const broadcasts: unknown[] = [];

  const stoppedIds = await stopAllProjects(db, fakeEngine, (e) => broadcasts.push(e), "telegram");

  assert.deepEqual(stoppedIds, ["p1"]);
  assert.equal(repo.getProject(db, "p1")!.status, "paused");
  assert.equal(repo.getProject(db, "p2")!.status, "created", "untouched -- the engine said only p1 was running");
  const audit = repo.getAuditLog(db, "p1").find((e) => e.kind === "stopped");
  assert.ok(audit, "expected a stopped audit entry for p1");
  assert.equal(audit!.actor, "telegram");
  assert.equal(broadcasts.length, 1, "one project.updated broadcast for the one stopped project");
});

test("O15: Telegram Stop-all confirmation persists one target set and one audit", async () => {
  const db = setup();
  project(db, "p1");
  project(db, "p2");
  repo.updateProject(db, "p1", { status: "running" });
  const key = telegramAction(db, 13, "stop_all");
  const active = new Set(["p1"]);
  let pauses = 0;
  const engine = {
    hasActivity: (id: string) => active.has(id),
    pause: (p: { id: string }) => {
      pauses++;
      active.delete(p.id);
      return Promise.resolve();
    },
  } as unknown as EngineRunner;

  assert.deepEqual(
    await stopAllProjects(db, engine, () => {}, "telegram", key),
    ["p1"],
  );
  assert.deepEqual(
    await stopAllProjects(db, engine, () => {}, "telegram", key),
    ["p1"],
  );
  assert.equal(pauses, 1);
  assert.equal(repo.getProject(db, "p1")?.status, "paused");
  assert.equal(
    repo.getAuditLog(db, "p1").filter((entry) => entry.kind === "stopped").length,
    1,
  );
});

test("O15: Telegram settings actions replay without duplicate audit entries", () => {
  const db = setup();
  project(db, "p1");
  const key = telegramAction(db, 14, "settings_autonomous");
  setMergePolicy(db, "fully_autonomous", "telegram", key);
  setMergePolicy(db, "fully_autonomous", "telegram", key);
  assert.equal(repo.getSettings(db)?.mergePolicy, "fully_autonomous");
  assert.equal(
    repo
      .getAuditLog(db, "p1")
      .filter((entry) => entry.kind === "settings_changed").length,
    1,
  );
});

test("O15: Telegram digest changes replay one normalized settings write", () => {
  const db = setup();
  const key = telegramAction(db, 16, "settings_digest");
  assert.equal(setTelegramDigest(db, "all", key), true);
  assert.equal(setTelegramDigest(db, "all", key), true);
  assert.equal(repo.getSettings(db)?.telegram?.digest, "all");
  const row = db
    .prepare("SELECT state, result FROM telegram_actions WHERE idempotency_key = ?")
    .get(key) as { state: string; result: string };
  assert.equal(row.state, "effect_committed");
  assert.equal(JSON.parse(row.result), true);
});
