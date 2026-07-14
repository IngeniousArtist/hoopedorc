import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import type { Project, ProjectConfig, Task } from "@orc/types";
import { detectDestructiveChanges } from "./orchestrator.js";
import {
  frozenInstallArgs,
  inspectNodeDependencies,
  nodeDependencyFingerprint,
  type NodePackageManager,
  type SetupProcessRequest,
  WorktreeManagerImpl,
} from "./worktree-manager.js";

const pexecFile = promisify(execFile);
async function git(args: string[], cwd: string): Promise<void> {
  await pexecFile("git", args, { cwd });
}

function project(localPath: string, config?: ProjectConfig): Project {
  return {
    id: "p1",
    name: "p",
    repoUrl: "",
    defaultBranch: "main",
    localPath,
    status: "running",
    config,
    createdAt: "",
    updatedAt: "",
  };
}

function tmpDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `hoopedorc-${name}-`));
}

type TestWorktreeManager = {
  ensureDeps: (project: Project, worktreePath: string, signal?: AbortSignal) => Promise<void>;
  setupHealth: (project: Project) => Promise<{ ok: boolean; detail: string }>;
};

interface FakeSetupOptions {
  versions?: Partial<Record<NodePackageManager, string>>;
  runtime?: { nodeVersion: string; platform: string; arch: string };
  onInstall?: (request: SetupProcessRequest) => Promise<void>;
  onCustom?: (request: SetupProcessRequest) => Promise<void>;
  hostPlatform?: NodeJS.Platform;
  createNodeModules?: boolean;
}

function fakeManager(cache: string, options: FakeSetupOptions = {}) {
  const calls: SetupProcessRequest[] = [];
  let installCount = 0;
  const versions = {
    npm: "10.9.0",
    pnpm: "9.15.0",
    yarn: "4.6.0",
    bun: "1.2.0",
    ...options.versions,
  };
  const runtime = options.runtime ?? {
    nodeVersion: "v22.14.0",
    platform: "linux",
    arch: "x64",
  };
  const execute = async (request: SetupProcessRequest) => {
    calls.push(request);
    if (request.command === "node" && request.args[0] === "-p") {
      return { stdout: JSON.stringify(runtime), stderr: "" };
    }
    if (
      ["npm", "pnpm", "yarn", "bun"].includes(request.command) &&
      request.args.length === 1 &&
      request.args[0] === "--version"
    ) {
      const version = versions[request.command as NodePackageManager];
      if (!version) throw new Error(`${request.command}: command not found`);
      return { stdout: `${version}\n`, stderr: "" };
    }
    if (["npm", "pnpm", "yarn", "bun"].includes(request.command)) {
      installCount += 1;
      if (options.onInstall) await options.onInstall(request);
      if (options.createNodeModules !== false) {
        mkdirSync(join(request.cwd, "node_modules"), { recursive: true });
      }
      return { stdout: "installed\n", stderr: "" };
    }
    if (options.onCustom) await options.onCustom(request);
    return { stdout: "setup complete\n", stderr: "" };
  };
  const manager = new WorktreeManagerImpl(
    { sandboxGates: "off" },
    {
      cacheRoot: () => cache,
      execute,
      resolveMode: async () => ({ useSandbox: false, detail: "test host" }),
      hostPlatform: options.hostPlatform,
    },
  ) as unknown as TestWorktreeManager;
  return { manager, calls, get installCount() { return installCount; } };
}

function writeNodeProject(
  dir: string,
  manager: NodePackageManager,
  lockContent = "lock-v1",
  packageManager?: string,
): void {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0", ...(packageManager ? { packageManager } : {}) }),
  );
  const lockfile = {
    npm: "package-lock.json",
    pnpm: "pnpm-lock.yaml",
    yarn: "yarn.lock",
    bun: "bun.lock",
  }[manager];
  writeFileSync(join(dir, lockfile), lockContent);
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

