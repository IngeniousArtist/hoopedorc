import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DraftTask, PlanChatMessage } from "@orc/types";
import { initDb } from "./db/index.js";
import * as repo from "./db/repo.js";
import { recordPlanChatTurn, recordPlanCommit, recordPlanDeconstruct } from "./plan-sessions.js";

function setup() {
  const scratch = mkdtempSync(join(tmpdir(), "hoopedorc-plansessions-test-"));
  const db = initDb(":memory:");
  const project = repo.createProject(db, {
    id: "proj-1",
    name: "Test Project",
    repoUrl: "https://github.com/x/y",
    defaultBranch: "main",
    localPath: scratch,
    status: "planning",
  });
  return { db, project, scratch };
}

function sessionFiles(scratch: string): string[] {
  const dir = join(scratch, "context", "plan-sessions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir);
}

function readSession(scratch: string, filename: string): string {
  return readFileSync(join(scratch, "context", "plan-sessions", filename), "utf8");
}

test("recordPlanChatTurn: mints a session file on the first turn containing both turns", () => {
  const { db, project, scratch } = setup();
  try {
    const warnings: string[] = [];
    const messages: PlanChatMessage[] = [
      { role: "user", content: "Build me a todo app" },
      { role: "assistant", content: "Sure, let's start with the data model." },
    ];
    recordPlanChatTurn(db, project, false, messages, "claude-sonnet", (m) => warnings.push(m));

    const files = sessionFiles(scratch);
    assert.equal(files.length, 1);
    const content = readSession(scratch, files[0]!);
    assert.match(content, /Build me a todo app/);
    assert.match(content, /Sure, let's start with the data model\./);
    assert.match(content, /## User/);
    assert.match(content, /## Assistant/);
    assert.equal(warnings.length, 0);

    const session = repo.getPlanningSession(db, project.id);
    assert.equal(session.sessionFile, files[0]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("recordPlanChatTurn: a second turn rewrites the same file, not a new one", () => {
  const { db, project, scratch } = setup();
  try {
    const warn = () => {};
    recordPlanChatTurn(db, project, false, [{ role: "user", content: "turn 1" }], undefined, warn);
    const firstFiles = sessionFiles(scratch);
    assert.equal(firstFiles.length, 1);

    recordPlanChatTurn(
      db,
      project,
      false,
      [
        { role: "user", content: "turn 1" },
        { role: "assistant", content: "reply 1" },
        { role: "user", content: "turn 2" },
      ],
      undefined,
      warn,
    );
    const secondFiles = sessionFiles(scratch);
    assert.deepEqual(secondFiles, firstFiles);
    assert.match(readSession(scratch, secondFiles[0]!), /turn 2/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("recordPlanDeconstruct: appends a Deconstructed plan section to the same file", () => {
  const { db, project, scratch } = setup();
  try {
    const warn = () => {};
    const messages: PlanChatMessage[] = [{ role: "user", content: "goal" }];
    recordPlanChatTurn(db, project, false, messages, undefined, warn);
    const files = sessionFiles(scratch);

    const tasks: DraftTask[] = [
      {
        title: "Set up scaffold",
        description: "desc",
        difficulty: "easy",
        acceptanceCriteria: [],
        dependsOn: [],
        scopePaths: ["**/*"],
        assignedModel: "claude",
      },
    ];
    recordPlanDeconstruct(db, project, false, messages, "# PRD\n\nBuild a thing.", tasks, undefined, warn);

    const afterFiles = sessionFiles(scratch);
    assert.deepEqual(afterFiles, files);
    const content = readSession(scratch, afterFiles[0]!);
    assert.match(content, /## Deconstructed plan/);
    assert.match(content, /Build a thing\./);
    assert.match(content, /Set up scaffold/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("recordPlanCommit: writes the Committed marker; clearing sessionFile makes the next turn mint a new file", () => {
  const { db, project, scratch } = setup();
  try {
    const warn = () => {};
    recordPlanChatTurn(db, project, false, [{ role: "user", content: "goal" }], undefined, warn);
    const firstFile = sessionFiles(scratch)[0]!;

    recordPlanCommit(db, project, false, 3, undefined, warn);
    const content = readSession(scratch, firstFile);
    assert.match(content, /## Committed/);
    assert.match(content, /Committed 3 task\(s\)/);

    // The real /plan/commit route clears sessionFile itself (in the same
    // savePlanningSession call that clears messages/prd/draftTasks) —
    // recordPlanCommit deliberately doesn't do that part; simulate it here.
    repo.savePlanningSession(db, project.id, { sessionFile: null });

    recordPlanChatTurn(db, project, false, [{ role: "user", content: "new session" }], undefined, warn);
    const files = sessionFiles(scratch);
    assert.equal(files.length, 2);
    assert.ok(files.includes(firstFile));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("recordPlanCommit: a session with no prior chat turn is a no-op", () => {
  const { db, project, scratch } = setup();
  try {
    const warnings: string[] = [];
    recordPlanCommit(db, project, false, 1, undefined, (m) => warnings.push(m));
    assert.deepEqual(sessionFiles(scratch), []);
    assert.equal(warnings.length, 0);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a read-only context/ directory doesn't throw — the failure is caught and warned", { skip: process.getuid?.() === 0 }, () => {
  const { db, project, scratch } = setup();
  try {
    mkdirSync(join(scratch, "context"), { recursive: true });
    chmodSync(join(scratch, "context"), 0o444);
    const warnings: string[] = [];
    assert.doesNotThrow(() => {
      recordPlanChatTurn(db, project, false, [{ role: "user", content: "x" }], undefined, (m) =>
        warnings.push(m),
      );
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /plan session file write failed/);
  } finally {
    chmodSync(join(scratch, "context"), 0o755);
    rmSync(scratch, { recursive: true, force: true });
  }
});
