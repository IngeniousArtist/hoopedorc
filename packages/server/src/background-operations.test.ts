import assert from "node:assert/strict";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { test } from "node:test";
import type { Project, ServerEvent } from "@orc/types";
import {
  runBackgroundOperation,
  type BackgroundFailureReporter,
} from "./background-operations.js";
import { checkSchedules, type ScheduleTickDependencies } from "./scheduler.js";
import { ShutdownCoordinator } from "./shutdown.js";

const checkedAt = new Date("2026-07-29T12:00:00.000Z");

function scheduledProject(): Project {
  return {
    id: "scheduled-project",
    name: "Nightly maintenance",
    repoUrl: "https://github.com/example/project",
    defaultBranch: "main",
    localPath: "/tmp/scheduled-project",
    status: "created",
    config: {
      schedule: {
        enabled: true,
        mode: "interval",
        intervalHours: 1,
      },
    },
    createdAt: checkedAt.toISOString(),
    updatedAt: checkedAt.toISOString(),
  };
}

interface ScheduleHarness {
  deps: ScheduleTickDependencies;
  pending: Set<Promise<void>>;
  failures: Array<{ label: string; error: unknown }>;
  info: string[];
  broadcasts: ServerEvent[];
}

function scheduleHarness(
  overrides: Partial<ScheduleTickDependencies> = {},
): ScheduleHarness {
  const project = scheduledProject();
  const pending = new Set<Promise<void>>();
  const failures: Array<{ label: string; error: unknown }> = [];
  const info: string[] = [];
  const broadcasts: ServerEvent[] = [];
  const reportFailure: BackgroundFailureReporter = (label, error) => {
    failures.push({ label, error });
  };
  const deps: ScheduleTickDependencies = {
    getProjects: () => [project],
    startProject: async () => ({ ok: true, project }),
    updateProject: (_id, patch) => ({ ...project, ...patch }),
    broadcast: (event) => broadcasts.push(event),
    runBackground: (label, operation) => {
      runBackgroundOperation(pending, label, operation, reportFailure);
    },
    logInfo: (message) => info.push(message),
    now: () => checkedAt,
    ...overrides,
  };
  return { deps, pending, failures, info, broadcasts };
}

async function runTick(harness: ScheduleHarness): Promise<void> {
  checkSchedules(harness.deps);
  await Promise.all([...harness.pending]);
  await waitForImmediate();
}

test("O2: the background owner starts immediately and removes a successful operation", async () => {
  const pending = new Set<Promise<void>>();
  let started = false;
  runBackgroundOperation(
    pending,
    "immediate operation",
    () => {
      started = true;
    },
    () => assert.fail("successful work must not report a failure"),
  );

  assert.equal(started, true);
  await Promise.all([...pending]);
  assert.equal(pending.size, 0);
});

test("O2: a rejected scheduled start is logged once with project and schedule context", async () => {
  const error = new Error("start persistence failed");
  const harness = scheduleHarness({
    startProject: async () => {
      throw error;
    },
  });

  await runTick(harness);

  assert.equal(harness.failures.length, 1);
  assert.equal(harness.failures[0]?.error, error);
  assert.match(
    harness.failures[0]?.label ?? "",
    /scheduled interval start.*Nightly maintenance.*scheduled-project/,
  );
  assert.equal(harness.pending.size, 0);
  assert.deepEqual(harness.broadcasts, []);
});

test("O2: an expected Start refusal stays informational and retryable", async () => {
  let updates = 0;
  const harness = scheduleHarness({
    startProject: async () => ({
      ok: false,
      status: 409,
      error: "manual dispatch is active",
    }),
    updateProject: () => {
      updates++;
      return null;
    },
  });

  await runTick(harness);

  assert.deepEqual(harness.failures, []);
  assert.deepEqual(harness.info, [
    'scheduled start skipped for "Nightly maintenance": manual dispatch is active',
  ]);
  assert.equal(updates, 0);
  assert.deepEqual(harness.broadcasts, []);
});

test("O2: a scheduled timestamp write failure is logged once and never broadcast", async () => {
  const error = new Error("SQLITE_BUSY");
  const harness = scheduleHarness({
    updateProject: () => {
      throw error;
    },
  });

  await runTick(harness);

  assert.deepEqual(harness.failures, [{
    label: 'scheduled interval start for "Nightly maintenance" (scheduled-project)',
    error,
  }]);
  assert.equal(harness.pending.size, 0);
  assert.deepEqual(harness.broadcasts, []);
});

test("O2: a scheduled broadcast failure is logged once after the timestamp write", async () => {
  const error = new Error("socket send failed");
  let updates = 0;
  const harness = scheduleHarness({
    updateProject: (_id, patch) => {
      updates++;
      return { ...scheduledProject(), ...patch };
    },
    broadcast: () => {
      throw error;
    },
  });

  await runTick(harness);

  assert.equal(updates, 1);
  assert.equal(harness.failures.length, 1);
  assert.equal(harness.failures[0]?.error, error);
  assert.equal(
    harness.failures[0]?.label,
    'scheduled interval start for "Nightly maintenance" (scheduled-project)',
  );
  assert.equal(harness.pending.size, 0);
});

test("O2: a successful scheduled start persists its timestamp and broadcasts once", async () => {
  const harness = scheduleHarness();

  await runTick(harness);

  assert.deepEqual(harness.failures, []);
  assert.deepEqual(harness.info, ["scheduled start: Nightly maintenance"]);
  assert.equal(harness.broadcasts.length, 1);
  assert.equal(harness.broadcasts[0]?.type, "project.updated");
  if (harness.broadcasts[0]?.type === "project.updated") {
    assert.equal(harness.broadcasts[0].payload.status, "running");
    assert.equal(
      harness.broadcasts[0].payload.lastScheduledRunAt,
      checkedAt.toISOString(),
    );
  }
});

test("O2: shutdown settlement waits for a registered background operation", async () => {
  const pending = new Set<Promise<void>>();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  runBackgroundOperation(pending, "delayed schedule", () => gate, () => {});

  const order: string[] = [];
  const coordinator = new ShutdownCoordinator({
    stopAccepting: () => {
      order.push("admission");
    },
    stopEngine: async () => {
      order.push("engine");
      return { settled: false };
    },
    stopTelegram: () => {},
    flushLogs: async () => {
      order.push("background-start");
      await Promise.allSettled([...pending]);
      order.push("background-settled");
    },
    recordAudit: () => {},
    closeServer: () => {},
    checkpointDb: () => {},
    closeDb: () => {
      order.push("db");
    },
    log: () => {},
    exit: () => {},
  });
  const shutdown = coordinator.shutdown("SIGTERM", 0);
  await waitForImmediate();
  assert.deepEqual(order, ["admission", "engine", "background-start"]);

  release();
  await shutdown;
  assert.deepEqual(order, [
    "admission",
    "engine",
    "background-start",
    "background-settled",
    "db",
  ]);
  assert.equal(pending.size, 0);
});