test("B38: packageManager wins, each supported manager uses a frozen install, and ambiguous locks fail", () => {
  const cases: Array<[NodePackageManager, string | undefined, string, string[]]> = [
    ["npm", undefined, "package-lock.json", ["ci"]],
    ["pnpm", "pnpm@9.15.0", "pnpm-lock.yaml", ["install", "--frozen-lockfile"]],
    ["yarn", "yarn@4.6.0", "yarn.lock", ["install", "--immutable"]],
    ["bun", "bun@1.2.0", "bun.lock", ["install", "--frozen-lockfile"]],
  ];
  for (const [manager, declared, lockfile, args] of cases) {
    const dir = tmpDir(`select-${manager}`);
    writeNodeProject(dir, manager, "lock", declared);
    if (manager === "pnpm") writeFileSync(join(dir, "package-lock.json"), "ignored by packageManager");
    const plan = inspectNodeDependencies(dir);
    assert.equal(plan?.manager, manager);
    assert.equal(plan?.lockfile, lockfile);
    assert.deepEqual(frozenInstallArgs(manager, manager === "yarn" ? "4.6.0" : "1.0.0"), args);
  }
  assert.deepEqual(frozenInstallArgs("yarn", "1.22.22"), ["install", "--frozen-lockfile"]);

  const ambiguous = tmpDir("ambiguous-locks");
  writeNodeProject(ambiguous, "npm");
  writeFileSync(join(ambiguous, "yarn.lock"), "lock");
  assert.throws(
    () => inspectNodeDependencies(ambiguous),
    /Ambiguous Node lockfiles.*packageManager/i,
  );
});

test("B38/B29: worktree inputs produce immutable caches without touching primary manifests", async () => {
  const primary = tmpDir("wt-primary");
  const worktree1 = tmpDir("wt-1");
  const worktree2 = tmpDir("wt-2");
  const cache = tmpDir("deps-cache");

  const primaryPackage = JSON.stringify({ name: "primary-must-stay-unchanged", version: "1.0.0" });
  writeFileSync(join(primary, "package.json"), primaryPackage);
  writeNodeProject(worktree1, "npm", "lock-v1");
  writeNodeProject(worktree2, "npm", "lock-v2");

  const fake = fakeManager(cache);
  await fake.manager.ensureDeps(project(primary), worktree1);
  await fake.manager.ensureDeps(project(primary), worktree2);

  assert.equal(fake.installCount, 2, "different worktree lockfiles publish different caches");
  assert.notEqual(realpathSync(join(worktree1, "node_modules")), realpathSync(join(worktree2, "node_modules")));
  assert.equal(readFileSync(join(primary, "package.json"), "utf8"), primaryPackage);
  assert.equal(existsSync(join(primary, "node_modules")), false);
});

test("B38: concurrent identical fingerprints install once and materialize both worktrees", async () => {
  const primary = tmpDir("wt-primary");
  const worktree1 = tmpDir("wt-1");
  const worktree2 = tmpDir("wt-2");
  const cache = tmpDir("deps-cache");
  writeNodeProject(worktree1, "npm");
  writeNodeProject(worktree2, "npm");

  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => { started = resolve; });
  const fake = fakeManager(cache, {
    onInstall: async () => {
      started();
      await gate;
    },
  });
  const first = fake.manager.ensureDeps(project(primary), worktree1);
  await didStart;
  const second = fake.manager.ensureDeps(project(primary), worktree2);
  release();
  await Promise.all([first, second]);

  assert.equal(fake.installCount, 1);
  assert.notEqual(
    realpathSync(join(worktree1, "node_modules")),
    realpathSync(join(worktree2, "node_modules")),
    "each worktree gets an independent materialization of the immutable cache",
  );
  const published = readdirSync(cache).filter((name) => !name.startsWith(".tmp-"));
  assert.equal(published.length, 1);
});

test("B38: different fingerprints install concurrently instead of sharing a global lock", async () => {
  const primary = tmpDir("different-primary");
  const firstWorktree = tmpDir("different-1");
  const secondWorktree = tmpDir("different-2");
  const cache = tmpDir("different-cache");
  writeNodeProject(firstWorktree, "npm", "lock-a");
  writeNodeProject(secondWorktree, "npm", "lock-b");

  let active = 0;
  let maxActive = 0;
  let bothStarted!: () => void;
  const gate = new Promise<void>((resolve) => { bothStarted = resolve; });
  const fake = fakeManager(cache, {
    onInstall: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (active === 2) bothStarted();
      await gate;
      active -= 1;
    },
  });

  await Promise.all([
    fake.manager.ensureDeps(project(primary), firstWorktree),
    fake.manager.ensureDeps(project(primary), secondWorktree),
  ]);
  assert.equal(fake.installCount, 2);
  assert.equal(maxActive, 2);
});

