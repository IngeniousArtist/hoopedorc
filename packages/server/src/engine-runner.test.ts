import assert from "node:assert/strict";
import { test } from "node:test";
import type { Orchestrator, SchedulerDeps } from "@orc/engine";
import type { Project } from "@orc/types";
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
