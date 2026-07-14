import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import type { Project } from "@orc/types";
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