test("B38: selected package managers reach the executor with exact reproducible arguments", async () => {
  const cases: Array<[NodePackageManager, string, string[]]> = [
    ["npm", "npm@10.9.0", ["ci"]],
    ["pnpm", "pnpm@9.15.0", ["install", "--frozen-lockfile"]],
    ["yarn", "yarn@4.6.0", ["install", "--immutable"]],
    ["bun", "bun@1.2.0", ["install", "--frozen-lockfile"]],
  ];
  for (const [manager, declared, expectedArgs] of cases) {
    const primary = tmpDir(`exec-primary-${manager}`);
    const worktree = tmpDir(`exec-worktree-${manager}`);
    const cache = tmpDir(`exec-cache-${manager}`);
    writeNodeProject(worktree, manager, "lock", declared);
    const fake = fakeManager(cache);
    await fake.manager.ensureDeps(project(primary), worktree);
    const install = fake.calls.find(
      (call) => call.command === manager && call.args[0] !== "--version",
    );
    assert.deepEqual(install?.args, expectedArgs, manager);
    assert.equal(install?.timeoutMs, 10 * 60 * 1000);
  }
});

test("B38: the real npm-ci path publishes and materializes an empty dependency graph", async () => {
  const primary = tmpDir("real-npm-primary");
  const worktree = tmpDir("real-npm-worktree");
  const cache = `${primary}-hoopedorc-deps`;
  const pkg = { name: "real-npm-fixture", version: "1.0.0" };
  writeFileSync(join(worktree, "package.json"), JSON.stringify(pkg));
  writeFileSync(
    join(worktree, "package-lock.json"),
    JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true, packages: { "": pkg } }),
  );
  const manager = new WorktreeManagerImpl({ sandboxGates: "off" }) as unknown as TestWorktreeManager;
  try {
    await manager.ensureDeps(project(primary), worktree);
    assert.equal(existsSync(join(worktree, "node_modules")), true);
    const entries = readdirSync(cache).filter((name) => /^[a-f0-9]{64}$/.test(name));
    assert.equal(entries.length, 1);
    assert.equal(existsSync(join(cache, entries[0]!, ".hoopedorc-deps.json")), true);
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

test("B38: a failed install publishes no cache and reports an actionable retry", async () => {
  const primary = tmpDir("failed-primary");
  const worktree = tmpDir("failed-worktree");
  const cache = tmpDir("failed-cache");
  writeNodeProject(worktree, "npm");
  const fake = fakeManager(cache, {
    onInstall: async () => { throw new Error("registry unavailable"); },
  });
  await assert.rejects(
    fake.manager.ensureDeps(project(primary), worktree),
    /npm frozen install failed.*no dependency cache was published.*registry unavailable/i,
  );
  assert.deepEqual(readdirSync(cache), []);
  assert.equal(existsSync(join(worktree, "node_modules")), false);
});

test("B38: a missing selected binary is actionable in setup and Setup health", async () => {
  const primary = tmpDir("missing-primary");
  const worktree = tmpDir("missing-worktree");
  const cache = tmpDir("missing-cache");
  writeNodeProject(worktree, "pnpm", "lock", "pnpm@9.15.0");
  writeNodeProject(primary, "pnpm", "lock", "pnpm@9.15.0");
  const fake = fakeManager(cache, { versions: { pnpm: undefined } });
  await assert.rejects(
    fake.manager.ensureDeps(project(primary), worktree),
    /selects pnpm.*binary is unavailable.*Install pnpm/i,
  );
  const health = await fake.manager.setupHealth(project(primary));
  assert.equal(health.ok, false);
  assert.match(health.detail, /selects pnpm.*host PATH.*Install pnpm/i);
});

test("B38: monorepo manifests and runtime OS/architecture are part of the cache key", () => {
  const root = tmpDir("monorepo-key");
  writeNodeProject(root, "npm");
  mkdirSync(join(root, "packages", "app"), { recursive: true });
  const nested = join(root, "packages", "app", "package.json");
  writeFileSync(nested, JSON.stringify({ name: "app", version: "1.0.0" }));
  const plan = inspectNodeDependencies(root);
  assert.ok(plan);
  assert.ok(plan.inputs.some((path) => path.endsWith(join("packages", "app", "package.json"))));
  const linuxX64 = { nodeVersion: "v22.14.0", platform: "linux", arch: "x64" };
  const first = nodeDependencyFingerprint(root, plan, "10.9.0", linuxX64);
  writeFileSync(nested, JSON.stringify({ name: "app", version: "2.0.0" }));
  const manifestChanged = nodeDependencyFingerprint(
    root,
    inspectNodeDependencies(root)!,
    "10.9.0",
    linuxX64,
  );
  const darwin = nodeDependencyFingerprint(
    root,
    inspectNodeDependencies(root)!,
    "10.9.0",
    { ...linuxX64, platform: "darwin" },
  );
  const arm64 = nodeDependencyFingerprint(
    root,
    inspectNodeDependencies(root)!,
    "10.9.0",
    { ...linuxX64, arch: "arm64" },
  );
  assert.notEqual(first, manifestChanged);
  assert.notEqual(manifestChanged, darwin);
  assert.notEqual(manifestChanged, arm64);
});

test("B38: materialized monorepo workspace links resolve to each live worktree", async () => {
  const primary = tmpDir("workspace-primary");
  const worktree = tmpDir("workspace-worktree");
  const cache = tmpDir("workspace-cache");
  writeNodeProject(worktree, "npm");
  writeFileSync(
    join(worktree, "package.json"),
    JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }),
  );
  mkdirSync(join(worktree, "packages", "app"), { recursive: true });
  writeFileSync(join(worktree, "packages", "app", "package.json"), JSON.stringify({ name: "app" }));
  mkdirSync(join(worktree, "packages", "app", "node_modules", "stale"), {
    recursive: true,
  });
  writeFileSync(
    join(worktree, "packages", "app", "node_modules", "stale", "index.js"),
    "stale\n",
  );
  const fake = fakeManager(cache, {
    onInstall: async (request) => {
      assert.equal(
        existsSync(join(request.cwd, "packages", "app", "node_modules", "stale")),
        false,
        "materialized workspace dependencies must not seed a new frozen install",
      );
      mkdirSync(join(request.cwd, "node_modules"), { recursive: true });
      symlinkSync("../packages/app", join(request.cwd, "node_modules", "app"), "dir");
      mkdirSync(join(request.cwd, "packages", "app", "node_modules", "leaf"), {
        recursive: true,
      });
      writeFileSync(
        join(request.cwd, "packages", "app", "node_modules", "leaf", "index.js"),
        "module.exports = 'workspace dependency';\n",
      );
    },
  });
  await fake.manager.ensureDeps(project(primary), worktree);
  assert.equal(
    realpathSync(join(worktree, "node_modules", "app")),
    realpathSync(join(worktree, "packages", "app")),
  );
  assert.equal(
    readFileSync(join(worktree, "packages", "app", "node_modules", "leaf", "index.js"), "utf8"),
    "module.exports = 'workspace dependency';\n",
  );
});

