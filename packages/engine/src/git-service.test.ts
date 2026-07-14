import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { Project, RollbackJob, Task } from "@orc/types";
import {
  GitOperationError,
  GitServiceImpl,
  RollbackConflictError,
} from "./git-service.js";

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

function rejectsAt(stage: GitOperationError["stage"]): (err: unknown) => boolean {
  return (err) => err instanceof GitOperationError && err.stage === stage;
}

test("B39: commitAll accepts only a confirmed clean tree as a no-op", async () => {
  const { project } = await rollbackRepo("commit-clean");
  await new GitServiceImpl().commitAll(project.localPath, "clean no-op");
  assert.equal(await git(project.localPath, ["status", "--porcelain"]), "");
});

test("B39: commitAll keeps identity and hook failures typed instead of calling them clean", async () => {
  const identity = await rollbackRepo("commit-identity");
  await git(identity.project.localPath, ["config", "user.name", ""]);
  await git(identity.project.localPath, ["config", "user.email", ""]);
  writeFileSync(join(identity.project.localPath, "identity.txt"), "change\n");
  await assert.rejects(
    new GitServiceImpl().commitAll(identity.project.localPath, "must fail identity"),
    rejectsAt("commit"),
  );

  const hook = await rollbackRepo("commit-hook");
  const hookPath = join(hook.project.localPath, ".git", "hooks", "pre-commit");
  writeFileSync(hookPath, "#!/bin/sh\necho blocked-by-test >&2\nexit 1\n");
  chmodSync(hookPath, 0o755);
  writeFileSync(join(hook.project.localPath, "hook.txt"), "change\n");
  await assert.rejects(
    new GitServiceImpl().commitAll(hook.project.localPath, "must fail hook"),
    (err: unknown) => rejectsAt("commit")(err) && /blocked-by-test/.test((err as Error).message),
  );
});

test("B39: commitAll surfaces an index lock as a staging failure", async () => {
  const { project } = await rollbackRepo("commit-index-lock");
  writeFileSync(join(project.localPath, "locked.txt"), "change\n");
  writeFileSync(join(project.localPath, ".git", "index.lock"), "held\n");
  await assert.rejects(
    new GitServiceImpl().commitAll(project.localPath, "must fail index lock"),
    rejectsAt("stage"),
  );
});

test(
  "B39: planning persistence reports filesystem permission failures at the write stage",
  { skip: process.platform === "win32" },
  async () => {
    const { project } = await rollbackRepo("planning-permission");
    const docs = join(project.localPath, "docs");
    mkdirSync(docs);
    chmodSync(docs, 0o500);
    try {
      await assert.rejects(
        new GitServiceImpl().commitFiles(
          project,
          [{ path: "docs/PRD.md", content: "# PRD" }],
          "docs: planning",
        ),
        rejectsAt("write"),
      );
    } finally {
      chmodSync(docs, 0o700);
    }
  },
);

test("B39: planning persistence surfaces fetch failures with a typed stage", async () => {
  const { root, project } = await rollbackRepo("planning-fetch");
  await git(project.localPath, ["remote", "set-url", "origin", join(root, "missing.git")]);
  await assert.rejects(
    new GitServiceImpl().commitFiles(
      project,
      [{ path: "docs/PRD.md", content: "# PRD" }],
      "docs: planning",
    ),
    rejectsAt("fetch"),
  );
});

