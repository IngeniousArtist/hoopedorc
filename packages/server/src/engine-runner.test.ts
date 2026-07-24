import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Orchestrator, OrchestratorStartOptions, SchedulerDeps } from "@orc/engine";
import { InvocationLedgerError } from "@orc/types";
import type {
  FigmaCapabilityIssue,
  GateResult,
  ModelInvocation,
  Project,
  RollbackJob,
  Task,
  VerifiedFigmaReference,
} from "@orc/types";
import { defaultSettings } from "./config.js";
import { initDb } from "./db/index.js";
import * as repo from "./db/repo.js";
import {
  EngineRunner,
  type RollbackExecutionDeps,
} from "./engine-runner.js";
import { FigmaVerificationError } from "./planner.js";
import type { ServerNotifier } from "./telegram.js";
import { WsHub } from "./ws-hub.js";

function setup() {
  const db = initDb(":memory:");
  repo.upsertSettings(db, defaultSettings());
  return db;
}

function project(db: ReturnType<typeof initDb>, id: string, over: Partial<Project> = {}): Project {
  return repo.createProject(db, {
    id,
    name: id,
    repoUrl: "https://github.com/x/y",
    defaultBranch: "main",
    localPath: `/tmp/${id}`,
    status: "created",
    ...over,
  });
}

function seedTask(
  db: ReturnType<typeof initDb>,
  projectId: string,
  id: string,
  over: Partial<Task> = {},
): Task {
  const created = repo.createTask(db, {
    id,
    projectId,
    title: id,
    description: "",
    difficulty: "medium",
    status: "ready",
    dependsOn: [],
    acceptanceCriteria: [],
    assignedModel: "deepseek-flash",
    scopePaths: [],
    attempts: 0,
    maxAttempts: 3,
    ...over,
  });
  return repo.updateTask(db, created.id, over) ?? created;
}

function controlledOrchestrator() {
  let resolveStart!: () => void;
  const startGate = new Promise<void>((resolve) => {
    resolveStart = resolve;
  });
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const state: {
    startCalls: number;
    pauseCalls: { drain?: boolean }[];
    startOptions?: OrchestratorStartOptions;
  } = { startCalls: 0, pauseCalls: [] };
  const orchestrator = {
    start(
      _project: Project,
      _tasks: Task[],
      options: OrchestratorStartOptions,
    ): Promise<void> {
      state.startCalls++;
      state.startOptions = options;
      resolveStarted();
      return startGate;
    },
    async pause(_project: Project, options: { drain?: boolean } = {}): Promise<void> {
      state.pauseCalls.push(options);
    },
    stopTask(): boolean {
      return false;
    },
  } as unknown as Orchestrator;
  return { orchestrator, state, started, resolveStart };
}

function activeRuntime(engine: EngineRunner, projectId: string): { settled: Promise<void> } {
  return (
    engine as unknown as { runtimes: Map<string, { settled: Promise<void> }> }
  ).runtimes.get(projectId)!;
}

test("B39: EngineRunner blocks every Start path while planning persistence is pending", async () => {
  const db = setup();
  const engine = new EngineRunner(db, new WsHub());
  const pending = project(db, "planning-pending", { status: "planning" });

  await assert.rejects(engine.start(pending), /planning artifacts are not durable yet/i);
  assert.equal(engine.hasActivity(pending.id), false);
});

const ROLLBACK_GATE: GateResult = {
  typecheck: true,
  lint: true,
  build: true,
  tests: true,
  noConflicts: true,
  inScope: true,
  details: {},
};

async function waitForRollback(
  db: ReturnType<typeof initDb>,
  id: string,
  predicate: (job: RollbackJob) => boolean,
): Promise<RollbackJob> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const job = repo.getRollbackJob(db, id);
    if (job && predicate(job)) return job;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`rollback ${id} did not reach the expected state`);
}

function fakeRollbackDeps(settings = defaultSettings()): {
  deps: RollbackExecutionDeps;
  calls: {
    prepare: number;
    push: number;
    open: number;
    close: number;
    merge: number;
    remove: number;
  };
} {
  const calls = { prepare: 0, push: 0, open: 0, close: 0, merge: 0, remove: 0 };
  const deps: RollbackExecutionDeps = {
    settings,
    git: {
      async ensureClone() {},
      async commitAll() {},
      async push() { calls.push++; },
      async openPr() { return 1; },
      async mergePr() { calls.merge++; },
      async resolvePrMergeCommit() { return "a".repeat(40); },
      async prepareRollback() {
        calls.prepare++;
        return { sourceCommit: "a".repeat(40), sourceParentCount: 1 };
      },
      async openRollbackPr() { calls.open++; return 88; },
      async closeRollbackPr() { calls.close++; },
      async appendChangelogEntry() {},
      async syncBranchWithMain() { return "clean"; },
      async waitForChecks() { return "none"; },
      async cleanupTaskBranch() {},
    },
    worktrees: {
      async create() { return { branch: "", path: "" }; },
      async remove() { calls.remove++; },
      async prepareForGates() {},
      async changedFiles() { return []; },
      async changedFilesInScope() { return true; },
      async revertOutOfScope() { return []; },
      async changedFilesWithStatus() {
        return { ok: true, value: [], byteCount: 0, truncated: false };
      },
      async diffText() {
        return { ok: true, value: "", byteCount: 0, truncated: false };
      },
      async worktreeChanges() {
        return { ok: true, value: [], byteCount: 0, truncated: false };
      },
      async restoreToHead() {
        return { ok: true, value: undefined, byteCount: 0, truncated: false };
      },
      async primaryDirtyFiles() { return []; },
    },
    gates: { async run() { return { ...ROLLBACK_GATE, details: {} }; } },
    validator: {
      async review(project, task, gate) {
        return {
          id: crypto.randomUUID(),
          projectId: project.id,
          taskId: task.id,
          runId: `rollback-${task.id}`,
          validatorModel: "claude",
          verdict: "approve",
          reasons: ["rollback is scoped"],
          confidence: 0.95,
          gate,
          ts: new Date().toISOString(),
        };
      },
    },
  };
  return { deps, calls };
}

