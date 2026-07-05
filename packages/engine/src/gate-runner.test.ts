import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Project, Task } from "@orc/types";
import { GateRunnerImpl } from "./gate-runner.js";
import type { WorktreeManager } from "./index.js";

const worktrees: WorktreeManager = {
  async create(_p, t) {
    return { branch: `orc/${t.id}`, path: "" };
  },
  async remove() {},
  async changedFiles() {
    return [];
  },
  async changedFilesInScope() {
    return true;
  },
};

function project(config?: Project["config"]): Project {
  return {
    id: "p1",
    name: "p",
    repoUrl: "",
    defaultBranch: "main",
    localPath: ".",
    status: "running",
    createdAt: "",
    updatedAt: "",
    config,
  };
}

function task(worktreePath: string): Task {
  return {
    id: "t1",
    projectId: "p1",
    title: "t",
    description: "",
    difficulty: "medium",
    status: "in_review",
    dependsOn: [],
    acceptanceCriteria: [],
    assignedModel: "deepseek-flash",
    scopePaths: ["**/*"],
    worktreePath,
    attempts: 0,
    maxAttempts: 2,
    createdAt: "",
    updatedAt: "",
  };
}

function tmpRepo(scripts: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "hoopedorc-gate-test-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0", scripts }));
  return dir;
}

test("a gate script name override (F9) runs the configured npm script instead of the default", async () => {
  const dir = tmpRepo({ "tc:strict": 'node -e "process.exit(0)"' });
  const runner = new GateRunnerImpl(worktrees);
  const result = await runner.run(project({ gates: { typecheckScript: "tc:strict" } }), task(dir));
  assert.equal(result.typecheck, true);
  assert.match(result.details.typecheck ?? "", /tc:strict/, "ran the overridden script, not the default \"typecheck\"");
});

test("a gate set to false (F9) is skipped and doesn't count as vacuous by itself", async () => {
  const dir = tmpRepo({});
  const runner = new GateRunnerImpl(worktrees);
  const result = await runner.run(project({ gates: { lintScript: false } }), task(dir));
  assert.equal(result.lint, true);
  assert.match(result.details.lint ?? "", /disabled/);
  // Still vacuous overall since nothing else ran either — disabling one gate
  // doesn't fabricate a "something ran" signal.
  assert.equal(result.vacuous, true);
});

test("testCommand (F9) runs via execFile directly and its failure fails the test gate", async () => {
  const dir = tmpRepo({});
  const runner = new GateRunnerImpl(worktrees);
  const result = await runner.run(
    project({ gates: { testCommand: "node -e process.exit(1)" } }),
    task(dir),
  );
  assert.equal(result.tests, false, "the configured test command exited non-zero");
});

test("testCommand (F9) takes priority over a testScript override when both are set", async () => {
  const dir = tmpRepo({ "unit-tests": "node -e process.exit(1)" });
  const runner = new GateRunnerImpl(worktrees);
  const result = await runner.run(
    project({ gates: { testScript: "unit-tests", testCommand: "node -e process.exit(0)" } }),
    task(dir),
  );
  assert.equal(result.tests, true, "testCommand should win over testScript");
});
