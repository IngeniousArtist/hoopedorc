import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmodSync,
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
import type { Project, RollbackJob } from "@orc/types";
import { GitServiceImpl, RollbackConflictError } from "./git-service.js";

const pexecFile = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await pexecFile("git", args, { cwd });
  return stdout.trim();
}

async function rollbackRepo(name: string): Promise<{
  root: string;
  project: Project;
}> {
  const root = mkdtempSync(join(tmpdir(), `hoopedorc-${name}-`));
  const primary = join(root, "primary");
  const remote = join(root, "remote.git");
  mkdirSync(primary);
  await git(root, ["init", "--bare", "-q", remote]);
  await git(primary, ["init", "-q", "-b", "main"]);
  await git(primary, ["config", "user.email", "rollback@test.local"]);
  await git(primary, ["config", "user.name", "Rollback Test"]);
  writeFileSync(join(primary, "app.txt"), "base\n");
  await git(primary, ["add", "app.txt"]);
  await git(primary, ["commit", "-q", "-m", "base"]);
  await git(primary, ["remote", "add", "origin", remote]);
  await git(primary, ["push", "-q", "-u", "origin", "main"]);
  return {
    root,
    project: {
      id: "p1",
      name: "rollback test",
      repoUrl: remote,
      defaultBranch: "main",
      localPath: primary,
      status: "completed",
      createdAt: "",
      updatedAt: "",
    },
  };
}

function rollbackJob(root: string, sourceCommit: string): RollbackJob {
  return {
    id: "job-1",
    projectId: "p1",
    taskId: "t1",
    sourcePrNumber: 7,
    sourceCommit,
    branch: "orc/rollback-job-1",
    worktreePath: join(root, "primary-rollback-job-1"),
    status: "preparing",
    createdAt: "",
    updatedAt: "",
  };
}

test("GitHub checks polling aborts during its retry wait", async () => {
  const bin = mkdtempSync(join(tmpdir(), "hoopedorc-gh-test-"));
  const fakeGh = join(bin, "gh");
  writeFileSync(
    fakeGh,
    '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify([{ bucket: "pending" }]));\n',
  );
  chmodSync(fakeGh, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;

  const project: Project = {
    id: "p1",
    name: "project",
    repoUrl: "owner/repo",
    defaultBranch: "main",
    localPath: "/tmp",
    status: "running",
    createdAt: "",
    updatedAt: "",
  };
  const controller = new AbortController();
  const started = Date.now();
  try {
    const polling = new GitServiceImpl().waitForChecks(
      project,
      1,
      60_000,
      undefined,
      controller.signal,
    );
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(polling, { name: "AbortError" });
    assert.ok(Date.now() - started < 1_000);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("B36: a single-parent squash commit uses a plain, idempotent revert without moving main", async () => {
  const { root, project } = await rollbackRepo("rollback-squash");
  writeFileSync(join(project.localPath, "app.txt"), "bad squash change\n");
  await git(project.localPath, ["add", "app.txt"]);
  await git(project.localPath, ["commit", "-q", "-m", "squashed PR"]);
  const sourceCommit = await git(project.localPath, ["rev-parse", "HEAD"]);
  await git(project.localPath, ["push", "-q", "origin", "main"]);
  const remoteMainBefore = await git(project.localPath, [
    "rev-parse",
    "origin/main",
  ]);
  const job = rollbackJob(root, sourceCommit);
  const service = new GitServiceImpl();

  const first = await service.prepareRollback(project, job);
  const rollbackHead = await git(job.worktreePath, ["rev-parse", "HEAD"]);
  const second = await service.prepareRollback(project, job);

  assert.equal(first.sourceParentCount, 1);
  assert.equal(second.sourceParentCount, 1);
  assert.equal(readFileSync(join(job.worktreePath, "app.txt"), "utf8"), "base\n");
  assert.equal(await git(job.worktreePath, ["rev-parse", "HEAD"]), rollbackHead);
  assert.match(
    await git(job.worktreePath, ["log", "-1", "--format=%B"]),
    /Hoopedorc-Rollback-Job: job-1/,
  );
  assert.equal(
    await git(project.localPath, ["rev-parse", "origin/main"]),
    remoteMainBefore,
    "preparing a rollback must never push the default branch",
  );
});

test("B36: a true merge commit uses mainline parent 1", async () => {
  const { root, project } = await rollbackRepo("rollback-merge");
  await git(project.localPath, ["switch", "-q", "-c", "feature"]);
  writeFileSync(join(project.localPath, "feature.txt"), "feature\n");
  await git(project.localPath, ["add", "feature.txt"]);
  await git(project.localPath, ["commit", "-q", "-m", "feature"]);
  await git(project.localPath, ["switch", "-q", "main"]);
  await git(project.localPath, ["merge", "-q", "--no-ff", "feature", "-m", "merge PR"]);
  const sourceCommit = await git(project.localPath, ["rev-parse", "HEAD"]);
  await git(project.localPath, ["push", "-q", "origin", "main"]);
  const job = rollbackJob(root, sourceCommit);

  const prepared = await new GitServiceImpl().prepareRollback(project, job);

  assert.equal(prepared.sourceParentCount, 2);
  assert.equal(existsSync(join(job.worktreePath, "feature.txt")), false);
  assert.equal(readFileSync(join(job.worktreePath, "app.txt"), "utf8"), "base\n");
});

test("B36: a conflicting revert aborts cleanly and reports the paths", async () => {
  const { root, project } = await rollbackRepo("rollback-conflict");
  writeFileSync(join(project.localPath, "app.txt"), "bad change\n");
  await git(project.localPath, ["add", "app.txt"]);
  await git(project.localPath, ["commit", "-q", "-m", "source PR"]);
  const sourceCommit = await git(project.localPath, ["rev-parse", "HEAD"]);
  writeFileSync(join(project.localPath, "app.txt"), "later incompatible change\n");
  await git(project.localPath, ["add", "app.txt"]);
  await git(project.localPath, ["commit", "-q", "-m", "later change"]);
  await git(project.localPath, ["push", "-q", "origin", "main"]);
  const job = rollbackJob(root, sourceCommit);

  await assert.rejects(
    new GitServiceImpl().prepareRollback(project, job),
    (err: unknown) =>
      err instanceof RollbackConflictError && /app\.txt/.test(err.message),
  );
  assert.equal(await git(job.worktreePath, ["status", "--porcelain"]), "");
});
