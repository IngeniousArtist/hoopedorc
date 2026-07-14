import assert from "node:assert/strict";
import { test } from "node:test";
import type { Orchestrator, OrchestratorStartOptions, SchedulerDeps } from "@orc/engine";
import type { Project, Task } from "@orc/types";
import { defaultSettings } from "./config.js";
import { initDb } from "./db/index.js";
import * as repo from "./db/repo.js";
import { EngineRunner } from "./engine-runner.js";
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
  return repo.createTask(db, {
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
}

function controlledOrchestrator() {
  let resolveStart!: () => void;
  const startGate = new Promise<void>((resolve) => {
    resolveStart = resolve;
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
      return startGate;
    },
    async pause(_project: Project, options: { drain?: boolean } = {}): Promise<void> {
      state.pauseCalls.push(options);
    },
    stopTask(): boolean {
      return false;
    },
  } as unknown as Orchestrator;
  return { orchestrator, state, resolveStart };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail("timed out waiting for condition");
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
  await waitFor(() => controlled.state.startCalls === 1);
  const second = await engine.dispatchOne(proj, "t2");

  assert.ok(first.dispatchRequestedAt);
  assert.ok(second.dispatchRequestedAt);
  assert.equal(factoryCalls, 1);
  assert.equal(engine.hasActivity(proj.id), true);
  assert.equal(controlled.state.startOptions!.shouldDispatch!(repo.getTask(db, "t1")!), true);
  assert.equal(controlled.state.startOptions!.shouldDispatch!(ordinary), false);

  repo.clearDispatchRequests(db, proj.id);
  controlled.resolveStart();
  await waitFor(() => !engine.hasActivity(proj.id));
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
  await waitFor(() => controlled.state.startCalls === 1);
  await engine.start(proj);

  assert.equal(factoryCalls, 1);
  assert.equal(engine.isRunning(proj.id), true);
  assert.equal(controlled.state.startOptions!.shouldDispatch!(ordinary), true);

  repo.clearDispatchRequests(db, proj.id);
  controlled.resolveStart();
  await waitFor(() => !engine.hasActivity(proj.id));
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
  await waitFor(() => controlled.state.startCalls === 1);
  await engine.pause(proj, { drain: false });

  assert.equal(controlled.state.pauseCalls.length, 1);
  assert.equal(engine.hasActivity(proj.id), true);
  await assert.rejects(engine.start(proj), /stopping/);

  controlled.resolveStart();
  await waitFor(() => !engine.hasActivity(proj.id));
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
  await waitFor(() => controlled.state.startCalls === 1);

  repo.clearDispatchRequests(db, proj.id);
  controlled.resolveStart();
  await waitFor(() => !engine.hasActivity(proj.id));
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
  await waitFor(() => oldControl.state.startCalls === 1);
  const runtimes = (
    engine as unknown as { runtimes: Map<string, { settled: Promise<void> }> }
  ).runtimes;
  const oldRuntime = runtimes.get(proj.id)!;

  // Simulate the historical race's stale cleanup boundary directly: a newer
  // generation owns the key by the time the old Promise reaches finally.
  runtimes.delete(proj.id);
  await engine.start(proj);
  await waitFor(() => newControl.state.startCalls === 1);
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