/** F44: reaches the same private buildOrchestrator() method + its
 *  SchedulerDeps that a real run's Orchestrator is constructed from, so
 *  `onModelTrouble` can be invoked directly without needing a full
 *  end-to-end run (mirrors the reflection pattern used elsewhere in this
 *  codebase for reaching private engine wiring). */
function buildDeps(engine: EngineRunner, proj: Project): SchedulerDeps {
  const orch = (
    engine as unknown as { buildOrchestrator: (p: Project) => Orchestrator }
  ).buildOrchestrator(proj);
  return (orch as unknown as { deps: SchedulerDeps }).deps;
}

test("F44: a model-trouble event creates exactly one web notification + broadcast, a repeat for the same task+event creates none", () => {
  const db = setup();
  const hub = new WsHub();
  const broadcasts: unknown[] = [];
  hub.broadcast = ((e: unknown) => broadcasts.push(e)) as typeof hub.broadcast;
  const engine = new EngineRunner(db, hub);
  const proj = project(db, "p1");
  repo.createTask(db, {
    id: "t1", projectId: "p1", title: "T1", description: "", difficulty: "medium",
    status: "in_progress", dependsOn: [], acceptanceCriteria: [],
    assignedModel: "deepseek-flash", scopePaths: [], attempts: 1, maxAttempts: 3,
  });

  const deps = buildDeps(engine, proj);
  const info = {
    taskId: "t1",
    taskTitle: "T1",
    model: "deepseek-flash" as const,
    event: "fallback" as const,
    detail: "Switched to fallback model after gates kept failing",
  };
  deps.events.onModelTrouble!(info);
  deps.events.onModelTrouble!(info); // identical repeat — must not double up

  const notifs = repo.getNotifications(db, "p1");
  const trouble = notifs.filter((n) => n.taskId === "t1" && /fallback/.test(n.title));
  assert.equal(trouble.length, 1, "should create exactly one notification for the repeated event");
  assert.equal(trouble[0]!.severity, "warn");
  assert.equal(trouble[0]!.requiresApproval, false);
  assert.match(trouble[0]!.message, /Switched to fallback model/);

  const notifBroadcasts = broadcasts.filter(
    (b) => (b as { type: string }).type === "notification",
  );
  assert.equal(notifBroadcasts.length, 1, "should broadcast exactly once too");
});

test("F44: a DIFFERENT event for the same task gets its own notification (dedupe is per task+event, not per task)", () => {
  const db = setup();
  const hub = new WsHub();
  const engine = new EngineRunner(db, hub);
  const proj = project(db, "p1");
  repo.createTask(db, {
    id: "t1", projectId: "p1", title: "T1", description: "", difficulty: "medium",
    status: "in_progress", dependsOn: [], acceptanceCriteria: [],
    assignedModel: "deepseek-flash", scopePaths: [], attempts: 1, maxAttempts: 3,
  });

  const deps = buildDeps(engine, proj);
  deps.events.onModelTrouble!({
    taskId: "t1", taskTitle: "T1", model: "deepseek-flash",
    event: "fallback", detail: "first",
  });
  deps.events.onModelTrouble!({
    taskId: "t1", taskTitle: "T1", model: "deepseek-pro",
    event: "exhausted", detail: "second",
  });

  const notifs = repo.getNotifications(db, "p1").filter((n) => n.taskId === "t1");
  assert.equal(notifs.length, 2);
});

test("F44: a fresh buildOrchestrator() call (a new run) resets the dedupe — no explicit clear needed", () => {
  const db = setup();
  const hub = new WsHub();
  const engine = new EngineRunner(db, hub);
  const proj = project(db, "p1");
  repo.createTask(db, {
    id: "t1", projectId: "p1", title: "T1", description: "", difficulty: "medium",
    status: "in_progress", dependsOn: [], acceptanceCriteria: [],
    assignedModel: "deepseek-flash", scopePaths: [], attempts: 1, maxAttempts: 3,
  });

  const info = {
    taskId: "t1", taskTitle: "T1", model: "deepseek-flash" as const,
    event: "fallback" as const, detail: "x",
  };
  buildDeps(engine, proj).events.onModelTrouble!(info);
  // A brand-new Orchestrator (as a real second start()/dispatchOne() call
  // would build) gets a brand-new dedupe Set, so the same event notifies again.
  buildDeps(engine, proj).events.onModelTrouble!(info);

  const notifs = repo.getNotifications(db, "p1").filter((n) => n.taskId === "t1");
  assert.equal(notifs.length, 2);
});

