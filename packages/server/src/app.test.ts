import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { ServerEvent } from "@orc/types";
import { defaultSettings, ENV } from "./config.js";
import { initDb } from "./db/index.js";
import * as repo from "./db/repo.js";
import { EngineRunner } from "./engine-runner.js";
import {
  buildApp,
  type BuildAppDependencies,
} from "./index.js";
import { SelfUpdater } from "./self-update.js";
import { WsHub } from "./ws-hub.js";
import type WebSocket from "ws";

const PROCESS_EVENTS = [
  "SIGTERM",
  "SIGINT",
  "uncaughtException",
  "unhandledRejection",
] as const;
const pexecFile = promisify(execFile);
const MATCHING_ORIGIN = "https://github.com/example/project";

function listenerCounts(): number[] {
  return PROCESS_EVENTS.map((event) => process.listenerCount(event));
}

function dependencies(
  root: string,
): BuildAppDependencies {
  const db = initDb(":memory:");
  repo.upsertSettings(db, defaultSettings());
  repo.createProject(db, {
    id: "project-1",
    name: "Injected app",
    repoUrl: "https://github.com/example/injected-app",
    defaultBranch: "main",
    localPath: join(root, "project"),
    status: "created",
  });
  const hub = new WsHub();
  return {
    db,
    hub,
    engine: new EngineRunner(db, hub),
    selfUpdater: new SelfUpdater({
      repoRoot: root,
      mock: true,
      statusFile: join(root, "self-update.json"),
    }),
    env: {
      ...ENV,
      host: "127.0.0.1",
      mock: true,
      apiToken: undefined,
      allowUnauthenticated: false,
      dbPath: ":memory:",
      dbBackupDir: join(root, "backups"),
    },
    repoRoot: root,
    version: "test",
    logger: false,
  };
}

async function makeRepo(
  parent: string,
  name: string,
  origin = MATCHING_ORIGIN,
): Promise<string> {
  const path = join(parent, name);
  mkdirSync(path);
  await pexecFile("git", ["init", "--quiet"], {
    cwd: path,
    encoding: "utf8",
  });
  await pexecFile("git", ["remote", "add", "origin", origin], {
    cwd: path,
    encoding: "utf8",
  });
  return path;
}

