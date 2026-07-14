import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import type { Project, Task } from "@orc/types";
import { detectDestructiveChanges } from "./orchestrator.js";
import { WorktreeManagerImpl } from "./worktree-manager.js";

const pexecFile = promisify(execFile);
async function git(args: string[], cwd: string): Promise<void> {
  await pexecFile("git", args, { cwd });
}

function project(localPath: string): Project {
  return {
    id: "p1",
    name: "p",
    repoUrl: "",
    defaultBranch: "main",
    localPath,
    status: "running",
    createdAt: "",
    updatedAt: "",
  };
}

function tmpDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `hoopedorc-${name}-`));
}

function worktreeTask(path: string): Task {
  return {
    id: "t1",
    projectId: "p1",
    title: "task",
    description: "",
    difficulty: "medium",
    status: "in_review",
    dependsOn: [],
    acceptanceCriteria: [],
    assignedModel: "deepseek-flash",
    scopePaths: ["**/*"],
    worktreePath: path,
    attempts: 1,
    maxAttempts: 2,
    createdAt: "",
    updatedAt: "",
  };
}

test("B29: ensureDeps fingerprints the worktree's manifest, not the primary clone's stale one", async () => {
  const primary = tmpDir("wt-primary");
  const worktree1 = tmpDir("wt-1");
  const worktree2 = tmpDir("wt-2");

  // Primary's own on-disk package.json is never touched by this class after
  // this point — simulating the real bug, where nothing keeps the primary
  // clone's working tree in sync with origin after a merge.
  writeFileSync(join(primary, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));

  // Worktree 1: a fresh checkout identical to primary's current (pre-merge) state.
  writeFileSync(join(worktree1, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));

  const runner = new WorktreeManagerImpl({ sandboxGates: "off" });
  await (runner as unknown as { ensureDeps: (p: Project, w: string) => Promise<void> }).ensureDeps(
    project(primary),
    worktree1,
  );

  const marker = join(primary, "node_modules", ".hoopedorc-deps-hash");
  assert.ok(existsSync(marker), "first ensureDeps call installs and writes the marker");
  const firstHash = readFileSync(marker, "utf-8").trim();

  // Worktree 2: simulates a second task's fresh checkout after a merge changed
  // package.json on origin's default branch. Primary's own package.json is
  // deliberately left as-is here too — under the old (buggy) fingerprint
  // source, this second call would see no change at all and skip reinstall.
  writeFileSync(
    join(worktree2, "package.json"),
    JSON.stringify({ name: "x", version: "1.0.0", description: "scaffold task added real scripts" }),
  );

  await (runner as unknown as { ensureDeps: (p: Project, w: string) => Promise<void> }).ensureDeps(
    project(primary),
    worktree2,
  );

  const secondHash = readFileSync(marker, "utf-8").trim();
  assert.notEqual(
    secondHash,
    firstHash,
    "the changed worktree manifest must produce a different fingerprint and trigger a reinstall",
  );
  assert.deepEqual(
    JSON.parse(readFileSync(join(primary, "package.json"), "utf-8")),
    JSON.parse(readFileSync(join(worktree2, "package.json"), "utf-8")),
    "primary's package.json must be brought up to date with the worktree that triggered the reinstall",
  );
});

