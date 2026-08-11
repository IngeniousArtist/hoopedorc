import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { RepositoryLock } from "./repository-lock.js";

const pexecFile = promisify(execFile);

async function initRepository(name: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), `hoopedorc-o4-${name}-`));
  const repository = join(root, "repository");
  await pexecFile("git", ["init", "-q", "-b", "main", repository]);
  await pexecFile("git", ["-C", repository, "config", "user.email", "o4@test.local"]);
  await pexecFile("git", ["-C", repository, "config", "user.name", "O4 Test"]);
  writeFileSync(join(repository, "README.md"), "fixture\n");
  await pexecFile("git", ["-C", repository, "add", "README.md"]);
  await pexecFile("git", ["-C", repository, "commit", "-q", "-m", "fixture"]);
  return repository;
}

test("O4: primary, linked-worktree, and symlink paths share one common-directory lock", async () => {
  const repository = await initRepository("identity");
  const linked = `${repository}-linked`;
  await pexecFile("git", ["-C", repository, "worktree", "add", "--detach", linked]);
  const symlink = `${repository}-symlink`;
  symlinkSync(repository, symlink);
  const lock = new RepositoryLock();

  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstStarted!: () => void;
  const firstDidStart = new Promise<void>((resolve) => { firstStarted = resolve; });
  let active = 0;
  let maxActive = 0;
  const enter = async (gate?: Promise<void>) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    firstStarted();
    if (gate) await gate;
    active -= 1;
  };

  const first = lock.run(repository, () => enter(firstGate));
  await firstDidStart;
  const second = lock.run(linked, () => enter());
  const third = lock.run(symlink, () => enter());
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(maxActive, 1);
  assert.equal(lock.activeKeyCount, 1);
  releaseFirst();
  await Promise.all([first, second, third]);
  assert.equal(maxActive, 1);
  assert.equal(lock.activeKeyCount, 0);
});

test("O4: queued cancellation rejects promptly and never runs later", async () => {
  const lock = new RepositoryLock(() => Promise.resolve("same-key"));
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstStarted!: () => void;
  const firstDidStart = new Promise<void>((resolve) => { firstStarted = resolve; });
  const first = lock.run("repo", async () => {
    firstStarted();
    await firstGate;
  });
  await firstDidStart;

  const controller = new AbortController();
  let queuedRan = false;
  const queued = lock.run(
    "repo",
    () => {
      queuedRan = true;
      return Promise.resolve();
    },
    controller.signal,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(queued, { name: "AbortError" });
  assert.equal(queuedRan, false);

  releaseFirst();
  await first;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(queuedRan, false);
  assert.equal(lock.activeKeyCount, 0);
});

test("O4: different repositories mutate concurrently and both queues are evicted", async () => {
  const firstRepository = await initRepository("parallel-a");
  const secondRepository = await initRepository("parallel-b");
  const lock = new RepositoryLock();
  let active = 0;
  let maxActive = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let bothStarted!: () => void;
  const didBothStart = new Promise<void>((resolve) => { bothStarted = resolve; });
  const enter = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (active === 2) bothStarted();
    await gate;
    active -= 1;
  };

  const first = lock.run(firstRepository, enter);
  const second = lock.run(secondRepository, enter);
  await didBothStart;
  assert.equal(lock.activeKeyCount, 2);
  release();
  await Promise.all([first, second]);
  assert.equal(maxActive, 2);
  assert.equal(lock.activeKeyCount, 0);
});