test("B38: Yarn Plug'n'Play artifacts are cached and materialized without node_modules", async () => {
  const primary = tmpDir("pnp-primary");
  const worktree = tmpDir("pnp-worktree");
  const cache = tmpDir("pnp-cache");
  writeNodeProject(worktree, "yarn", "lock", "yarn@4.6.0");
  const fake = fakeManager(cache, {
    createNodeModules: false,
    onInstall: async (request) => {
      writeFileSync(join(request.cwd, ".pnp.cjs"), "module.exports = {};\n");
      mkdirSync(join(request.cwd, ".yarn", "cache"), { recursive: true });
      writeFileSync(join(request.cwd, ".yarn", "cache", "fixture.zip"), "archive");
    },
  });
  await fake.manager.ensureDeps(project(primary), worktree);
  assert.equal(existsSync(join(worktree, "node_modules")), false);
  assert.equal(readFileSync(join(worktree, ".pnp.cjs"), "utf8"), "module.exports = {};\n");
  assert.equal(readFileSync(join(worktree, ".yarn", "cache", "fixture.zip"), "utf8"), "archive");
});

test("B38: structured custom setup preserves argv, is idempotent, and publishes its marker after success", async () => {
  const primary = tmpDir("custom-primary");
  const worktree = tmpDir("custom-worktree");
  const cache = tmpDir("custom-cache");
  writeFileSync(join(worktree, "pyproject.toml"), "[project]\nname='fixture'\n");
  const config: ProjectConfig = {
    setupCommand: { command: "python3", args: ["-m", "venv", "path with spaces/.venv"] },
  };
  let customRuns = 0;
  const fake = fakeManager(cache, {
    onCustom: async () => { customRuns += 1; },
  });
  await fake.manager.ensureDeps(project(primary, config), worktree);
  await fake.manager.ensureDeps(project(primary, config), worktree);

  const custom = fake.calls.find((call) => call.command === "python3");
  assert.deepEqual(custom?.args, ["-m", "venv", "path with spaces/.venv"]);
  assert.equal(custom?.timeoutMs, 10 * 60 * 1000);
  assert.equal(customRuns, 1);
  assert.ok(readFileSync(join(worktree, ".hoopedorc-setup-hash"), "utf8").trim());
});