test("B39: a failed planning push is typed and a no-diff retry publishes the local commit", async () => {
  const { root, project } = await rollbackRepo("planning-push-retry");
  const remote = join(root, "remote.git");
  const hook = join(remote, "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\necho reject-first-push >&2\nexit 1\n");
  chmodSync(hook, 0o755);
  const service = new GitServiceImpl();
  const files = [
    { path: "docs/PRD.md", content: "# Durable PRD" },
    { path: "AGENTS.md", content: "# Agents" },
    { path: "CLAUDE.md", content: "@AGENTS.md", ifMissing: true },
  ];

  await assert.rejects(
    service.commitFiles(project, files, "docs: planning context"),
    (err: unknown) => rejectsAt("push")(err) && /reject-first-push/.test((err as Error).message),
  );
  assert.equal(await git(project.localPath, ["rev-list", "--count", "origin/main..main"]), "1");

  rmSync(hook);
  await service.commitFiles(project, files, "docs: planning context");

  assert.equal(await git(project.localPath, ["rev-list", "--count", "origin/main..main"]), "0");
  assert.equal(
    await git(root, ["--git-dir", remote, "show", "main:docs/PRD.md"]),
    "# Durable PRD",
  );
  assert.equal(await git(project.localPath, ["log", "--format=%s", "-1"]), "docs: planning context");
});

test("B39: atomic planning persistence preserves a tracked hand-maintained CLAUDE.md", async () => {
  const { root, project } = await rollbackRepo("planning-claude-preserve");
  const remote = join(root, "remote.git");
  writeFileSync(join(project.localPath, "CLAUDE.md"), "# Owner instructions\n");
  await git(project.localPath, ["add", "CLAUDE.md"]);
  await git(project.localPath, ["commit", "-q", "-m", "owner claude instructions"]);
  await git(project.localPath, ["push", "-q", "origin", "main"]);

  await new GitServiceImpl().commitFiles(
    project,
    [
      { path: "docs/PRD.md", content: "# PRD" },
      { path: "AGENTS.md", content: "# Agents" },
      { path: "CLAUDE.md", content: "@AGENTS.md", ifMissing: true },
    ],
    "docs: planning context",
  );

  assert.equal(readFileSync(join(project.localPath, "CLAUDE.md"), "utf8"), "# Owner instructions\n");
  assert.equal(
    await git(root, ["--git-dir", remote, "show", "main:CLAUDE.md"]),
    "# Owner instructions",
  );
});

test("B39: atomic planning persistence preserves an untracked hand-maintained CLAUDE.md", async () => {
  const { project } = await rollbackRepo("planning-untracked-claude-preserve");
  writeFileSync(join(project.localPath, "CLAUDE.md"), "# Local owner instructions\n");

  await new GitServiceImpl().commitFiles(
    project,
    [
      { path: "docs/PRD.md", content: "# PRD" },
      { path: "AGENTS.md", content: "# Agents" },
      { path: "CLAUDE.md", content: "@AGENTS.md", ifMissing: true },
    ],
    "docs: planning context",
  );

  assert.equal(
    readFileSync(join(project.localPath, "CLAUDE.md"), "utf8"),
    "# Local owner instructions\n",
  );
  assert.equal(await git(project.localPath, ["status", "--porcelain", "--", "CLAUDE.md"]), "?? CLAUDE.md");
});

test("B39: optional changelog publication never sweeps unrelated staged changes into its commit", async () => {
  const { root, project } = await rollbackRepo("changelog-pathspec");
  writeFileSync(join(project.localPath, "app.txt"), "owner edit\n");
  await git(project.localPath, ["add", "app.txt"]);

  await new GitServiceImpl().appendChangelogEntry(
    project,
    {
      id: "t39",
      projectId: project.id,
      title: "Durable changelog",
      description: "Publish only the generated changelog",
      difficulty: "easy",
      status: "done",
      dependsOn: [],
      acceptanceCriteria: ["Only CHANGELOG.md is committed"],
      assignedModel: "deepseek-flash",
      scopePaths: ["CHANGELOG.md"],
      attempts: 1,
      maxAttempts: 3,
      createdAt: "",
      updatedAt: "",
    } satisfies Task,
    39,
  );

  assert.equal(await git(project.localPath, ["status", "--porcelain", "--", "app.txt"]), "M  app.txt");
  assert.equal(
    await git(root, ["--git-dir", join(root, "remote.git"), "show", "main:app.txt"]),
    "base",
  );
});

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