test("B42: author preflight probes one node per file, records health accounting, and caches only this runtime/model/file", async () => {
  const db = setup();
  const hub = new WsHub();
  const proj = project(db, "figma-preflight", { localPath: "/tmp/figma-preflight" });
  const first = seedTask(db, proj.id, "first", {
    description:
      "Use https://www.figma.com/design/FileOne/App?node-id=1-2 and " +
      "https://www.figma.com/design/FileOne/App?node-id=3-4 and " +
      "https://www.figma.com/design/FileTwo/App?node-id=5-6",
  });
  const probeBatches: string[][] = [];
  let invocationSequence = 0;
  const engine = new EngineRunner(db, hub, {
    figmaVerifier: async (
      requested,
      _cwd,
      plannerModel,
      _signal,
      onInvocation,
    ) => {
      probeBatches.push(requested.map((reference) => reference.fileKey));
      invocationSequence++;
      const startedAt = new Date().toISOString();
      const base: ModelInvocation = {
        id: `health-b42-${invocationSequence}`,
        stage: "health",
        model: plannerModel.id!,
        runner: plannerModel.runner,
        effort: plannerModel.effort ?? "default",
        startedAt,
        outcome: "running",
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
        tokensCached: 0,
      };
      onInvocation?.(base);
      onInvocation?.({
        ...base,
        endedAt: new Date().toISOString(),
        outcome: "completed",
        exitReason: "completed",
        tokensIn: 2,
        tokensOut: 1,
      });
      const references: VerifiedFigmaReference[] = requested.map((reference) => ({
        ...reference,
        name: reference.nodeId,
        verifiedModel: plannerModel.id!,
        verifiedRunner: plannerModel.runner,
        verifiedAt: new Date().toISOString(),
      }));
      return { references, costUsd: 0 };
    },
  });
  const deps = buildDeps(engine, proj);

  const result = await deps.preflightFigma!({
    project: proj,
    task: first,
    model: first.assignedModel,
  });
  assert.equal(result.required, true);
  assert.deepEqual(probeBatches, [["FileOne", "FileTwo"]]);
  const invocation = repo.getInvocations(db, { taskId: first.id })[0]!;
  assert.equal(invocation.projectId, proj.id);
  assert.equal(invocation.taskId, first.id);
  assert.equal(invocation.stage, "health");
  assert.equal(invocation.outcome, "completed");

  await deps.preflightFigma!({
    project: proj,
    task: first,
    model: first.assignedModel,
  });
  const sameFiles = seedTask(db, proj.id, "same-files", {
    description:
      "Use https://www.figma.com/design/FileOne/App?node-id=9-10",
  });
  await deps.preflightFigma!({
    project: proj,
    task: sameFiles,
    model: sameFiles.assignedModel,
  });
  assert.equal(probeBatches.length, 1, "same runtime/model/file should reuse access");

  const changedSettings = repo.getSettings(db)!;
  repo.upsertSettings(db, {
    ...changedSettings,
    models: changedSettings.models.map((model) =>
      model.id === sameFiles.assignedModel
        ? { ...model, opencodeModel: "changed/provider-model" }
        : model,
    ),
  });
  await deps.preflightFigma!({
    project: proj,
    task: sameFiles,
    model: sameFiles.assignedModel,
  });
  assert.equal(
    probeBatches.length,
    2,
    "a live runner-model configuration change must prove access again",
  );

  const otherModel = seedTask(db, proj.id, "other-model", {
    assignedModel: "deepseek-pro",
    description:
      "Use https://www.figma.com/design/FileOne/App?node-id=9-10",
  });
  await deps.preflightFigma!({
    project: proj,
    task: otherModel,
    model: otherModel.assignedModel,
  });
  assert.deepEqual(probeBatches.at(-1), ["FileOne"]);

  const ordinary = seedTask(db, proj.id, "ordinary");
  const ordinaryResult = await deps.preflightFigma!({
    project: proj,
    task: ordinary,
    model: ordinary.assignedModel,
  });
  assert.deepEqual(ordinaryResult, { required: false });
  assert.equal(probeBatches.length, 3, "no-Figma task must not call the verifier");

  const freshRuntimeDeps = buildDeps(engine, proj);
  await freshRuntimeDeps.preflightFigma!({
    project: proj,
    task: sameFiles,
    model: sameFiles.assignedModel,
  });
  assert.equal(probeBatches.length, 4, "new runtime must prove access again");
});

test("B46: a positive Figma access result expires after its TTL within the same runtime", async () => {
  const db = setup();
  const proj = project(db, "figma-ttl", { localPath: "/tmp/figma-ttl" });
  const task = seedTask(db, proj.id, "task", {
    description: "Use https://www.figma.com/design/FileOne/App?node-id=1-2",
  });
  const probeBatches: string[][] = [];
  let clock = 0;
  const engine = new EngineRunner(db, new WsHub(), {
    now: () => clock,
    figmaVerifier: async (requested) => {
      probeBatches.push(requested.map((reference) => reference.fileKey));
      const references: VerifiedFigmaReference[] = requested.map((reference) => ({
        ...reference,
        name: reference.nodeId,
        verifiedModel: "deepseek-flash",
        verifiedRunner: "opencode",
        verifiedAt: new Date().toISOString(),
      }));
      return { references, costUsd: 0 };
    },
  });
  const deps = buildDeps(engine, proj);

  await deps.preflightFigma!({ project: proj, task, model: task.assignedModel });
  assert.equal(probeBatches.length, 1);

  // Just under the TTL: still fresh, no re-probe.
  clock += 4 * 60 * 1000;
  await deps.preflightFigma!({ project: proj, task, model: task.assignedModel });
  assert.equal(probeBatches.length, 1, "a result inside its TTL must be reused");

  // Past the TTL: a Retry must prove access again even within the same
  // project runtime (e.g. after an operator fixes the runner's Figma MCP
  // mid-runtime — B46's live-acceptance scenario).
  clock += 2 * 60 * 1000;
  await deps.preflightFigma!({ project: proj, task, model: task.assignedModel });
  assert.equal(probeBatches.length, 2, "an expired result must be proven again");
});

