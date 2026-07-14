import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { Project, Task } from "@orc/types";
import { GateRunnerImpl, type SandboxDeps } from "./gate-runner.js";
import type { WorktreeManager } from "./index.js";
import { DEFAULT_GATE_IMAGE } from "./sandbox.js";
import { WorktreeManagerImpl } from "./worktree-manager.js";

const pexecFile = promisify(execFile);

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
  async revertOutOfScope() {
    return [];
  },
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
  async primaryDirtyFiles() {
    return [];
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

async function tmpGitRepo(gateProgram: string): Promise<string> {
  const dir = tmpRepo({ typecheck: "node gate-write.cjs" });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "app.ts"), "export const clean = true;\n");
  writeFileSync(join(dir, "gate-write.cjs"), gateProgram);
  await pexecFile("git", ["init", "-q"], { cwd: dir });
  await pexecFile("git", ["add", "-A"], { cwd: dir });
  await pexecFile(
    "git",
    ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", "init"],
    { cwd: dir },
  );
  return dir;
}

test("a gate script name override (F9) runs the configured npm script instead of the default", async () => {
  const dir = tmpRepo({ "tc:strict": 'node -e "process.exit(0)"' });
  const runner = new GateRunnerImpl(worktrees, { sandboxGates: "off" });
  const result = await runner.run(project({ gates: { typecheckScript: "tc:strict" } }), task(dir));
  assert.equal(result.typecheck, true);
  assert.match(result.details.typecheck ?? "", /tc:strict/, "ran the overridden script, not the default \"typecheck\"");
});

test("a gate set to false (F9) is skipped and doesn't count as vacuous by itself", async () => {
  const dir = tmpRepo({});
  const runner = new GateRunnerImpl(worktrees, { sandboxGates: "off" });
  const result = await runner.run(project({ gates: { lintScript: false } }), task(dir));
  assert.equal(result.lint, true);
  assert.match(result.details.lint ?? "", /disabled/);
  // Still vacuous overall since nothing else ran either — disabling one gate
  // doesn't fabricate a "something ran" signal.
  assert.equal(result.vacuous, true);
});

test("an aborted gate kills its command and rejects promptly", async () => {
  const dir = tmpRepo({ typecheck: 'node -e "setInterval(() => {}, 1000)"' });
  const runner = new GateRunnerImpl(worktrees, { sandboxGates: "off" });
  const controller = new AbortController();
  const started = Date.now();
  const run = runner.run(project(), task(dir), controller.signal);
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(run, { name: "AbortError" });
  assert.ok(Date.now() - started < 1_000);
});

