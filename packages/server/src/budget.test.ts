import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Settings } from "@orc/types";
import { defaultSettings } from "./config.js";
import { checkModelQuota } from "./budget.js";
import { initDb } from "./db/index.js";
import * as repo from "./db/repo.js";

const HOUR_MS = 60 * 60 * 1000;

/** F16: real in-memory SQLite via the actual repo.ts functions, not mocks. */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "hoopedorc-budget-test-"));
  const db = initDb(":memory:");
  repo.createProject(db, {
    id: "proj-1",
    name: "P",
    repoUrl: "https://github.com/x/y",
    defaultBranch: "main",
    localPath: dir,
    status: "running",
  });
  // runs.task_id is a real FK (schema.sql: `REFERENCES tasks(id)`) —
  // needs a real task row before any run can be inserted.
  repo.createTask(db, {
    id: "task-1",
    projectId: "proj-1",
    title: "T",
    description: "",
    difficulty: "medium",
    status: "backlog",
    dependsOn: [],
    acceptanceCriteria: [],
    assignedModel: "claude" as never,
    scopePaths: [],
    attempts: 0,
    maxAttempts: 3,
  });
  return { db, dir };
}

function settingsWithQuota(
  model: string,
  quota: Settings["models"][number]["quota"],
): Settings {
  const base = defaultSettings();
  return {
    ...base,
    models: base.models.map((m) => (m.id === model ? { ...m, quota } : m)),
  };
}

function seedRun(db: ReturnType<typeof initDb>, model: string, startedAt: string) {
  repo.createRun(db, {
    projectId: "proj-1",
    taskId: "task-1",
    model: model as never,
    attempt: 1,
    status: "passed",
    startedAt,
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
  });
}

function seedCost(db: ReturnType<typeof initDb>, model: string, costUsd: number, ts: string) {
  repo.createCost(db, {
    projectId: "proj-1",
    model: model as never,
    costUsd,
    tokensIn: 0,
    tokensOut: 0,
    ts,
  });
}

test("checkModelQuota: no quota configured never blocks", () => {
  const { db, dir } = setup();
  try {
    const settings = defaultSettings();
    const model = settings.models[0]!.id;
    assert.equal(checkModelQuota(db, model, settings), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkModelQuota: runs-limit reached within the window blocks", () => {
  const { db, dir } = setup();
  try {
    const model = defaultSettings().models[0]!.id;
    const settings = settingsWithQuota(model, { windowHours: 24, maxRuns: 3 });
    const now = Date.now();
    // 3 runs inside the 24h window — at the limit.
    seedRun(db, model, new Date(now - 1 * HOUR_MS).toISOString());
    seedRun(db, model, new Date(now - 2 * HOUR_MS).toISOString());
    seedRun(db, model, new Date(now - 3 * HOUR_MS).toISOString());
    const reason = checkModelQuota(db, model, settings);
    assert.notEqual(reason, null);
    assert.match(reason!, /quota reached/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkModelQuota: runs-limit under the cap does not block", () => {
  const { db, dir } = setup();
  try {
    const model = defaultSettings().models[0]!.id;
    const settings = settingsWithQuota(model, { windowHours: 24, maxRuns: 3 });
    const now = Date.now();
    seedRun(db, model, new Date(now - 1 * HOUR_MS).toISOString());
    seedRun(db, model, new Date(now - 2 * HOUR_MS).toISOString());
    assert.equal(checkModelQuota(db, model, settings), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkModelQuota: runs outside the window are excluded from the count", () => {
  const { db, dir } = setup();
  try {
    const model = defaultSettings().models[0]!.id;
    const settings = settingsWithQuota(model, { windowHours: 24, maxRuns: 2 });
    const now = Date.now();
    // 2 runs are well outside the 24h window; only 1 is inside it.
    seedRun(db, model, new Date(now - 48 * HOUR_MS).toISOString());
    seedRun(db, model, new Date(now - 30 * HOUR_MS).toISOString());
    seedRun(db, model, new Date(now - 1 * HOUR_MS).toISOString());
    assert.equal(checkModelQuota(db, model, settings), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkModelQuota: cost-limit under the cap does not block", () => {
  const { db, dir } = setup();
  try {
    const model = defaultSettings().models[0]!.id;
    const settings = settingsWithQuota(model, { windowHours: 24, maxCostUsd: 10 });
    const now = Date.now();
    seedCost(db, model, 4, new Date(now - 1 * HOUR_MS).toISOString());
    assert.equal(checkModelQuota(db, model, settings), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkModelQuota: cost-limit reached within the window blocks", () => {
  const { db, dir } = setup();
  try {
    const model = defaultSettings().models[0]!.id;
    const settings = settingsWithQuota(model, { windowHours: 24, maxCostUsd: 10 });
    const now = Date.now();
    seedCost(db, model, 6, new Date(now - 1 * HOUR_MS).toISOString());
    seedCost(db, model, 5, new Date(now - 2 * HOUR_MS).toISOString());
    const reason = checkModelQuota(db, model, settings);
    assert.notEqual(reason, null);
    assert.match(reason!, /quota reached/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkModelQuota: costs outside the window are excluded from the sum", () => {
  const { db, dir } = setup();
  try {
    const model = defaultSettings().models[0]!.id;
    const settings = settingsWithQuota(model, { windowHours: 24, maxCostUsd: 10 });
    const now = Date.now();
    seedCost(db, model, 100, new Date(now - 48 * HOUR_MS).toISOString()); // outside window
    seedCost(db, model, 2, new Date(now - 1 * HOUR_MS).toISOString()); // inside window
    assert.equal(checkModelQuota(db, model, settings), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