test("O27: buildApp injects routes without process handlers or startup services", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-build-app-"));
  const before = listenerCounts();

  try {
    for (let iteration = 0; iteration < 3; iteration++) {
      const deps = dependencies(root);
      const staleApproval = repo.createNotification(deps.db, {
        id: `stale-${iteration}`,
        projectId: "project-1",
        severity: "action_required",
        title: "Stale approval",
        message: "must remain untouched until production startup",
        requiresApproval: true,
        options: ["approve", "reject"],
      });

      const app = await buildApp(deps);
      try {
        const response = await app.inject({
          method: "GET",
          url: "/api/projects",
        });
        assert.equal(response.statusCode, 200);
        assert.deepEqual(
          response.json<{ projects: Array<{ id: string }> }>().projects.map(
            (project) => project.id,
          ),
          ["project-1"],
        );
        assert.equal(
          repo.getNotification(deps.db, staleApproval.id)?.respondedWith,
          undefined,
          "buildApp must not run the boot-time stale-approval sweep",
        );
        assert.deepEqual(listenerCounts(), before);
      } finally {
        await app.close();
        deps.db.close();
      }
      assert.deepEqual(listenerCounts(), before);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("O3: planning API issues one revision and replays a successful commit", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-o3-app-"));
  const deps = dependencies(root);
  let gitCalls = 0;
  deps.planningGitPersistence = {
    commitFiles() {
      gitCalls += 1;
      return Promise.resolve();
    },
  };
  const app = await buildApp(deps);
  try {
    const sessionResponse = await app.inject({
      method: "GET",
      url: "/api/projects/project-1/plan/session",
    });
    assert.equal(sessionResponse.statusCode, 200);
    const revisionId = sessionResponse.json<{ revisionId: string }>().revisionId;
    assert.match(revisionId, /^[0-9a-f-]{36}$/i);

    const missingRevision = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/plan/commit",
      payload: { prdMarkdown: "# API receipt", tasks: [] },
    });
    assert.equal(missingRevision.statusCode, 400);

    const payload = {
      revisionId,
      prdMarkdown: "# API receipt",
      tasks: [
        {
          title: "API task",
          description: "Create once",
          difficulty: "medium",
          acceptanceCriteria: ["one row"],
          dependsOn: [],
          scopePaths: ["packages/server/**"],
          assignedModel: "deepseek-flash",
        },
      ],
    };
    const committed = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/plan/commit",
      payload,
    });
    assert.equal(committed.statusCode, 200);
    const first = committed.json<{
      revisionId: string;
      tasks: Array<{ id: string }>;
    }>();
    assert.equal(first.revisionId, revisionId);
    assert.equal(first.tasks.length, 1);

    const replayed = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/plan/commit",
      payload,
    });
    assert.equal(replayed.statusCode, 200);
    assert.deepEqual(replayed.json(), first);
    assert.equal(gitCalls, 1);
    assert.equal(repo.getTasks(deps.db, "project-1").length, 1);

    const staleSave = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/plan/save-draft",
      payload: { ...payload, tasks: payload.tasks },
    });
    assert.equal(staleSave.statusCode, 409);

    const nextSession = await app.inject({
      method: "GET",
      url: "/api/projects/project-1/plan/session",
    });
    const nextRevision = nextSession.json<{ revisionId: string }>().revisionId;
    assert.notEqual(nextRevision, revisionId);
  } finally {
    await app.close();
    deps.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("O36: a project catch-up snapshot reads all runs with one indexed statement", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-o36-ws-catchup-"));
  const deps = dependencies(root);
  const app = await buildApp(deps);
  const taskCount = 250;
  const runsPerTask = 3;
  const baseTime = Date.parse("2026-01-01T00:00:00.000Z");

  class FakeSocket extends EventEmitter {
    readyState = 1;
    readonly sent: string[] = [];

    send(payload: string, callback?: (error?: Error) => void): void {
      this.sent.push(payload);
      callback?.();
    }
  }

  try {
    for (let taskIndex = 0; taskIndex < taskCount; taskIndex++) {
      const task = repo.createTask(deps.db, {
        id: `o36-task-${taskIndex}`,
        projectId: "project-1",
        title: `O36 task ${taskIndex}`,
        description: "",
        difficulty: "easy",
        status: "ready",
        dependsOn: [],
        acceptanceCriteria: [],
        assignedModel: "deepseek-flash",
        scopePaths: [],
        attempts: 0,
        maxAttempts: 3,
      });
      for (let runIndex = 0; runIndex < runsPerTask; runIndex++) {
        const startedAt = new Date(
          baseTime + taskIndex * runsPerTask * 1_000 + runIndex * 1_000,
        ).toISOString();
        repo.createRun(deps.db, {
          id: `o36-run-${taskIndex}-${runIndex}`,
          projectId: "project-1",
          taskId: task.id,
          model: "deepseek-flash",
          attempt: runIndex + 1,
          status: "passed",
          startedAt,
          endedAt: startedAt,
          costUsd: 0,
          tokensIn: 0,
          tokensOut: 0,
        });
      }
    }

    const prepare = deps.db.prepare.bind(deps.db);
    let snapshotRunReads = 0;
    Object.defineProperty(deps.db, "prepare", {
      configurable: true,
      value(source: string) {
        const statement = source.replace(/\s+/g, " ").trim();
        if (
          statement ===
            "SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC" ||
          statement ===
            "SELECT r.* FROM tasks AS t INNER JOIN runs AS r ON r.task_id = t.id WHERE t.project_id = ? ORDER BY r.started_at DESC"
        ) {
          snapshotRunReads++;
        }
        return prepare(source);
      },
    });

    const socket = new FakeSocket();
    deps.hub.add(socket as unknown as WebSocket);
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "subscribe", projectId: "project-1" })),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(
      snapshotRunReads,
      1,
      "one project-scoped indexed run query replaces one query per task",
    );
    const events = socket.sent.map((payload) => JSON.parse(payload) as {
      type: string;
      payload: {
        id?: string;
        projectId?: string;
        totalUsd?: number;
        projects?: Array<{ id: string }>;
      };
    });
    assert.equal(events.length, 3 + taskCount * (1 + runsPerTask));
    assert.equal(events[0]?.type, "projects.snapshot");
    assert.equal(events[0]?.payload.projects?.[0]?.id, "project-1");
    assert.equal(events[1]?.type, "notifications.snapshot");
    assert.equal(events[2]?.type, "cost.snapshot");
    assert.equal(events[2]?.payload.projectId, "project-1");
    assert.equal(events[2]?.payload.totalUsd, 0);
    let cursor = 3;
    for (let taskIndex = 0; taskIndex < taskCount; taskIndex++) {
      assert.equal(events[cursor]?.type, "task.updated");
      assert.equal(events[cursor]?.payload.id, `o36-task-${taskIndex}`);
      cursor++;
      for (let runIndex = runsPerTask - 1; runIndex >= 0; runIndex--) {
        assert.equal(events[cursor]?.type, "run.updated");
        assert.equal(events[cursor]?.payload.id, `o36-run-${taskIndex}-${runIndex}`);
        cursor++;
      }
    }
  } finally {
    await app.close();
    deps.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("O6: reconnect snapshot reports the authoritative project cost before replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-o6-ws-cost-snapshot-"));
  const deps = dependencies(root);
  repo.createCost(deps.db, {
    projectId: "project-1",
    model: "deepseek-flash",
    costUsd: 2.75,
    tokensIn: 10,
    tokensOut: 20,
    tokensCached: 0,
    ts: "2026-08-11T00:00:00.000Z",
  });
  const app = await buildApp(deps);

  class FakeSocket extends EventEmitter {
    readyState = 1;
    readonly sent: string[] = [];

    send(payload: string, callback?: (error?: Error) => void): void {
      this.sent.push(payload);
      callback?.();
    }
  }

  try {
    const socket = new FakeSocket();
    deps.hub.add(socket as unknown as WebSocket);
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "subscribe", projectId: "project-1" })),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const events = socket.sent.map((payload) => JSON.parse(payload) as {
      type: string;
      payload: { projectId?: string; totalUsd?: number };
    });
    assert.equal(events[0]?.type, "projects.snapshot");
    assert.equal(events[1]?.type, "notifications.snapshot");
    assert.equal(events[2]?.type, "cost.snapshot");
    assert.equal(events[2]?.payload.projectId, "project-1");
    assert.equal(events[2]?.payload.totalUsd, 2.75);
  } finally {
    await app.close();
    deps.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("O6: reconnect catch-up restores durable global notifications without a project", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-o6-ws-global-snapshot-"));
  const deps = dependencies(root);
  const notification = repo.createNotification(deps.db, {
    id: "approval-missed-while-offline",
    projectId: "project-1",
    severity: "action_required",
    title: "Approval waiting",
    message: "This must return after reconnect.",
    requiresApproval: true,
    options: ["approve", "reject"],
  });
  const app = await buildApp(deps);

  class FakeSocket extends EventEmitter {
    readyState = 1;
    readonly sent: string[] = [];

    send(payload: string, callback?: (error?: Error) => void): void {
      this.sent.push(payload);
      callback?.();
    }
  }

  try {
    const socket = new FakeSocket();
    deps.hub.add(socket as unknown as WebSocket);
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "subscribe", projectId: "" })),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const events = socket.sent.map(
      (payload) => JSON.parse(payload) as ServerEvent,
    );

    assert.deepEqual(
      events.map((event) => event.type),
      ["projects.snapshot", "notifications.snapshot"],
    );
    const snapshot = events[1];
    assert.equal(snapshot?.type, "notifications.snapshot");
    if (snapshot?.type === "notifications.snapshot") {
      assert.deepEqual(
        snapshot.payload.notifications.map((item) => item.id),
        [notification.id],
      );
    }
  } finally {
    await app.close();
    deps.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("O18: task routes reject malformed arrays and preserve valid request shapes", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-o18-validation-"));
  const deps = dependencies(root);
  const dependency = repo.createTask(deps.db, {
    id: "dependency-task",
    projectId: "project-1",
    title: "Existing dependency",
    description: "Available to the added task",
    difficulty: "easy",
    status: "done",
    dependsOn: [],
    acceptanceCriteria: [],
    assignedModel: "deepseek-flash",
    scopePaths: ["packages/server/**"],
    attempts: 1,
    maxAttempts: 3,
  });
  const app = await buildApp(deps);

  try {
    const invalidRequests = [
      {
        method: "POST" as const,
        url: "/api/projects/project-1/tasks",
        payload: { title: "Bad dependencies", dependsOn: "dependency-task" },
        field: "dependsOn",
      },
      {
        method: "POST" as const,
        url: "/api/projects/project-1/tasks",
        payload: { title: "Bad criteria", acceptanceCriteria: [42] },
        field: "acceptanceCriteria",
      },
      {
        method: "POST" as const,
        url: "/api/projects/project-1/tasks",
        payload: { title: "Bad scope", scopePaths: { path: "src/**" } },
        field: "scopePaths",
      },
      {
        method: "PATCH" as const,
        url: `/api/tasks/${dependency.id}`,
        payload: { acceptanceCriteria: [null] },
        field: "acceptanceCriteria",
      },
      {
        method: "PATCH" as const,
        url: `/api/tasks/${dependency.id}`,
        payload: { scopePaths: "src/**" },
        field: "scopePaths",
      },
    ];

    for (const request of invalidRequests) {
      const response = await app.inject(request);
      assert.equal(response.statusCode, 400, request.field);
      assert.match(
        response.json<{ error: string }>().error,
        new RegExp(request.field),
        `${request.field} error should identify the malformed field`,
      );
    }

    const createdResponse = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/tasks",
      payload: {
        title: "Valid task",
        description: "Every existing request field remains accepted",
        difficulty: "hard",
        role: "backend",
        acceptanceCriteria: ["persists criteria"],
        dependsOn: [dependency.id],
        scopePaths: ["packages/server/**"],
        assignedModel: "deepseek-flash",
      },
    });
    assert.equal(createdResponse.statusCode, 200);
    const created = createdResponse.json<{ task: { id: string } }>().task;

    const updatedResponse = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${created.id}`,
      payload: {
        status: "ready",
        assignedModel: "deepseek-flash",
        acceptanceCriteria: [],
        scopePaths: [],
      },
    });
    assert.equal(updatedResponse.statusCode, 200);
    const persisted = repo.getTask(deps.db, created.id);
    assert.deepEqual(persisted?.acceptanceCriteria, []);
    assert.deepEqual(persisted?.scopePaths, []);
  } finally {
    await app.close();
    deps.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("O36: a settings save checks dangling task models with one indexed statement", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-o36-settings-scan-"));
  const deps = dependencies(root);
  const extraProjects = 5;
  const tasksPerProject = 20;
  // createProject/createTask stamp "now"; the warning order the loop
  // guaranteed (newest project first, oldest task first) needs explicit
  // timestamps, so backdate created_at directly.
  const setProjectCreated = deps.db.prepare(
    "UPDATE projects SET created_at = ? WHERE id = ?",
  );
  const setTaskCreated = deps.db.prepare(
    "UPDATE tasks SET created_at = ? WHERE id = ?",
  );
  setProjectCreated.run("2026-01-01T00:00:00.000Z", "project-1");

  const seedTask = (
    projectId: string,
    index: number,
    status: string,
    assignedModel: string,
  ) => {
    const id = `o36-scan-task-${projectId}-${index}`;
    repo.createTask(deps.db, {
      id,
      projectId,
      title: `Scan task ${index}`,
      description: "",
      difficulty: "easy",
      status: status as import("@orc/types").TaskStatus,
      dependsOn: [],
      acceptanceCriteria: [],
      assignedModel,
      scopePaths: [],
      attempts: 0,
      maxAttempts: 3,
    });
    setTaskCreated.run(
      `2026-01-01T00:${String(10 + index).padStart(2, "0")}:00.000Z`,
      id,
    );
  };
  for (let projectIndex = 2; projectIndex <= 1 + extraProjects; projectIndex++) {
    const projectId = `o36-scan-project-${projectIndex}`;
    repo.createProject(deps.db, {
      id: projectId,
      name: `Scan project ${projectIndex}`,
      repoUrl: "https://github.com/example/o36-scan",
      defaultBranch: "main",
      localPath: join(root, `project-${projectIndex}`),
      status: "created",
    });
    setProjectCreated.run(`2026-01-0${projectIndex}T00:00:00.000Z`, projectId);
    for (let taskIndex = 0; taskIndex < tasksPerProject; taskIndex++) {
      seedTask(projectId, taskIndex, taskIndex % 2 ? "done" : "ready", "deepseek-flash");
    }
  }
  // Dangling live tasks that must warn, and a terminal one that must not.
  seedTask("o36-scan-project-4", tasksPerProject + 1, "ready", "ghost-model");
  seedTask("o36-scan-project-4", tasksPerProject + 2, "in_progress", "ghost-model");
  seedTask("o36-scan-project-4", tasksPerProject + 3, "done", "ghost-model");
  seedTask("project-1", 0, "backlog", "retired-model");

  const app = await buildApp(deps);
  const log = app.log as { warn: (message: unknown) => void };
  const realWarn = log.warn;
  try {
    const current = (
      await app.inject({ method: "GET", url: "/api/settings" })
    ).json<{ settings: unknown }>();

    const prepare = deps.db.prepare.bind(deps.db);
    const taskReadStatements: string[] = [];
    Object.defineProperty(deps.db, "prepare", {
      configurable: true,
      value(source: string) {
        const statement = source.replace(/\s+/g, " ").trim();
        if (statement.includes("FROM tasks") || statement.includes("JOIN tasks")) {
          taskReadStatements.push(statement);
        }
        return prepare(source);
      },
    });
    const warnings: string[] = [];
    log.warn = (message: unknown) => {
      if (
        typeof message === "string" &&
        message.includes("no longer exists in Settings")
      ) {
        warnings.push(message);
      }
    };

    const response = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { settings: current.settings },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(
      taskReadStatements.length,
      1,
      "one indexed join query replaces one tasks query per project",
    );
    assert.ok(taskReadStatements[0]?.includes("CROSS JOIN tasks"));
    assert.deepEqual(warnings, [
      'task o36-scan-task-o36-scan-project-4-21 ("Scan task 21") in project ' +
        'o36-scan-project-4 is assigned to model "ghost-model", which no ' +
        "longer exists in Settings",
      'task o36-scan-task-o36-scan-project-4-22 ("Scan task 22") in project ' +
        'o36-scan-project-4 is assigned to model "ghost-model", which no ' +
        "longer exists in Settings",
      'task o36-scan-task-project-1-0 ("Scan task 0") in project project-1 ' +
        'is assigned to model "retired-model", which no longer exists in ' +
        "Settings",
    ]);
  } finally {
    log.warn = realWarn;
    await app.close();
    deps.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("O16: a late response to a Stop-cancelled approval returns an honest 410", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-cancelled-approval-"));
  const deps = dependencies(root);
  const notification = repo.createNotification(deps.db, {
    projectId: "project-1",
    severity: "action_required",
    title: "Cancelled approval",
    message: "This approval will be stopped",
    requiresApproval: true,
    options: ["approve", "reject"],
  });
  assert.equal(
    repo.cancelPendingApproval(deps.db, notification.id)?.respondedWith,
    repo.CANCELLED_STOP,
  );
  const app = await buildApp(deps);

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/notifications/${notification.id}/respond`,
      payload: { choice: "approve" },
    });
    assert.equal(response.statusCode, 410);
    assert.match(
      response.json<{ error: string }>().error,
      /cancelled by Stop — no choice was applied/,
    );
    assert.equal(
      repo.getNotification(deps.db, notification.id)?.respondedWith,
      repo.CANCELLED_STOP,
      "the late choice must not overwrite the cancellation",
    );
  } finally {
    await app.close();
    deps.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("O14: two response channels race to one durable approval winner", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-o14-approval-race-"));
  const deps = dependencies(root);
  const task = repo.createTask(deps.db, {
    id: "o14-race-task",
    projectId: "project-1",
    title: "Race approval",
    description: "",
    difficulty: "medium",
    status: "in_review",
    dependsOn: [],
    acceptanceCriteria: [],
    assignedModel: "deepseek-flash",
    scopePaths: [],
    attempts: 1,
    maxAttempts: 3,
  });
  const notification = repo.createOrReuseApprovalNotification(deps.db, {
    projectId: "project-1",
    taskId: task.id,
    severity: "action_required",
    title: "Choose once",
    message: "Only one channel may win",
    requiresApproval: true,
    options: ["approve", "reject"],
  }).notification;
  const delivered: string[] = [];
  (
    deps.engine as unknown as {
      pendingApprovals: Map<string, (choice: string) => void>;
    }
  ).pendingApprovals.set(notification.id, (choice) => delivered.push(choice));
  const broadcasts: Array<{ type?: string; payload?: { id?: string } }> = [];
  deps.hub.broadcast = (event) => {
    if (event.type === "notification") broadcasts.push(event);
  };
  const app = await buildApp(deps);

  try {
    const responses = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/notifications/${notification.id}/respond`,
        payload: { choice: "approve" },
      }),
      app.inject({
        method: "POST",
        url: `/api/notifications/${notification.id}/respond`,
        payload: { choice: "reject" },
      }),
    ]);
    assert.deepEqual(
      responses.map((response) => response.statusCode).sort((a, b) => a - b),
      [200, 409],
    );
    assert.equal(delivered.length, 1);
    const saved = repo.getNotification(deps.db, notification.id)!;
    assert.equal(saved.respondedWith, delivered[0]);
    assert.equal(saved.approvalDelivery, "applied");
    assert.equal(
      repo.getAuditLog(deps.db, "project-1").filter(
        (entry) => entry.kind === "approval_resolved",
      ).length,
      1,
    );
    assert.equal(
      broadcasts.filter(
        (event) =>
          event.type === "notification" && event.payload?.id === notification.id,
      ).length,
      1,
    );
  } finally {
    await app.close();
    deps.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("O14: a recoverable owner may durably queue a response before its waiter re-arms", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-o14-queued-approval-"));
  const deps = dependencies(root);
  const task = repo.createTask(deps.db, {
    id: "o14-queued-task",
    projectId: "project-1",
    title: "Queued approval",
    description: "",
    difficulty: "medium",
    status: "in_review",
    dependsOn: [],
    acceptanceCriteria: [],
    assignedModel: "deepseek-flash",
    scopePaths: [],
    attempts: 1,
    maxAttempts: 3,
  });
  const notification = repo.createOrReuseApprovalNotification(deps.db, {
    projectId: "project-1",
    taskId: task.id,
    severity: "action_required",
    title: "Queue safely",
    message: "The recovering engine has not attached yet",
    requiresApproval: true,
    options: ["approve", "reject"],
  }).notification;
  const app = await buildApp(deps);
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/notifications/${notification.id}/respond`,
      payload: { choice: "approve" },
    });
    assert.equal(response.statusCode, 202);
    assert.equal(response.json<{ delivery: string }>().delivery, "queued");
    const queued = repo.getNotification(deps.db, notification.id)!;
    assert.equal(queued.approvalDelivery, "recorded");
    assert.equal(queued.respondedWith, "approve");
    assert.equal(queued.responseAppliedAt, undefined);
  } finally {
    await app.close();
    deps.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("O14: route persistence faults respect the record-before-release boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-o14-approval-fault-"));
  const deps = dependencies(root);
  const task = repo.createTask(deps.db, {
    id: "o14-approval-fault-task",
    projectId: "project-1",
    title: "Approval fault",
    description: "",
    difficulty: "medium",
    status: "in_review",
    dependsOn: [],
    acceptanceCriteria: [],
    assignedModel: "deepseek-flash",
    scopePaths: [],
    attempts: 1,
    maxAttempts: 3,
  });
  const notification = repo.createOrReuseApprovalNotification(deps.db, {
    projectId: "project-1",
    taskId: task.id,
    severity: "action_required",
    title: "Persist first",
    message: "Never release before the durable claim",
    requiresApproval: true,
    options: ["approve", "reject"],
  }).notification;
  const delivered: string[] = [];
  const resolvers = (
    deps.engine as unknown as {
      pendingApprovals: Map<string, (choice: string) => void>;
    }
  ).pendingApprovals;
  resolvers.set(notification.id, (choice) => delivered.push(choice));
  deps.db.exec(`
    CREATE TRIGGER o14_route_approval_audit_fault
    BEFORE INSERT ON audit_log
    WHEN NEW.kind = 'approval_resolved'
    BEGIN
      SELECT RAISE(ABORT, 'route approval audit fault');
    END;
  `);
  const app = await buildApp(deps);

  try {
    const beforeRecord = await app.inject({
      method: "POST",
      url: `/api/notifications/${notification.id}/respond`,
      payload: { choice: "approve" },
    });
    assert.equal(beforeRecord.statusCode, 500);
    assert.deepEqual(delivered, []);
    assert.equal(
      repo.getNotification(deps.db, notification.id)?.approvalDelivery,
      "pending",
    );

    deps.db.exec("DROP TRIGGER o14_route_approval_audit_fault");
    deps.db.exec(`
      CREATE TRIGGER o14_route_applied_marker_fault
      BEFORE UPDATE OF approval_delivery ON notifications
      WHEN NEW.approval_delivery = 'applied'
      BEGIN
        SELECT RAISE(ABORT, 'route applied marker fault');
      END;
    `);
    const afterDelivery = await app.inject({
      method: "POST",
      url: `/api/notifications/${notification.id}/respond`,
      payload: { choice: "approve" },
    });
    assert.equal(afterDelivery.statusCode, 500);
    assert.deepEqual(delivered, ["approve"]);
    const recorded = repo.getNotification(deps.db, notification.id)!;
    assert.equal(recorded.approvalDelivery, "recorded");
    assert.equal(recorded.respondedWith, "approve");
    assert.equal(recorded.responseAppliedAt, undefined);
  } finally {
    await app.close();
    deps.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("O14: Stop broadcasts only its atomically committed task and run", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-o14-stop-"));
  const deps = dependencies(root);
  repo.createTask(deps.db, {
    id: "o14-stop-task",
    projectId: "project-1",
    title: "Stop atomically",
    description: "",
    difficulty: "medium",
    status: "in_progress",
    dependsOn: [],
    acceptanceCriteria: [],
    assignedModel: "deepseek-flash",
    scopePaths: [],
    attempts: 1,
    maxAttempts: 3,
  });
  repo.createRun(deps.db, {
    id: "o14-stop-run",
    projectId: "project-1",
    taskId: "o14-stop-task",
    model: "deepseek-flash",
    attempt: 1,
    status: "running",
    startedAt: "2026-08-11T00:00:00.000Z",
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
  });
  deps.engine.stopTask = () => true;
  const broadcasts: Array<{
    type?: string;
    payload?: { id?: string; status?: string };
  }> = [];
  deps.hub.broadcast = (event) => {
    if (event.type === "task.updated" || event.type === "run.updated") {
      broadcasts.push(event);
    }
  };
  const app = await buildApp(deps);

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/tasks/o14-stop-task/stop",
    });
    assert.equal(response.statusCode, 200);
    assert.equal(repo.getTask(deps.db, "o14-stop-task")?.status, "blocked");
    assert.equal(repo.getRun(deps.db, "o14-stop-run")?.status, "stopped");
    assert.equal(repo.getAuditLog(deps.db, "project-1").at(0)?.kind, "stopped");
    assert.deepEqual(
      broadcasts
        .filter((event) => event.type === "task.updated" || event.type === "run.updated")
        .map((event) => [event.type, event.payload?.id, event.payload?.status]),
      [
        ["run.updated", "o14-stop-run", "stopped"],
        ["task.updated", "o14-stop-task", "blocked"],
      ],
    );
  } finally {
    await app.close();
    deps.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("O14: a failed Stop transaction emits nothing and leaves boot-recoverable intent", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-o14-stop-fault-"));
  const deps = dependencies(root);
  repo.createTask(deps.db, {
    id: "o14-stop-fault-task",
    projectId: "project-1",
    title: "Stop fault",
    description: "",
    difficulty: "medium",
    status: "in_progress",
    dependsOn: [],
    acceptanceCriteria: [],
    assignedModel: "deepseek-flash",
    scopePaths: [],
    attempts: 1,
    maxAttempts: 3,
  });
  repo.createRun(deps.db, {
    id: "o14-stop-fault-run",
    projectId: "project-1",
    taskId: "o14-stop-fault-task",
    model: "deepseek-flash",
    attempt: 1,
    status: "running",
    startedAt: "2026-08-11T00:00:00.000Z",
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
  });
  deps.db.exec(`
    CREATE TRIGGER o14_route_stop_fault
    BEFORE INSERT ON audit_log
    WHEN NEW.kind = 'stopped'
    BEGIN
      SELECT RAISE(ABORT, 'route Stop fault');
    END;
  `);
  deps.engine.stopTask = () => true;
  const broadcasts: unknown[] = [];
  deps.hub.broadcast = (event) => broadcasts.push(event);
  const app = await buildApp(deps);

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/tasks/o14-stop-fault-task/stop",
    });
    assert.equal(response.statusCode, 500);
    assert.equal(repo.getTask(deps.db, "o14-stop-fault-task")?.status, "in_progress");
    assert.equal(repo.getRun(deps.db, "o14-stop-fault-run")?.status, "running");
    assert.equal(repo.claimTaskStop(deps.db, "o14-stop-fault-task").pending, true);
    assert.deepEqual(broadcasts, []);
  } finally {
    await app.close();
    deps.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("O27: injected auth is optional on loopback and enforced when configured", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-auth-routes-"));
  try {
    const openDeps = dependencies(root);
    const openApp = await buildApp(openDeps);
    try {
      assert.equal(
        (await openApp.inject({ method: "GET", url: "/api/projects" }))
          .statusCode,
        200,
      );
    } finally {
      await openApp.close();
      openDeps.db.close();
    }

    const protectedDeps = dependencies(root);
    protectedDeps.env = {
      ...protectedDeps.env,
      apiToken: "route-secret",
    };
    const protectedApp = await buildApp(protectedDeps);
    try {
      assert.equal(
        (await protectedApp.inject({ method: "GET", url: "/api/projects" }))
          .statusCode,
        401,
      );
      assert.equal(
        (
          await protectedApp.inject({
            method: "GET",
            url: "/api/projects",
            headers: { authorization: "Bearer wrong" },
          })
        ).statusCode,
        401,
      );
      assert.equal(
        (
          await protectedApp.inject({
            method: "GET",
            url: "/api/projects",
            headers: { authorization: "Bearer route-secret" },
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (await protectedApp.inject({ method: "GET", url: "/api/health" }))
          .statusCode,
        200,
        "health remains available without a bearer token",
      );
    } finally {
      await protectedApp.close();
      protectedDeps.db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("O27: non-loopback app construction fails closed without explicit auth", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-auth-binding-"));
  try {
    const refused = dependencies(root);
    refused.env = {
      ...refused.env,
      host: "0.0.0.0",
      apiToken: undefined,
      allowUnauthenticated: false,
    };
    await assert.rejects(() => buildApp(refused), /API_TOKEN/);
    refused.db.close();

    const authenticated = dependencies(root);
    authenticated.env = {
      ...authenticated.env,
      host: "0.0.0.0",
      apiToken: "secret",
      allowUnauthenticated: false,
    };
    const app = await buildApp(authenticated);
    await app.close();
    authenticated.db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("O27: project creation route enforces config, Git, and filesystem guards", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-create-routes-"));
  const deps = dependencies(root);
  const app = await buildApp(deps);
  try {
    const request = (payload: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: "/api/projects",
        payload,
      });

    assert.equal((await request({ repoUrl: MATCHING_ORIGIN })).statusCode, 400);
    assert.equal(
      (
        await request({
          name: "Bad URL",
          repoUrl: "--upload-pack=payload",
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await request({
          name: "Bad branch",
          repoUrl: MATCHING_ORIGIN,
          defaultBranch: "-main",
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await request({
          name: "Bad config",
          repoUrl: MATCHING_ORIGIN,
          config: [],
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await request({
          name: "Unsafe path",
          repoUrl: MATCHING_ORIGIN,
          localPath: deps.env.reposDir,
        })
      ).statusCode,
      400,
    );

    const unmanaged = join(root, "unmanaged");
    mkdirSync(unmanaged);
    writeFileSync(join(unmanaged, "operator.txt"), "keep");
    assert.equal(
      (
        await request({
          name: "Occupied path",
          repoUrl: MATCHING_ORIGIN,
          localPath: unmanaged,
        })
      ).statusCode,
      400,
    );

    const created = await request({
      name: "Valid project",
      repoUrl: MATCHING_ORIGIN,
      localPath: join(root, "new-project"),
      config: { maxAttempts: 4 },
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(
      created.json<{ project: { config?: { maxAttempts?: number } } }>()
        .project.config?.maxAttempts,
      4,
    );
  } finally {
    await app.close();
    deps.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("O27: project deletion removes only clean managed clones", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-delete-routes-"));
  const deps = dependencies(root);
  const cases: Array<{
    id: string;
    localPath: string;
    shouldDeleteFiles: boolean;
  }> = [];

  try {
    const clean = await makeRepo(root, "clean");
    cases.push({ id: "delete-clean", localPath: clean, shouldDeleteFiles: true });

    const dirty = await makeRepo(root, "dirty");
    writeFileSync(join(dirty, "operator.txt"), "keep");
    cases.push({ id: "keep-dirty", localPath: dirty, shouldDeleteFiles: false });

    const wrong = await makeRepo(
      root,
      "wrong",
      "https://github.com/example/other",
    );
    cases.push({ id: "keep-wrong", localPath: wrong, shouldDeleteFiles: false });

    const unmanaged = join(root, "unmanaged");
    mkdirSync(unmanaged);
    writeFileSync(join(unmanaged, "operator.txt"), "keep");
    cases.push({
      id: "keep-unmanaged",
      localPath: unmanaged,
      shouldDeleteFiles: false,
    });

    const symlinkTarget = await makeRepo(root, "symlink-target");
    const symlink = join(root, "symlink");
    symlinkSync(symlinkTarget, symlink, "dir");
    cases.push({
      id: "keep-symlink",
      localPath: symlink,
      shouldDeleteFiles: false,
    });

    const parentRepo = await makeRepo(root, "parent");
    const nested = await makeRepo(parentRepo, "nested");
    cases.push({
      id: "keep-nested",
      localPath: nested,
      shouldDeleteFiles: false,
    });

    const primaryWithDirtyWorktree = await makeRepo(root, "with-worktree");
    const dirtyWorktree = await makeRepo(root, "with-worktree-wt-task");
    writeFileSync(join(dirtyWorktree, "operator.txt"), "keep");
    cases.push({
      id: "keep-dirty-worktree",
      localPath: primaryWithDirtyWorktree,
      shouldDeleteFiles: false,
    });

    for (const fixture of cases) {
      repo.createProject(deps.db, {
        id: fixture.id,
        name: fixture.id,
        repoUrl: MATCHING_ORIGIN,
        defaultBranch: "main",
        localPath: fixture.localPath,
        status: "created",
      });
    }

    const app = await buildApp(deps);
    try {
      assert.equal(
        (
          await app.inject({
            method: "DELETE",
            url: "/api/projects/missing",
          })
        ).statusCode,
        404,
      );
      for (const fixture of cases) {
        const response = await app.inject({
          method: "DELETE",
          url: `/api/projects/${fixture.id}`,
        });
        assert.equal(response.statusCode, 204, fixture.id);
        assert.equal(repo.getProject(deps.db, fixture.id), null, fixture.id);
        assert.equal(
          existsSync(fixture.localPath),
          !fixture.shouldDeleteFiles,
          fixture.id,
        );
      }
      assert.equal(
        existsSync(symlinkTarget),
        true,
        "a refused symlink must not delete its target",
      );
      assert.equal(
        existsSync(dirtyWorktree),
        true,
        "one dirty matching worktree must preserve the whole disk cleanup set",
      );
    } finally {
      await app.close();
    }
  } finally {
    deps.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("O27: project deletion refuses an active runtime before disk or DB mutation", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-active-delete-"));
  const deps = dependencies(root);
  deps.engine = {
    hasActivity: () => true,
  } as unknown as EngineRunner;
  const app = await buildApp(deps);
  try {
    const response = await app.inject({
      method: "DELETE",
      url: "/api/projects/project-1",
    });
    assert.equal(response.statusCode, 409);
    assert.notEqual(repo.getProject(deps.db, "project-1"), null);
  } finally {
    await app.close();
    deps.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("O27: the real main entrypoint listens and shuts down cleanly", async () => {
  const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
  const child = spawn(
    process.execPath,
    ["--import", "tsx", entry],
    {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      env: {
        ...process.env,
        ALLOW_UNAUTHENTICATED: "",
        API_TOKEN: "",
        HOST: "127.0.0.1",
        MOCK: "1",
        PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const closed = once(child, "close") as Promise<
    [number | null, NodeJS.Signals | null]
  >;
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  for (
    let attempt = 0;
    attempt < 300 && !stdout.includes("hoopedorc server up");
    attempt++
  ) {
    await new Promise<void>((resolvePromise) =>
      setTimeout(resolvePromise, 10),
    );
    if (child.exitCode !== null) break;
  }
  assert.match(stdout, /hoopedorc server up/, stderr);
  child.kill("SIGTERM");
  const [code, signal] = await closed;
  assert.equal(signal, null, stderr);
  assert.equal(code, 0, stderr);
  assert.match(stdout, /shutdown complete: SIGTERM \(exit 0/);
});