test("a declared script fails closed when npm cannot be spawned", async () => {
  const dir = tmpRepo({ typecheck: "missing-tool" });
  const runner = new GateRunnerImpl(worktrees, { sandboxGates: "off" });
  const previousPath = process.env.PATH;
  process.env.PATH = "";
  try {
    const result = await runner.run(project(), task(dir));
    assert.equal(result.typecheck, false);
    assert.match(result.details.typecheck ?? "", /ENOENT|spawn npm/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("a passing gate that edits tracked source fails, names it, and restores HEAD", async () => {
  const dir = await tmpGitRepo(
    'require("node:fs").writeFileSync("src/app.ts", "export const clean = false;\\n");',
  );
  const runner = new GateRunnerImpl(
    new WorktreeManagerImpl({ sandboxGates: "off" }),
    { sandboxGates: "off" },
  );
  const result = await runner.run(project(), task(dir));
  assert.equal(result.typecheck, false);
  assert.match(result.details.typecheck ?? "", /modified the worktree: src\/app\.ts/);
  assert.equal(readFileSync(join(dir, "src", "app.ts"), "utf8"), "export const clean = true;\n");
  const { stdout } = await pexecFile("git", ["status", "--porcelain"], { cwd: dir });
  assert.equal(stdout, "");
});

test("a gate-created docs file fails even when the task scope allows docs", async () => {
  const dir = await tmpGitRepo(
    'require("node:fs").mkdirSync("docs", { recursive: true });' +
      'require("node:fs").writeFileSync("docs/generated.md", "gate output\\n");',
  );
  const runner = new GateRunnerImpl(
    new WorktreeManagerImpl({ sandboxGates: "off" }),
    { sandboxGates: "off" },
  );
  const scopedTask = task(dir);
  scopedTask.scopePaths = ["docs/**"];
  const result = await runner.run(project(), scopedTask);
  assert.equal(result.typecheck, false);
  assert.match(result.details.typecheck ?? "", /docs\/generated\.md/);
  assert.equal(existsSync(join(dir, "docs", "generated.md")), false);
});

test("testCommand (F9) runs via execFile directly and its failure fails the test gate", async () => {
  const dir = tmpRepo({});
  const runner = new GateRunnerImpl(worktrees, { sandboxGates: "off" });
  const result = await runner.run(
    project({ gates: { testCommand: "node -e process.exit(1)" } }),
    task(dir),
  );
  assert.equal(result.tests, false, "the configured test command exited non-zero");
});

test("testCommand (F9) takes priority over a testScript override when both are set", async () => {
  const dir = tmpRepo({ "unit-tests": "node -e process.exit(1)" });
  const runner = new GateRunnerImpl(worktrees, { sandboxGates: "off" });
  const result = await runner.run(
    project({ gates: { testScript: "unit-tests", testCommand: "node -e process.exit(0)" } }),
    task(dir),
  );
  assert.equal(result.tests, true, "testCommand should win over testScript");
});

test("B17: a configured gate script override naming a missing script fails the gate loudly", async () => {
  const dir = tmpRepo({});
  const runner = new GateRunnerImpl(worktrees, { sandboxGates: "off" });
  const result = await runner.run(project({ gates: { typecheckScript: "tc:strict" } }), task(dir));
  assert.equal(result.typecheck, false, "an explicitly configured override that doesn't exist must fail, not silently pass");
  assert.match(result.details.typecheck ?? "", /not found/);
});

test("B17: a configured testScript override naming a missing script fails the tests gate loudly", async () => {
  const dir = tmpRepo({});
  const runner = new GateRunnerImpl(worktrees, { sandboxGates: "off" });
  const result = await runner.run(project({ gates: { testScript: "unit-tests" } }), task(dir));
  assert.equal(result.tests, false, "an explicitly configured testScript override that doesn't exist must fail, not silently pass");
  assert.match(result.details.tests ?? "", /not found/);
});

test("B17: a missing DEFAULT-slot script (no override) still passes vacuously, unaffected by the override fix", async () => {
  const dir = tmpRepo({});
  const runner = new GateRunnerImpl(worktrees, { sandboxGates: "off" });
  const result = await runner.run(project(), task(dir));
  assert.equal(result.typecheck, true);
  assert.equal(result.lint, true);
  assert.equal(result.build, true);
  assert.equal(result.tests, true);
  assert.equal(result.vacuous, true, "no scripts at all in a plain repo with no overrides is still the B11 vacuous case");
});

// F13-P1: mode selection + dispatch, verified against a fake exec layer (not
// a real Docker daemon) — the real-Docker path is covered separately by a
// live verification run, not by this unit suite.

test("F13-P1: sandboxGates=auto with Docker available dispatches gate scripts through the sandbox exec layer", async () => {
  const dir = tmpRepo({ build: 'node -e "process.exit(0)"' });
  const calls: { image: string; cwd: string; cmd: string; args: string[] }[] = [];
  const fakeSandbox: SandboxDeps = {
    resolveMode: async () => ({ useSandbox: true, detail: "docker (auto)" }),
    exec: async (image, cwd, cmd, args) => {
      calls.push({ image, cwd, cmd, args });
      return { stdout: "sandboxed-build-output", stderr: "" };
    },
  };
  const runner = new GateRunnerImpl(worktrees, { sandboxGates: "auto" }, fakeSandbox);
  const result = await runner.run(project(), task(dir));
  assert.equal(result.build, true);
  assert.match(result.details.build ?? "", /sandboxed-build-output/);
  assert.ok(
    calls.some((c) => c.cmd === "npm" && c.args.includes("build")),
    "the build script ran through the sandbox exec layer, not host execFile",
  );
  assert.equal(
    calls[0]?.image,
    DEFAULT_GATE_IMAGE,
    "defaults to DEFAULT_GATE_IMAGE when project.config.gateImage is unset",
  );
});

test("F13-P1: sandboxGates=auto with no Docker daemon falls back to real host execution", async () => {
  const dir = tmpRepo({ build: 'node -e "process.exit(0)"' });
  let execCalled = false;
  const fakeSandbox: SandboxDeps = {
    resolveMode: async () => ({ useSandbox: false, detail: "host (auto — docker not detected)" }),
    exec: async () => {
      execCalled = true;
      return { stdout: "", stderr: "" };
    },
  };
  const runner = new GateRunnerImpl(worktrees, { sandboxGates: "auto" }, fakeSandbox);
  const result = await runner.run(project(), task(dir));
  assert.equal(result.build, true, "the real host npm script ran and passed");
  assert.equal(execCalled, false, "host mode must never dispatch through the sandbox exec layer");
});

test("F13-P1: sandboxGates=required with no Docker daemon fails every gate loudly instead of silently falling back to host", async () => {
  const dir = tmpRepo({ build: 'node -e "process.exit(0)"' });
  const fakeSandbox: SandboxDeps = {
    resolveMode: async () => {
      throw new Error(
        'sandboxGates is "required" but no Docker daemon responded to `docker version`',
      );
    },
    exec: async () => {
      throw new Error("must not be called — required mode with no daemon must fail before dispatch");
    },
  };
  const runner = new GateRunnerImpl(worktrees, { sandboxGates: "required" }, fakeSandbox);
  const result = await runner.run(project(), task(dir));
  assert.equal(result.build, false);
  assert.equal(result.typecheck, false);
  assert.equal(result.vacuous, undefined, "allFail's shape has no vacuous field — a hard infra failure, not a vacuous-gate case");
  assert.match(result.details.build ?? "", /no Docker daemon responded/);
});

test("F13-P1: a project's gateImage override reaches the sandbox exec layer instead of the default image", async () => {
  const dir = tmpRepo({ build: 'node -e "process.exit(0)"' });
  const images: string[] = [];
  const fakeSandbox: SandboxDeps = {
    resolveMode: async () => ({ useSandbox: true, detail: "docker (auto)" }),
    exec: async (image) => {
      images.push(image);
      return { stdout: "ok", stderr: "" };
    },
  };
  const runner = new GateRunnerImpl(worktrees, { sandboxGates: "auto" }, fakeSandbox);
  await runner.run(project({ gateImage: "python:3.12" }), task(dir));
  assert.ok(images.length > 0);
  assert.ok(images.every((i) => i === "python:3.12"));
});