test("B46: a ledger failure during Figma preflight propagates instead of a false unavailable block", async () => {
  const db = setup();
  const proj = project(db, "figma-ledger-failure", { localPath: "/tmp/figma-ledger-failure" });
  const task = seedTask(db, proj.id, "task", {
    description: "Use https://www.figma.com/design/FileOne/App?node-id=1-2",
  });
  const engine = new EngineRunner(db, new WsHub(), {
    figmaVerifier: async (_requested, _cwd, plannerModel, _signal, onInvocation) => {
      // Mirrors what a real recordInvocation failure looks like from the
      // verifier's perspective: the accounting sink itself throws.
      onInvocation?.({
        id: "health-ledger-fail",
        stage: "health",
        model: plannerModel.id!,
        runner: plannerModel.runner,
        effort: plannerModel.effort ?? "default",
        startedAt: new Date().toISOString(),
        outcome: "running",
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
        tokensCached: 0,
      });
      throw new Error("unreachable: onInvocation above must throw first");
    },
  });
  const deps = buildDeps(engine, proj);
  db.exec("DROP TABLE model_invocations");

  await assert.rejects(
    deps.preflightFigma!({ project: proj, task, model: task.assignedModel }),
    (error: unknown) => {
      assert.ok(
        error instanceof InvocationLedgerError,
        `expected InvocationLedgerError, got ${error instanceof Error ? error.constructor.name : String(error)}`,
      );
      return true;
    },
  );
});

test("B42: preflight failures keep structured author-stage recovery context", async () => {
  const db = setup();
  const proj = project(db, "figma-failure");
  const task = seedTask(db, proj.id, "task", {
    description:
      "Use https://www.figma.com/design/FileOne/App?node-id=1-2",
  });
  const issue: FigmaCapabilityIssue = {
    stage: "author_preflight",
    code: "figma_auth_required",
    model: task.assignedModel,
    runner: "opencode",
    message: "The selected runner's Figma MCP needs authentication.",
    actions: ["Authenticate, then Retry."],
    canonicalUrl:
      "https://www.figma.com/design/FileOne/App?node-id=1-2",
    nodeId: "1:2",
  };
  const engine = new EngineRunner(db, new WsHub(), {
    figmaVerifier: async () => {
      throw new FigmaVerificationError(issue);
    },
  });
  const result = await buildDeps(engine, proj).preflightFigma!({
    project: proj,
    task,
    model: task.assignedModel,
  });
  assert.equal(result.required, true);
  if (!result.required) assert.fail("expected a Figma-dependent result");
  assert.deepEqual(result.issue, issue);
});

test("B42: capability notification and Telegram alert dedupe durably across runtimes", () => {
  const db = setup();
  const hub = new WsHub();
  const broadcasts: unknown[] = [];
  hub.broadcast = ((event: unknown) => broadcasts.push(event)) as typeof hub.broadcast;
  const proj = project(db, "figma-notification");
  const task = seedTask(db, proj.id, "task", {
    status: "blocked",
    statusReason:
      "Figma auth required. Model: deepseek-flash; runner: opencode. Recovery: Retry.",
  });
  const telegram: string[] = [];
  const notifier: ServerNotifier = {
    approvalRequested() {},
    taskStatus() {},
    info(message) { telegram.push(message); },
    modelTrouble() {},
  };
  const engine = new EngineRunner(db, hub);
  engine.setNotifier(notifier);
  const info = {
    taskId: task.id,
    taskTitle: task.title,
    issue: {
      stage: "author_preflight",
      code: "figma_auth_required",
      model: task.assignedModel,
      runner: "opencode",
      message: "Figma auth required.",
      actions: ["Authenticate, then Retry."],
      canonicalUrl:
        "https://www.figma.com/design/FileOne/App?node-id=1-2",
      nodeId: "1:2",
    } satisfies FigmaCapabilityIssue,
  };

  buildDeps(engine, proj).events.onFigmaCapabilityBlocked!(info);
  buildDeps(engine, proj).events.onFigmaCapabilityBlocked!(info);

  const notifications = repo
    .getNotifications(db, proj.id)
    .filter((notification) => /Figma access blocked/.test(notification.title));
  assert.equal(notifications.length, 1);
  assert.ok(notifications[0]!.context?.capabilityKey);
  assert.doesNotMatch(notifications[0]!.message, /secret|token=/i);
  assert.equal(telegram.length, 1);
  assert.equal(
    broadcasts.filter(
      (event) => (event as { type?: string }).type === "notification",
    ).length,
    1,
  );
  assert.equal(
    repo
      .getAuditLog(db, proj.id)
      .filter((entry) => entry.kind === "capability_blocked").length,
    1,
  );
});

test("B42: a run with blocked work finishes paused, never falsely completed", () => {
  const db = setup();
  const hub = new WsHub();
  const proj = project(db, "figma-paused", { status: "running" });
  seedTask(db, proj.id, "blocked", {
    status: "blocked",
    statusReason: "Fix Figma access, then Retry.",
  });
  const engine = new EngineRunner(db, hub);
  (
    engine as unknown as {
      finishAutonomousRun(project: Project, startedAt: string): void;
    }
  ).finishAutonomousRun(proj, new Date().toISOString());
  assert.equal(repo.getProject(db, proj.id)?.status, "paused");
});