test("B38: custom setup cancellation aborts promptly without publishing a success marker", async () => {
  const primary = tmpDir("cancel-primary");
  const worktree = tmpDir("cancel-worktree");
  const cache = tmpDir("cancel-cache");
  const config: ProjectConfig = {
    setupCommand: { command: "special-sdk", args: ["prepare"] },
  };
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => { started = resolve; });
  const fake = fakeManager(cache, {
    onCustom: (request) => new Promise<void>((_resolve, reject) => {
      started();
      request.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("The operation was aborted", "AbortError")),
        { once: true },
      );
    }),
  });
  const controller = new AbortController();
  const running = fake.manager.ensureDeps(project(primary, config), worktree, controller.signal);
  await didStart;
  controller.abort();
  await assert.rejects(running, { name: "AbortError" });
  assert.equal(existsSync(join(worktree, ".hoopedorc-setup-hash")), false);
});

test("B38: an Apple setup cannot pretend to run on a Linux/EC2 host", async () => {
  const primary = tmpDir("apple-primary");
  const worktree = tmpDir("apple-worktree");
  const cache = tmpDir("apple-cache");
  mkdirSync(join(worktree, "App.xcodeproj"));
  const config: ProjectConfig = {
    setupCommand: { command: "xcodebuild", args: ["-resolvePackageDependencies"] },
  };
  const fake = fakeManager(cache, { hostPlatform: "linux" });
  await assert.rejects(
    fake.manager.ensureDeps(project(primary, config), worktree),
    /requires an Apple\/Xcode toolchain.*macOS Hoopedorc instance.*linux/i,
  );
  assert.equal(fake.calls.length, 0);
});

test("B38/B33: primaryDirtyFiles reports manifest dirt now that setup never writes the primary clone", async () => {
  const primary = tmpDir("wt-primary-dirty");
  await git(["init", "-q"], primary);
  writeFileSync(join(primary, "package.json"), JSON.stringify({ name: "x" }));
  writeFileSync(join(primary, "README.md"), "# hello\n");
  await git(["add", "-A"], primary);
  await git(["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", "init"], primary);

  const runner = new WorktreeManagerImpl({ sandboxGates: "off" });

  // Clean working tree: nothing to report.
  assert.deepEqual(await runner.primaryDirtyFiles(project(primary)), []);

  // B38 removed the manifest copy, so package metadata dirt is now evidence
  // that an agent wrote into the wrong checkout and must be reported.
  writeFileSync(join(primary, "package.json"), JSON.stringify({ name: "x", version: "2.0.0" }));
  writeFileSync(join(primary, "package-lock.json"), "{}");
  assert.deepEqual((await runner.primaryDirtyFiles(project(primary))).sort(), [
    "package-lock.json",
    "package.json",
  ]);

  // A file an agent should never have touched here — this IS the signal.
  writeFileSync(join(primary, "src-oops.ts"), "// written to the wrong place\n");
  const dirty = await runner.primaryDirtyFiles(project(primary));
  assert.deepEqual(dirty.sort(), ["package-lock.json", "package.json", "src-oops.ts"]);
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
