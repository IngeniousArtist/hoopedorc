// One-off seed for the real end-to-end test run.
// Creates a single project pointed at the throwaway repo + ONE tiny "easy" task,
// bypassing the (money-costing, non-deterministic) Claude planner. Run with:
//   DB_PATH=/abs/e2e.db npx tsx packages/server/scripts/seed-e2e.ts
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { initDb } from "../src/db/index";
import * as repo from "../src/db/repo";
import { ENV, defaultSettings } from "../src/config";

const REPO_URL = "https://github.com/IngeniousArtist/hoopedorc-test-run";

const db = initDb();

// Settings (with the $2 global cap left off; the project budget is the rail here).
if (!repo.getSettings(db)) repo.upsertSettings(db, defaultSettings());

const projectId = randomUUID();
// Out-of-tree clone/worktree location (see ENV.reposDir) — must NOT be nested
// inside the orchestrator repo, or agents resolve the wrong project root.
const localPath = join(ENV.reposDir, projectId);

repo.createProject(db, {
  id: projectId,
  name: "hoopedorc-e2e",
  repoUrl: REPO_URL,
  defaultBranch: "main",
  localPath,
  status: "planned",
  budgetUsd: 2,
});

const taskId = randomUUID();
repo.createTask(db, {
  id: taskId,
  projectId,
  title: "Add isEven utility with test",
  description: [
    "Add a tiny pure utility function and a unit test for it.",
    "",
    "Create exactly two files, BOTH under the src/ directory, and nothing else:",
    "1. src/isEven.js — CommonJS. Export a single pure function isEven(n) that",
    "   returns true when n is an even integer and false otherwise.",
    "   Use: module.exports = { isEven };",
    "2. src/isEven.test.js — CommonJS. Use Node's built-in test runner:",
    "   const { test } = require('node:test');",
    "   const assert = require('node:assert');",
    "   const { isEven } = require('./isEven');",
    "   Add tests covering an even number, an odd number, and zero.",
    "",
    "Do NOT add, edit, or delete any files outside src/. Do NOT modify package.json,",
    "README.md, or add dependencies. `npm test` runs `node --test` and must pass.",
  ].join("\n"),
  difficulty: "easy",
  status: "ready",
  dependsOn: [],
  acceptanceCriteria: [
    "src/isEven.js exports a pure isEven(n) returning true only for even integers",
    "src/isEven.test.js uses node:test + node:assert and passes under `npm test`",
    "Only files under src/ are created; package.json and README.md are untouched",
  ],
  assignedModel: "deepseek-flash",
  scopePaths: ["src/**"],
  attempts: 0,
  maxAttempts: 2,
});

console.log(JSON.stringify({ projectId, taskId, localPath, repoUrl: REPO_URL }));