test("F44: a run ending non-completed creates a web notification carrying the same message as the log line", async () => {
  const db = setup();
  const hub = new WsHub();
  const broadcasts: unknown[] = [];
  hub.broadcast = ((e: unknown) => broadcasts.push(e)) as typeof hub.broadcast;
  const engine = new EngineRunner(db, hub);
  // repoUrl points nowhere real — ensureClone fails, but start()'s async
  // IIFE catches that internally and its `finally` still runs against
  // whatever's already in the DB (same technique F19's scheduler test used
  // for exercising a real EngineRunner.start() without a real git remote).
  const proj = project(db, "p1", { repoUrl: "https://github.com/nonexistent/nowhere" });
  repo.createTask(db, {
    id: "t1", projectId: "p1", title: "T1", description: "", difficulty: "medium",
    status: "failed", dependsOn: [], acceptanceCriteria: [],
    assignedModel: "deepseek-flash", scopePaths: [], attempts: 3, maxAttempts: 3,
  });

  await engine.start(proj);
  // start() kicks off a fire-and-forget async IIFE — give it a tick to reach
  // the finally block (ensureClone's failure is fast, no real network work
  // beyond attempting the clone).
  for (let i = 0; i < 50 && !repo.getNotifications(db, "p1").some((n) => /Run ended/.test(n.title)); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }

  const runEndNotif = repo.getNotifications(db, "p1").find((n) => /Run ended/.test(n.title));
  assert.ok(runEndNotif, "expected a run-ended notification");
  assert.equal(runEndNotif!.severity, "warn");
  assert.match(runEndNotif!.message, /Run ended \(failed\)/);
  assert.match(runEndNotif!.message, /T1 \[failed\]/);

  const notifBroadcasts = broadcasts.filter(
    (b) => (b as { type: string }).type === "notification",
  );
  assert.ok(notifBroadcasts.length >= 1);
});

test("B34: repeated manual dispatches share one project runtime and one scheduler predicate", async () => {
  const db = setup();
  const hub = new WsHub();
  const proj = project(db, "p1");
  seedTask(db, proj.id, "t1");
  seedTask(db, proj.id, "t2");
  const ordinary = seedTask(db, proj.id, "ordinary");
  const controlled = controlledOrchestrator();
  let factoryCalls = 0;
  const engine = new EngineRunner(db, hub, {
    ensureClone: async () => {},
    orchestratorFactory: () => {
      factoryCalls++;
      return controlled.orchestrator;
    },
  });

  const first = await engine.dispatchOne(proj, "t1");
  await controlled.started;
  const runtime = activeRuntime(engine, proj.id);
  const second = await engine.dispatchOne(proj, "t2");

  assert.ok(first.dispatchRequestedAt);
  assert.ok(second.dispatchRequestedAt);
  assert.equal(factoryCalls, 1);
  assert.equal(engine.hasActivity(proj.id), true);
  assert.equal(controlled.state.startOptions!.shouldDispatch!(repo.getTask(db, "t1")!), true);
  assert.equal(controlled.state.startOptions!.shouldDispatch!(ordinary), false);

  repo.clearDispatchRequests(db, proj.id);
  controlled.resolveStart();
  await runtime.settled;
  assert.equal(engine.hasActivity(proj.id), false);
});

test("B34: Start promotes a manual runtime instead of constructing a competing Orchestrator", async () => {
  const db = setup();
  const hub = new WsHub();
  const proj = project(db, "p1");
  seedTask(db, proj.id, "manual");
  const ordinary = seedTask(db, proj.id, "ordinary");
  const controlled = controlledOrchestrator();
  let factoryCalls = 0;
  const engine = new EngineRunner(db, hub, {
    ensureClone: async () => {},
    orchestratorFactory: () => {
      factoryCalls++;
      return controlled.orchestrator;
    },
  });

  await engine.dispatchOne(proj, "manual");
  await controlled.started;
  const runtime = activeRuntime(engine, proj.id);
  await engine.start(proj);

  assert.equal(factoryCalls, 1);
  assert.equal(engine.isRunning(proj.id), true);
  assert.equal(controlled.state.startOptions!.shouldDispatch!(ordinary), true);

  repo.clearDispatchRequests(db, proj.id);
  controlled.resolveStart();
  await runtime.settled;
  assert.equal(engine.hasActivity(proj.id), false);
});

test("B34: hard Stop keeps ownership registered until the exact runtime settles", async () => {
  const db = setup();
  const hub = new WsHub();
  const proj = project(db, "p1");
  seedTask(db, proj.id, "t1");
  const controlled = controlledOrchestrator();
  const engine = new EngineRunner(db, hub, {
    ensureClone: async () => {},
    orchestratorFactory: () => controlled.orchestrator,
    stopSettleTimeoutMs: 5,
  });

  await engine.start(proj);
  await controlled.started;
  const runtime = activeRuntime(engine, proj.id);
  await engine.pause(proj, { drain: false });

  assert.equal(controlled.state.pauseCalls.length, 1);
  assert.equal(engine.hasActivity(proj.id), true);
  await assert.rejects(engine.start(proj), /stopping/);

  controlled.resolveStart();
  await runtime.settled;
  assert.equal(engine.hasActivity(proj.id), false);
});

test("B34: persisted manual requests resume after process restart", async () => {
  const db = setup();
  const hub = new WsHub();
  const proj = project(db, "p1");
  seedTask(db, proj.id, "queued", {
    dispatchRequestedAt: "2026-07-14T00:00:00.000Z",
  });
  const controlled = controlledOrchestrator();
  const engine = new EngineRunner(db, hub, {
    ensureClone: async () => {},
    orchestratorFactory: () => controlled.orchestrator,
  });

  assert.equal(engine.resumeQueued(proj), true);
  assert.equal(engine.resumeQueued(proj), false, "the registered runtime keeps sole ownership");
  await controlled.started;
  const runtime = activeRuntime(engine, proj.id);

  repo.clearDispatchRequests(db, proj.id);
  controlled.resolveStart();
  await runtime.settled;
  assert.equal(engine.hasActivity(proj.id), false);
});