test("B29: an unchanged worktree manifest across two worktrees does not force a reinstall", async (t) => {
  const primary = tmpDir("wt-primary");
  const worktree1 = tmpDir("wt-1");
  const worktree2 = tmpDir("wt-2");

  writeFileSync(join(primary, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
  writeFileSync(join(worktree1, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
  writeFileSync(join(worktree2, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));

  const runner = new WorktreeManagerImpl({ sandboxGates: "off" }) as unknown as {
    ensureDeps: (p: Project, w: string) => Promise<void>;
  };
  const marker = join(primary, "node_modules", ".hoopedorc-deps-hash");

  await t.test("first call installs", async () => {
    await runner.ensureDeps(project(primary), worktree1);
    assert.ok(existsSync(marker));
  });

  const firstHash = readFileSync(marker, "utf-8").trim();

  await t.test("second call, unchanged manifest, reuses the marker", async () => {
    await runner.ensureDeps(project(primary), worktree2);
    const secondHash = readFileSync(marker, "utf-8").trim();
    assert.equal(secondHash, firstHash, "identical manifests across worktrees must reuse the existing marker, not reinstall");
  });
});

test("B33: primaryDirtyFiles reports real git dirt, excluding package.json/lockfiles", async () => {
  const primary = tmpDir("wt-primary-dirty");
  await git(["init", "-q"], primary);
  writeFileSync(join(primary, "package.json"), JSON.stringify({ name: "x" }));
  writeFileSync(join(primary, "README.md"), "# hello\n");
  await git(["add", "-A"], primary);
  await git(["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", "init"], primary);

  const runner = new WorktreeManagerImpl({ sandboxGates: "off" });

  // Clean working tree: nothing to report.
  assert.deepEqual(await runner.primaryDirtyFiles(project(primary)), []);

  // B29's manifest copy legitimately dirties package.json/lockfiles before
  // an install — those must never be reported as a sign something's wrong.
  writeFileSync(join(primary, "package.json"), JSON.stringify({ name: "x", version: "2.0.0" }));
  writeFileSync(join(primary, "package-lock.json"), "{}");
  assert.deepEqual(
    await runner.primaryDirtyFiles(project(primary)),
    [],
    "package.json/lockfile dirt alone must not be reported",
  );

  // A file an agent should never have touched here — this IS the signal.
  writeFileSync(join(primary, "src-oops.ts"), "// written to the wrong place\n");
  const dirty = await runner.primaryDirtyFiles(project(primary));
  assert.deepEqual(dirty, ["src-oops.ts"], "an unrelated dirty file must be named, package.json still excluded");
});

test("S9: typed diff acquisition scans destructive lines beyond the old 40K cap", async () => {
  const repo = tmpDir("wt-safety-diff");
  await git(["init", "-q"], repo);
  await git(["branch", "-M", "main"], repo);
  writeFileSync(join(repo, "rename-me.txt"), "same content\n");
  writeFileSync(join(repo, "delete-me.txt"), "delete me\n");
  writeFileSync(join(repo, "query.sql"), "SELECT 1;\n");
  await git(["add", "-A"], repo);
  await git(["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", "base"], repo);
  await git(["update-ref", "refs/remotes/origin/main", "HEAD"], repo);

  renameSync(join(repo, "rename-me.txt"), join(repo, "renamed.txt"));
  unlinkSync(join(repo, "delete-me.txt"));
  writeFileSync(join(repo, "query.sql"), "x".repeat(50_000) + "\nDROP TABLE users;\n");
  await git(["add", "-A"], repo);
  await git(["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", "change"], repo);

  const runner = new WorktreeManagerImpl({ sandboxGates: "off" });
  const status = await runner.changedFilesWithStatus(project(repo), worktreeTask(repo));
  const diff = await runner.diffText(project(repo), worktreeTask(repo));
  assert.equal(status.ok, true);
  assert.equal(diff.ok, true);
  assert.equal(diff.truncated, false);
  assert.ok(diff.byteCount > 40_000);
  assert.ok(diff.value.indexOf("DROP TABLE users") > 40_000);
  assert.ok(status.value.some((entry) => entry.status.startsWith("R") && entry.path === "renamed.txt"));
  assert.ok(status.value.some((entry) => entry.status === "D" && entry.path === "delete-me.txt"));
  assert.ok(
    detectDestructiveChanges(status.value, diff.value).some((reason) =>
      /destructive SQL/.test(reason),
    ),
  );
});

test("S9: git inspection failure is typed, never an empty clean result", async () => {
  const dir = tmpDir("wt-not-git");
  const runner = new WorktreeManagerImpl({ sandboxGates: "off" });
  const task = worktreeTask(dir);
  const status = await runner.changedFilesWithStatus(project(dir), task);
  const diff = await runner.diffText(project(dir), task);
  assert.equal(status.ok, false);
  assert.equal(diff.ok, false);
  assert.match(status.error ?? "", /not a git repository/i);
  assert.match(diff.error ?? "", /not a git repository/i);
});

test("S9: restoreToHead removes tracked, untracked, and nested-repository gate output", async () => {
  const repo = tmpDir("wt-gate-restore");
  await git(["init", "-q"], repo);
  writeFileSync(join(repo, "source.ts"), "export const clean = true;\n");
  await git(["add", "-A"], repo);
  await git(
    ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", "base"],
    repo,
  );

  writeFileSync(join(repo, "source.ts"), "export const clean = false;\n");
  writeFileSync(join(repo, "generated.txt"), "gate output\n");
  mkdirSync(join(repo, "nested"));
  await git(["init", "-q"], join(repo, "nested"));
  writeFileSync(join(repo, "nested", "artifact.txt"), "nested gate output\n");

  const runner = new WorktreeManagerImpl({ sandboxGates: "off" });
  const task = worktreeTask(repo);
  const restored = await runner.restoreToHead(task);

  assert.equal(restored.ok, true, restored.error);
  assert.equal(readFileSync(join(repo, "source.ts"), "utf8"), "export const clean = true;\n");
  assert.equal(existsSync(join(repo, "generated.txt")), false);
  assert.equal(existsSync(join(repo, "nested")), false);
  assert.deepEqual((await runner.worktreeChanges(task)).value, []);
});