test("B41: shutdown rejects new work and uses one deadline across every runtime", async () => {
  const db = setup();
  const projects = [project(db, "p1"), project(db, "p2")];
  for (const proj of projects) seedTask(db, proj.id, `${proj.id}-task`);
  repo.updateTask(db, "p1-task", {
    dispatchRequestedAt: "2026-07-15T00:00:00.000Z",
  });
  const controls = projects.map(() => controlledOrchestrator());
  let factory = 0;
  const engine = new EngineRunner(db, new WsHub(), {
    ensureClone: async () => {},
    orchestratorFactory: () => controls[factory++]!.orchestrator,
    shutdownDeadlineMs: 5,
  });

  await Promise.all(projects.map((proj) => engine.start(proj)));
  await Promise.all(controls.map((control) => control.started));
  const first = engine.shutdown(projects);
  const second = engine.shutdown(projects);
  assert.equal(second, first, "repeated fatal/signal events share one shutdown");
  const result = await first;

  assert.equal(result.settled, false);
  assert.deepEqual(result.stoppedProjectIds.sort(), ["p1", "p2"]);
  assert.deepEqual(result.pendingProjectIds.sort(), ["p1", "p2"]);
  assert.equal(controls[0]!.state.pauseCalls.length, 1);
  assert.equal(controls[1]!.state.pauseCalls.length, 1);
  assert.equal(repo.getTask(db, "p1-task")?.dispatchRequestedAt, undefined);
  await assert.rejects(engine.start(projects[0]!), /shutting down/);
  await assert.rejects(
    engine.dispatchOne(projects[0]!, "p1-task"),
    /shutting down/,
  );

  for (const control of controls) control.resolveStart();
  await Promise.all(projects.map((proj) => activeRuntime(engine, proj.id)?.settled));
});

test("B41: a rate-limit cooldown survives a database and EngineRunner restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "hoopedorc-cooldown-restart-"));
  const path = join(dir, "orc.db");
  try {
    const firstDb = initDb(path);
    repo.upsertSettings(firstDb, defaultSettings());
    const proj = project(firstDb, "p1");
    seedTask(firstDb, proj.id, "t1", { status: "in_progress", attempts: 1 });
    const firstEngine = new EngineRunner(firstDb, new WsHub());
    const events = buildDeps(firstEngine, proj).events;
    const startedAt = new Date().toISOString();
    events.onRunUpdated({
      id: "rate-limited-run",
      projectId: proj.id,
      taskId: "t1",
      model: "deepseek-flash",
      attempt: 1,
      status: "running",
      startedAt,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
    });
    events.onRunUpdated({
      id: "rate-limited-run",
      projectId: proj.id,
      taskId: "t1",
      model: "deepseek-flash",
      attempt: 1,
      status: "failed",
      startedAt,
      endedAt: new Date().toISOString(),
      exitReason: "rate_limited",
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
    });
    const firstUntil = firstEngine.getCoolingDownUntil("deepseek-flash");
    assert.ok(firstUntil && firstUntil > Date.now());
    firstDb.close();

    const reopened = initDb(path);
    const restartedEngine = new EngineRunner(reopened, new WsHub());
    assert.equal(restartedEngine.getCoolingDownUntil("deepseek-flash"), firstUntil);
    assert.match(
      restartedEngine.checkModelCooldown("deepseek-flash") ?? "",
      /cooling down/,
    );
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B41: shutdown aborts a managed rollback stage and leaves it restartable", async () => {
  const db = setup();
  const proj = project(db, "rollback-shutdown");
  const task = seedTask(db, proj.id, "source", {
    status: "done",
    prNumber: 42,
  });
  const base = fakeRollbackDeps();
  let started!: () => void;
  const cloneStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let aborted = false;
  base.deps.git.ensureClone = async (_project, signal) => {
    started();
    await new Promise<void>((_resolve, reject) => {
      const onAbort = () => {
        aborted = true;
        reject(new DOMException("aborted", "AbortError"));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  };
  const engine = new EngineRunner(db, new WsHub(), {
    rollbackDepsFactory: () => base.deps,
    shutdownDeadlineMs: 100,
  });

  const job = await engine.rollback(proj, task);
  await cloneStarted;
  const result = await engine.shutdown([proj]);

  assert.equal(aborted, true);
  assert.equal(result.settled, true);
  assert.deepEqual(result.pendingRollbackIds, []);
  const saved = repo.getRollbackJob(db, job.id)!;
  assert.equal(saved.status, "requested");
  assert.match(saved.statusReason ?? "", /resume on restart/);
  assert.equal(
    repo.getAuditLog(db, proj.id).some((entry) => entry.kind === "rollback_interrupted"),
    true,
  );
});

test("B34: an old runtime finally cannot unregister a newer generation", async () => {
  const db = setup();
  const hub = new WsHub();
  const proj = project(db, "p1");
  seedTask(db, proj.id, "t1");
  const oldControl = controlledOrchestrator();
  const newControl = controlledOrchestrator();
  const controls = [oldControl, newControl];
  let factoryIndex = 0;
  const engine = new EngineRunner(db, hub, {
    ensureClone: async () => {},
    orchestratorFactory: () => controls[factoryIndex++]!.orchestrator,
  });

  await engine.start(proj);
  await oldControl.started;
  const runtimes = (
    engine as unknown as { runtimes: Map<string, { settled: Promise<void> }> }
  ).runtimes;
  const oldRuntime = runtimes.get(proj.id)!;

  // Simulate the historical race's stale cleanup boundary directly: a newer
  // generation owns the key by the time the old Promise reaches finally.
  runtimes.delete(proj.id);
  await engine.start(proj);
  await newControl.started;
  const newRuntime = runtimes.get(proj.id)!;

  oldControl.resolveStart();
  await oldRuntime.settled;
  assert.equal(runtimes.get(proj.id), newRuntime);
  assert.equal(repo.getProject(db, proj.id)!.status, "created", "stale finalization is ignored too");

  newControl.resolveStart();
  await newRuntime.settled;
  assert.equal(engine.hasActivity(proj.id), false);
});

test("B34: a late adapter result cannot overwrite a run already marked stopped", () => {
  const db = setup();
  const hub = new WsHub();
  const engine = new EngineRunner(db, hub);
  const proj = project(db, "p1");
  seedTask(db, proj.id, "t1", { status: "in_progress", attempts: 1 });
  repo.createRun(db, {
    id: "run-t1-1",
    projectId: proj.id,
    taskId: "t1",
    model: "deepseek-flash",
    attempt: 1,
    status: "stopped",
    startedAt: "2026-07-14T00:00:00.000Z",
    endedAt: "2026-07-14T00:01:00.000Z",
    exitReason: "killed",
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
  });

  buildDeps(engine, proj).events.onRunUpdated({
    id: "run-t1-1",
    projectId: proj.id,
    taskId: "t1",
    model: "deepseek-flash",
    attempt: 1,
    status: "failed",
    startedAt: "2026-07-14T00:00:00.000Z",
    endedAt: "2026-07-14T00:01:01.000Z",
    exitReason: "killed",
    costUsd: 0.01,
    tokensIn: 10,
    tokensOut: 5,
  });

  const saved = repo.getRun(db, "run-t1-1")!;
  assert.equal(saved.status, "stopped");
  assert.equal(saved.exitReason, "killed");
  assert.equal(saved.costUsd, 0.01);
  assert.equal(saved.tokensIn, 10);
});

test("B40: author fallbacks and docs runs become distinct correlated invocations", () => {
  const db = setup();
  const engine = new EngineRunner(db, new WsHub());
  const proj = project(db, "ledger-runs");
  const task = seedTask(db, proj.id, "task", { status: "in_progress", attempts: 1 });
  const deps = buildDeps(engine, proj);

  const emit = (
    id: string,
    model: string,
    status: "running" | "passed",
    attempt: number,
  ) => deps.events.onRunUpdated({
    id,
    projectId: proj.id,
    taskId: task.id,
    model,
    effort: "default",
    attempt,
    status,
    startedAt: "2026-07-15T00:00:00.000Z",
    endedAt: status === "passed" ? "2026-07-15T00:00:01.000Z" : undefined,
    exitReason: status === "passed" ? "completed" : undefined,
    costUsd: status === "passed" ? 0.01 : 0,
    tokensIn: status === "passed" ? 10 : 0,
    tokensOut: status === "passed" ? 2 : 0,
  });

  emit("run-task-1", "deepseek-flash", "running", 1);
  emit("run-task-1", "deepseek-flash", "passed", 1);
  emit("run-task-2", "deepseek-pro", "running", 2);
  emit("run-task-2", "deepseek-pro", "passed", 2);
  emit("run-task-docs", "grok", "running", 2);
  emit("run-task-docs", "grok", "passed", 2);

  const invocations = repo.getInvocations(db, { taskId: task.id });
  assert.equal(invocations.length, 3);
  assert.deepEqual(
    invocations.map((invocation) => invocation.stage).sort(),
    ["author", "author", "docs"],
  );
  assert.deepEqual(
    new Set(invocations.map((invocation) => invocation.runId)),
    new Set(["run-task-1", "run-task-2", "run-task-docs"]),
  );
  assert.ok(invocations.every((invocation) => invocation.outcome === "completed"));
  assert.equal(repo.getCosts(db, proj.id).length, 3);
});

test("B37/F48: an already-built runtime reads live budgets, quotas, pricing, notification policy, and persists effort", () => {
  const db = setup();
  const hub = new WsHub();
  const engine = new EngineRunner(db, hub);
  const proj = project(db, "live-policy");
  const task = seedTask(db, proj.id, "task");
  const taskPushes: string[] = [];
  const notifier: ServerNotifier = {
    approvalRequested() {},
    taskStatus(digest) { taskPushes.push(digest.status); },
    info() {},
    modelTrouble() {},
  };
  engine.setNotifier(notifier);

  // Build first: every assertion below changes Settings after the runtime
  // captured its dependencies, which is the stale-settings regression B37 fixes.
  const deps = buildDeps(engine, proj);
  repo.createCost(db, {
    projectId: proj.id,
    model: "deepseek-flash",
    costUsd: 1,
    tokensIn: 1,
    tokensOut: 1,
    ts: new Date().toISOString(),
  });
  assert.equal(deps.checkBudget!("deepseek-flash"), null);
  assert.equal(deps.checkModelQuota!("deepseek-flash"), null);

  const startedAt = new Date().toISOString();
  repo.createRun(db, {
    id: "prior-run",
    projectId: proj.id,
    taskId: task.id,
    model: "deepseek-flash",
    effort: "low",
    attempt: 1,
    status: "passed",
    startedAt,
    endedAt: startedAt,
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
  });

  let settings = repo.getSettings(db)!;
  settings = repo.upsertSettings(db, {
    ...settings,
    globalMonthlyBudgetUsd: 0.5,
    telegram: { ...settings.telegram!, digest: "off" },
    models: settings.models.map((model) =>
      model.id === "deepseek-flash"
        ? {
            ...model,
            effort: "high",
            quota: { windowHours: 1, maxRuns: 1 },
            costPerMInputUsd: 2,
            costPerMOutputUsd: 0,
          }
        : model,
    ),
  });

  assert.match(deps.checkBudget!("deepseek-flash")!, /Global monthly budget/);
  // B40: the earlier unscoped cost row is a historical non-author model
  // invocation too, so quota usage now truthfully includes both calls.
  assert.match(deps.checkModelQuota!("deepseek-flash")!, /2\/1 calls/);

  deps.events.onRunUpdated({
    id: "priced-run",
    projectId: proj.id,
    taskId: task.id,
    model: "deepseek-flash",
    effort: "high",
    attempt: 2,
    status: "passed",
    startedAt,
    endedAt: startedAt,
    costUsd: 0.01,
    tokensIn: 1_000_000,
    tokensOut: 0,
  });
  assert.equal(repo.getRun(db, "priced-run")!.costUsd, 2);
  assert.equal(repo.getRun(db, "priced-run")!.effort, "high");
  assert.equal(
    repo.getCosts(db, proj.id).find((cost) => cost.invocationId === "priced-run")?.costUsd,
    2,
  );

  deps.events.onTaskUpdated({ ...task, status: "in_progress" });
  assert.deepEqual(taskPushes, []);

  repo.upsertSettings(db, {
    ...settings,
    telegram: { ...settings.telegram!, digest: "all" },
  });
  deps.events.onTaskUpdated({ ...task, status: "in_review" });
  assert.deepEqual(taskPushes, ["in_review"]);
});

test("B36: duplicate rollback clicks share one job and approval merges exactly once", async () => {
  const db = setup();
  const hub = new WsHub();
  const proj = project(db, "rollback-approve");
  const task = seedTask(db, proj.id, "task", {
    status: "done",
    prNumber: 7,
  });
  const fake = fakeRollbackDeps();
  const engine = new EngineRunner(db, hub, {
    rollbackDepsFactory: () => fake.deps,
  });

  const first = await engine.rollback(proj, task);
  const duplicate = await engine.rollback(proj, task);
  assert.equal(duplicate.id, first.id);
  const awaiting = await waitForRollback(
    db,
    first.id,
    (job) => job.status === "awaiting_approval" && !!job.approvalNotificationId,
  );
  assert.equal(fake.calls.prepare, 1);
  assert.equal(fake.calls.push, 1);
  assert.equal(fake.calls.open, 1);

  assert.equal(
    engine.resolveApproval(awaiting.approvalNotificationId!, "approve_merge"),
    true,
  );
  repo.respondToNotification(
    db,
    awaiting.approvalNotificationId!,
    "approve_merge",
  );
  const completed = await waitForRollback(
    db,
    first.id,
    (job) => job.status === "completed",
  );

  assert.equal(fake.calls.merge, 1);
  assert.equal(completed.rollbackPrNumber, 88);
  assert.equal(repo.getTask(db, task.id)!.status, "blocked");
  assert.match(repo.getTask(db, task.id)!.statusReason ?? "", /PR #7 is reverted/);
});

test("B36: a new rollback is rejected unless the source task completed", async () => {
  const db = setup();
  const proj = project(db, "rollback-status");
  const task = seedTask(db, proj.id, "task", {
    status: "in_review",
    prNumber: 8,
  });
  const engine = new EngineRunner(db, new WsHub(), {
    rollbackDepsFactory: () => fakeRollbackDeps().deps,
  });

  await assert.rejects(
    () => engine.rollback(proj, task),
    /not a completed task/,
  );
  assert.equal(repo.getRollbackJobForTask(db, task.id, 8), null);
});

test("B36: rejecting mandatory approval closes the rollback PR without changing the task", async () => {
  const db = setup();
  const proj = project(db, "rollback-reject");
  const task = seedTask(db, proj.id, "task", {
    status: "done",
    prNumber: 9,
  });
  const fake = fakeRollbackDeps();
  const engine = new EngineRunner(db, new WsHub(), {
    rollbackDepsFactory: () => fake.deps,
  });

  const started = await engine.rollback(proj, task);
  const awaiting = await waitForRollback(
    db,
    started.id,
    (job) => job.status === "awaiting_approval" && !!job.approvalNotificationId,
  );
  engine.resolveApproval(awaiting.approvalNotificationId!, "reject");
  repo.respondToNotification(db, awaiting.approvalNotificationId!, "reject");
  await waitForRollback(db, started.id, (job) => job.status === "rejected");

  assert.equal(fake.calls.close, 1);
  assert.equal(fake.calls.merge, 0);
  assert.equal(repo.getTask(db, task.id)!.status, "done");
});

test("B36: restart recovery re-arms approval without preparing a second revert", async () => {
  const db = setup();
  const proj = project(db, "rollback-restart");
  const task = seedTask(db, proj.id, "task", {
    status: "done",
    prNumber: 12,
  });
  const fake = fakeRollbackDeps();
  const firstEngine = new EngineRunner(db, new WsHub(), {
    rollbackDepsFactory: () => fake.deps,
  });
  const started = await firstEngine.rollback(proj, task);
  const firstApproval = await waitForRollback(
    db,
    started.id,
    (job) => job.status === "awaiting_approval" && !!job.approvalNotificationId,
  );
  repo.expireStaleApprovals(db);

  const resumedEngine = new EngineRunner(db, new WsHub(), {
    rollbackDepsFactory: () => fake.deps,
  });
  assert.equal(resumedEngine.resumeRollbacks(), 1);
  const secondApproval = await waitForRollback(
    db,
    started.id,
    (job) =>
      job.status === "awaiting_approval" &&
      !!job.approvalNotificationId &&
      job.approvalNotificationId !== firstApproval.approvalNotificationId,
  );
  assert.equal(fake.calls.prepare, 1, "recovery must reuse the prepared revert");
  assert.equal(fake.calls.open, 1, "recovery must reuse the open rollback PR");

  resumedEngine.resolveApproval(
    secondApproval.approvalNotificationId!,
    "approve_merge",
  );
  repo.respondToNotification(
    db,
    secondApproval.approvalNotificationId!,
    "approve_merge",
  );
  await waitForRollback(db, started.id, (job) => job.status === "completed");
  assert.equal(fake.calls.merge, 1);
});
