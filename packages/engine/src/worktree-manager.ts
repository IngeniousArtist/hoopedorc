import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { minimatch } from "minimatch";
import { abortableDelay, execManagedProcess, sanitizedEnv } from "@orc/adapters";
import type { Project, Settings, Task } from "@orc/types";
import type { GitAcquisition, WorktreeManager } from "./index.js";
import {
  DEFAULT_GATE_IMAGE,
  resolveSandboxMode,
  sandboxedExecFile,
  SANDBOX_TIMEOUT_GRACE_MS,
} from "./sandbox.js";

const DEPS_MAX_BUFFER = 32 * 1024 * 1024;
const MAX_SAFETY_DIFF_BYTES = 16 * 1024 * 1024;
const MAX_STATUS_BYTES = 8 * 1024 * 1024;

// Argument arrays only, never a shell — otherwise project.defaultBranch and
// task.branch (both derived from HTTP-supplied fields) could smuggle shell
// metacharacters into a command. See git-service.ts for the same pattern.
async function git(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  const { stdout } = await execManagedProcess("git", args, {
    cwd,
    signal,
    maxOutputBytes: 64 * 1024 * 1024,
  });
  return stdout;
}

function acquisitionFailure<T>(err: unknown, value: T): GitAcquisition<T> {
  const processError = err as {
    stdout?: string;
    stderr?: string;
    message?: string;
    outputLimitExceeded?: boolean;
  };
  const captured = processError.stdout ?? "";
  return {
    ok: false,
    value,
    error:
      processError.stderr?.trim() ||
      processError.message ||
      "git inspection failed",
    byteCount: Buffer.byteLength(captured),
    truncated: processError.outputLimitExceeded === true,
  };
}

function acquisitionSuccess<T>(value: T, output = ""): GitAcquisition<T> {
  return {
    ok: true,
    value,
    byteCount: Buffer.byteLength(output),
    truncated: false,
  };
}

export type NodePackageManager = "npm" | "pnpm" | "yarn" | "bun";

const MANAGER_LOCKFILES: Record<NodePackageManager, string[]> = {
  npm: ["package-lock.json"],
  pnpm: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock"],
  bun: ["bun.lock", "bun.lockb"],
};
const ALL_LOCKFILES = Object.values(MANAGER_LOCKFILES).flat();
const SETUP_MANIFESTS = new Set([
  "Package.swift",
  "Package.resolved",
  "Podfile",
  "Podfile.lock",
  "requirements.txt",
  "pyproject.toml",
  "poetry.lock",
  "Pipfile",
  "Pipfile.lock",
  "Cargo.toml",
  "Cargo.lock",
  "global.json",
  "packages.lock.json",
]);
const DEPENDENCY_ARTIFACTS = [
  ".pnp.cjs",
  ".pnp.loader.mjs",
  ".yarn/cache",
  ".yarn/unplugged",
  ".yarn/install-state.gz",
] as const;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 20_000;
const installLocks = new Map<string, Promise<void>>();

export interface NodeDependencyPlan {
  manager: NodePackageManager;
  declaredVersion?: string;
  lockfile: string;
  inputs: string[];
}

export interface NodeRuntimeIdentity {
  nodeVersion: string;
  platform: string;
  arch: string;
}

export interface SetupProcessRequest {
  project: Project;
  cwd: string;
  command: string;
  args: string[];
  signal?: AbortSignal;
  timeoutMs: number;
  useSandbox: boolean;
}

export interface WorktreeSetupDeps {
  resolveMode?: typeof resolveSandboxMode;
  execute?: (request: SetupProcessRequest) => Promise<{ stdout: string; stderr?: string }>;
  cacheRoot?: (project: Project) => string;
  hostPlatform?: NodeJS.Platform;
  hostArch?: string;
}

export class ProjectSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectSetupError";
  }
}

function slash(path: string): string {
  return path.split(sep).join("/");
}

/** Generated install outputs worth caching. Workspace-local node_modules
 * directories matter for npm/pnpm monorepos, so discover them without
 * descending into dependency trees; the fixed entries cover Yarn PnP. */
function dependencyArtifacts(root: string): string[] {
  const artifacts: string[] = DEPENDENCY_ARTIFACTS.filter((path) =>
    existsSync(join(root, path)),
  );
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === ".git" || entry.name === ".yarn") continue;
      const path = join(dir, entry.name);
      if (entry.name === "node_modules") {
        artifacts.push(slash(relative(root, path)));
      } else {
        visit(path);
      }
    }
  };
  visit(root);
  return [...new Set(artifacts)].sort((a, b) => a.localeCompare(b));
}

function validArtifactPath(root: string, artifact: unknown): artifact is string {
  if (typeof artifact !== "string" || artifact.length === 0 || isAbsolute(artifact)) return false;
  const rel = relative(root, resolve(root, artifact));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function walkFiles(root: string, wanted: (name: string) => boolean): string[] {
  const found: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && wanted(entry.name)) found.push(path);
    }
  };
  visit(root);
  return found.sort((a, b) => slash(relative(root, a)).localeCompare(slash(relative(root, b))));
}

function readPackageJson(root: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;
  } catch (err) {
    throw new ProjectSetupError(
      `package.json is not valid JSON: ${(err as Error).message}`,
    );
  }
}

const NODE_DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "bundleDependencies",
  "bundledDependencies",
] as const;

function hasDeclaredNodeDependencies(root: string): boolean {
  for (const path of walkFiles(root, (name) => name === "package.json")) {
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch (err) {
      throw new ProjectSetupError(
        `${slash(relative(root, path))} is not valid JSON: ${(err as Error).message}`,
      );
    }
    for (const field of NODE_DEPENDENCY_FIELDS) {
      const value = pkg[field];
      if (Array.isArray(value) && value.length > 0) return true;
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).length > 0
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Resolve one reproducible Node install strategy from packageManager first,
 * then from exactly one supported root lockfile. */
export function inspectNodeDependencies(root: string): NodeDependencyPlan | null {
  if (!existsSync(join(root, "package.json"))) return null;
  const pkg = readPackageJson(root);
  const declared = pkg.packageManager;
  let manager: NodePackageManager | undefined;
  let declaredVersion: string | undefined;

  if (declared !== undefined) {
    if (typeof declared !== "string") {
      throw new ProjectSetupError("package.json packageManager must be a string such as pnpm@9.15.0");
    }
    const match = /^(npm|pnpm|yarn|bun)@([^+\s]+)(?:\+.*)?$/.exec(declared.trim());
    if (!match) {
      throw new ProjectSetupError(
        `Unsupported packageManager ${JSON.stringify(declared)}; use npm, pnpm, yarn, or bun with an explicit version`,
      );
    }
    manager = match[1] as NodePackageManager;
    declaredVersion = match[2];
  }

  const present = ALL_LOCKFILES.filter((name) => existsSync(join(root, name)));
  if (!manager) {
    const managers = (Object.keys(MANAGER_LOCKFILES) as NodePackageManager[]).filter((candidate) =>
      MANAGER_LOCKFILES[candidate].some((name) => present.includes(name)),
    );
    if (managers.length === 0) {
      // New repositories are seeded with a dependency-free package.json so
      // the first author can scaffold the real app. There is nothing to
      // install yet, and requiring a lockfile here deadlocks that scaffold
      // task before it can create one. As soon as any workspace manifest
      // declares a dependency, the reproducible-lock requirement below
      // applies normally.
      if (!hasDeclaredNodeDependencies(root)) return null;
      throw new ProjectSetupError(
        "No supported lockfile found; commit package-lock.json, pnpm-lock.yaml, yarn.lock, bun.lock, or bun.lockb for reproducible setup",
      );
    }
    if (managers.length > 1) {
      throw new ProjectSetupError(
        `Ambiguous Node lockfiles (${present.join(", ")}); set package.json packageManager to npm, pnpm, yarn, or bun`,
      );
    }
    manager = managers[0];
  }

  if (!manager) throw new ProjectSetupError("Could not select a Node package manager");
  const selectedManager = manager;
  const matchingLocks = MANAGER_LOCKFILES[selectedManager].filter((name) => present.includes(name));
  if (matchingLocks.length === 0) {
    throw new ProjectSetupError(
      `packageManager selects ${selectedManager}, but its lockfile is missing (${MANAGER_LOCKFILES[selectedManager].join(" or ")})`,
    );
  }
  if (matchingLocks.length > 1) {
    throw new ProjectSetupError(
      `Multiple ${selectedManager} lockfiles are present (${matchingLocks.join(", ")}); keep exactly one`,
    );
  }

  const lockfile = matchingLocks[0];
  if (!lockfile) throw new ProjectSetupError(`Could not select a ${selectedManager} lockfile`);
  const inputs = walkFiles(root, (name) => name === "package.json");
  inputs.push(join(root, lockfile));
  inputs.sort((a, b) => slash(relative(root, a)).localeCompare(slash(relative(root, b))));
  return { manager: selectedManager, declaredVersion, lockfile, inputs };
}

export function frozenInstallArgs(manager: NodePackageManager, version: string): string[] {
  if (manager === "npm") return ["ci"];
  if (manager === "pnpm") return ["install", "--frozen-lockfile"];
  if (manager === "bun") return ["install", "--frozen-lockfile"];
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  return major >= 2
    ? ["install", "--immutable"]
    : ["install", "--frozen-lockfile"];
}

export function nodeDependencyFingerprint(
  root: string,
  plan: NodeDependencyPlan,
  managerVersion: string,
  runtime: NodeRuntimeIdentity,
): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({
    manager: plan.manager,
    declaredVersion: plan.declaredVersion ?? null,
    managerVersion,
    ...runtime,
  }));
  for (const path of plan.inputs) {
    hash.update("\0");
    hash.update(slash(relative(root, path)));
    hash.update("\0");
    hash.update(readFileSync(path));
  }
  return hash.digest("hex");
}

export function dependencyCacheRoot(project: Project): string {
  return `${project.localPath}-hoopedorc-deps`;
}

function waitForSharedInstall(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolvePromise, reject) => {
    const onAbort = () => reject(new DOMException("The operation was aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise();
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function executableOnHost(command: string, cwd: string): boolean {
  const candidates = command.includes("/") || command.includes("\\")
    ? [isAbsolute(command) ? command : resolve(cwd, command)]
    : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, command));
  return candidates.some((path) => {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function containsAppleProject(root: string, setupCommand?: string): boolean {
  const command = setupCommand ? basename(setupCommand).toLowerCase() : "";
  if (command === "xcodebuild" || command === "pod") return true;
  const visit = (dir: string): boolean => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      if (entry.name.endsWith(".xcodeproj") || entry.name.endsWith(".xcworkspace")) return true;
      if (entry.isDirectory() && visit(join(dir, entry.name))) return true;
    }
    return false;
  };
  return visit(root);
}

// Things the orchestrator (or an agent) generates that must never get staged by
// `git add -A` and committed into a task's PR — most importantly the materialized
// dependency artifacts placed into every worktree for authors and gates.
const GIT_EXCLUDE_ENTRIES = [
  "node_modules",
  ".pnp.cjs",
  ".pnp.loader.mjs",
  ".yarn/cache",
  ".yarn/unplugged",
  ".yarn/install-state.gz",
  ".hoopedorc-setup-hash",
];

export class WorktreeManagerImpl implements WorktreeManager {
  constructor(
    // Narrowed to just the one field this class reads — see the same choice
    // on GateRunnerImpl in gate-runner.ts.
    private readonly settings?: Pick<Settings, "sandboxGates">,
    private readonly setupDeps: WorktreeSetupDeps = {},
  ) {}

  async create(
    project: Project,
    task: Task,
    signal?: AbortSignal,
  ): Promise<{ branch: string; path: string }> {
    const branch = `orc/${task.id}`;
    const path = `${project.localPath}-wt-${task.id}`;

    // Always branch off the latest remote default branch, not the primary
    // clone's local HEAD. Sibling tasks merge to origin throughout a run, and
    // the primary clone is never fast-forwarded in between — branching off a
    // stale local HEAD makes a new task invisible to work that already
    // landed, which is how independent tasks end up colliding on the same
    // files (see e.g. two tasks both creating index.html from scratch).
    await git(["fetch", "origin", project.defaultBranch], project.localPath, signal);

    // Defense in depth: the branch name is deterministic (orc/<taskId>), so a
    // retried task reuses it. If a prior attempt already pushed to and opened
    // a PR on this branch, the remote ref has history this fresh local branch
    // doesn't — pushing later would be rejected as non-fast-forward, failing
    // every retry regardless of model. The retry endpoint clears the task's
    // prNumber/branch so a fresh PR gets opened; deleting the stale remote
    // branch here (best-effort — fine if it doesn't exist) lets that PR's old
    // branch go away cleanly instead of blocking the new push.
    try {
      await git(["push", "origin", "--delete", branch], project.localPath, signal);
    } catch {
      signal?.throwIfAborted();
      /* no remote branch by this name — the common case */
    }

    // Defense in depth, local side: `remove()` (called from executeTask's
    // finally) only runs if the process stays alive long enough to reach it.
    // If the server itself dies mid-task — crash, manual kill, a dev-server
    // reload — the worktree directory is orphaned on disk with nothing to
    // ever clean it up, and `git worktree add` fails outright with "already
    // exists" on every subsequent dispatch of this same task, forever.
    try {
      await git(["worktree", "remove", path, "--force"], project.localPath, signal);
    } catch {
      signal?.throwIfAborted();
      /* not a registered worktree — fall through to the raw rmSync below */
    }
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      /* path didn't exist — the common case */
    }
    try {
      await git(["worktree", "prune"], project.localPath, signal);
    } catch {
      signal?.throwIfAborted();
      /* best effort */
    }
    try {
      await git(["branch", "-D", branch], project.localPath, signal);
    } catch {
      signal?.throwIfAborted();
      /* branch may not exist locally — the common case */
    }

    try {
      await git(
        ["worktree", "add", path, "-b", branch, `origin/${project.defaultBranch}`],
        project.localPath,
        signal,
      );

      // MUST run before ensureDeps materializes dependency artifacts, and before
      // the agent's `git add -A`: otherwise node_modules can get committed into the
      // task's PR and the inScope gate fails it as an out-of-scope change. This
      // is the local safety net; new repos also get a committed .gitignore.
      await this.ensureGitExclude(path, signal);
      await this.ensureDeps(project, path, signal);
    } catch (err) {
      // create() has not returned yet, so the task does not carry the path
      // that executeTask's finally normally removes. This includes B38's hard
      // setup failures as well as cancellation; clean every partial worktree
      // here, and never reuse an aborted signal for cleanup.
      await git(["worktree", "remove", path, "--force"], project.localPath).catch(
        () => {},
      );
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
      await git(["branch", "-D", branch], project.localPath).catch(() => {});
      throw err;
    }

    return { branch, path };
  }

  /**
   * Append node_modules (etc.) to git's local exclude so `git add -A` in a
   * worktree never stages materialized deps. Uses `info/exclude` (shared
   * across all worktrees via the common git dir, never committed) so it works
   * even for older projects whose repo has no .gitignore.
   */
  private async ensureGitExclude(cwd: string, signal?: AbortSignal): Promise<void> {
    try {
      const rel = (
        await git(["rev-parse", "--git-path", "info/exclude"], cwd, signal)
      ).trim();
      const abs = isAbsolute(rel) ? rel : join(cwd, rel);

      let content = "";
      try {
        content = readFileSync(abs, "utf-8");
      } catch {
        /* no exclude file yet */
      }
      const have = new Set(content.split("\n").map((l) => l.trim()));
      const missing = GIT_EXCLUDE_ENTRIES.filter((e) => !have.has(e));
      if (missing.length === 0) return;

      mkdirSync(dirname(abs), { recursive: true });
      const prefix = content && !content.endsWith("\n") ? content + "\n" : content;
      writeFileSync(abs, prefix + missing.join("\n") + "\n");
    } catch (err) {
      if (signal?.aborted) throw err;
      /* best effort */
    }
  }

  private async executeSetup(request: SetupProcessRequest): Promise<{ stdout: string; stderr?: string }> {
    if (this.setupDeps.execute) return this.setupDeps.execute(request);
    if (request.useSandbox) {
      return sandboxedExecFile(
        request.project.config?.gateImage || DEFAULT_GATE_IMAGE,
        request.cwd,
        request.command,
        request.args,
        {
          timeout: request.timeoutMs + SANDBOX_TIMEOUT_GRACE_MS,
          maxBuffer: DEPS_MAX_BUFFER,
          signal: request.signal,
        },
      );
    }
    return execManagedProcess(request.command, request.args, {
      cwd: request.cwd,
      signal: request.signal,
      timeoutMs: request.timeoutMs,
      maxOutputBytes: DEPS_MAX_BUFFER,
      env: sanitizedEnv({ PWD: request.cwd }),
    });
  }

  private async resolveSetupMode(
    project: Project,
    appleToolchain = false,
    signal?: AbortSignal,
  ): Promise<boolean> {
    signal?.throwIfAborted();
    const platform = this.setupDeps.hostPlatform ?? process.platform;
    if (appleToolchain && platform !== "darwin") {
      throw new ProjectSetupError(
        `Project "${project.name}" requires an Apple/Xcode toolchain; run it on a macOS Hoopedorc instance (this host is ${platform})`,
      );
    }
    const resolved = await (this.setupDeps.resolveMode ?? resolveSandboxMode)(
      this.settings?.sandboxGates,
    );
    signal?.throwIfAborted();
    if (!appleToolchain || !resolved.useSandbox) return resolved.useSandbox;
    if (this.settings?.sandboxGates === "required") {
      throw new ProjectSetupError(
        `Project "${project.name}" requires the macOS host toolchain, but sandboxGates is "required"; use a Mac instance and set gate sandboxing to off or auto`,
      );
    }
    // Docker Desktop still supplies a Linux container. Apple projects must
    // use the real Mac toolchain even when auto mode detects Docker.
    return false;
  }

  private async nodeRuntime(
    project: Project,
    cwd: string,
    useSandbox: boolean,
    signal?: AbortSignal,
  ): Promise<NodeRuntimeIdentity> {
    try {
      const result = await this.executeSetup({
        project,
        cwd,
        command: "node",
        args: ["-p", "JSON.stringify({nodeVersion:process.version,platform:process.platform,arch:process.arch})"],
        signal,
        timeoutMs: PROBE_TIMEOUT_MS,
        useSandbox,
      });
      const parsed = JSON.parse(result.stdout.trim()) as NodeRuntimeIdentity;
      if (!parsed.nodeVersion || !parsed.platform || !parsed.arch) throw new Error("incomplete output");
      return parsed;
    } catch (err) {
      signal?.throwIfAborted();
      const where = useSandbox
        ? `Docker image ${project.config?.gateImage || DEFAULT_GATE_IMAGE}`
        : "the Hoopedorc host";
      throw new ProjectSetupError(
        `Node.js is unavailable in ${where}; install Node there or select an image that contains it (${(err as Error).message})`,
      );
    }
  }

  private async managerVersion(
    project: Project,
    cwd: string,
    manager: NodePackageManager,
    useSandbox: boolean,
    signal?: AbortSignal,
  ): Promise<string> {
    try {
      const result = await this.executeSetup({
        project,
        cwd,
        command: manager,
        args: ["--version"],
        signal,
        timeoutMs: PROBE_TIMEOUT_MS,
        useSandbox,
      });
      const version = result.stdout.trim().split("\n")[0]?.trim();
      if (!version) throw new Error("version command returned no output");
      return version;
    } catch (err) {
      signal?.throwIfAborted();
      const where = useSandbox
        ? `Docker image ${project.config?.gateImage || DEFAULT_GATE_IMAGE}`
        : "the Hoopedorc host PATH";
      throw new ProjectSetupError(
        `Project "${project.name}" selects ${manager}, but the ${manager} binary is unavailable in ${where}. Install ${manager} there or update package.json packageManager / the lockfile (${(err as Error).message})`,
      );
    }
  }

  private cacheMetadata(path: string): { fingerprint?: string; artifacts?: string[] } | null {
    try {
      return JSON.parse(
        readFileSync(join(path, ".hoopedorc-deps.json"), "utf8"),
      ) as { fingerprint?: string; artifacts?: string[] };
    } catch {
      return null;
    }
  }

  private cacheReady(path: string, fingerprint: string): boolean {
    const metadata = this.cacheMetadata(path);
    return metadata?.fingerprint === fingerprint &&
      Array.isArray(metadata.artifacts) &&
      metadata.artifacts.length > 0 &&
      metadata.artifacts.every((artifact) =>
        validArtifactPath(path, artifact) && existsSync(join(path, artifact))
      );
  }

  private async withFileInstallLock(
    finalPath: string,
    fingerprint: string,
    signal: AbortSignal | undefined,
    install: () => Promise<void>,
  ): Promise<void> {
    const lockPath = `${finalPath}.lock`;
    mkdirSync(dirname(finalPath), { recursive: true });
    for (;;) {
      signal?.throwIfAborted();
      if (this.cacheReady(finalPath, fingerprint)) return;
      try {
        mkdirSync(lockPath);
        writeFileSync(
          join(lockPath, "owner.json"),
          JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
        );
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw err;
        let stale = false;
        try {
          const owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")) as {
            pid?: number;
            createdAt?: number;
          };
          if (owner.pid && owner.pid !== process.pid) {
            try {
              process.kill(owner.pid, 0);
            } catch (probeError) {
              stale = (probeError as NodeJS.ErrnoException).code === "ESRCH";
            }
          }
          stale ||= Date.now() - (owner.createdAt ?? statSync(lockPath).mtimeMs) >
            INSTALL_TIMEOUT_MS + SANDBOX_TIMEOUT_GRACE_MS * 2;
        } catch {
          try {
            stale = Date.now() - statSync(lockPath).mtimeMs > PROBE_TIMEOUT_MS;
          } catch {
            continue; // lock disappeared between probes; retry acquisition
          }
        }
        if (stale) {
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
        await abortableDelay(100, signal);
      }
    }
    try {
      await install();
    } finally {
      rmSync(lockPath, { recursive: true, force: true });
    }
  }

  private async publishDependencyCache(
    project: Project,
    worktreePath: string,
    plan: NodeDependencyPlan,
    managerVersion: string,
    runtime: NodeRuntimeIdentity,
    fingerprint: string,
    finalPath: string,
    useSandbox: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.cacheReady(finalPath, fingerprint)) return;
    if (existsSync(finalPath)) rmSync(finalPath, { recursive: true, force: true });

    const root = dirname(finalPath);
    mkdirSync(root, { recursive: true });
    const installRoot = mkdtempSync(join(root, `.install-${fingerprint.slice(0, 12)}-`));
    const publishRoot = mkdtempSync(join(root, `.publish-${fingerprint.slice(0, 12)}-`));
    try {
      cpSync(worktreePath, installRoot, {
        recursive: true,
        filter: (source) => {
          const rel = relative(worktreePath, source);
          if (!rel) return true;
          const segments = rel.split(sep);
          return !segments.includes(".git") &&
            !segments.includes("node_modules") &&
            !segments.includes(".hoopedorc-setup-hash");
        },
      });
      await this.executeSetup({
        project,
        cwd: installRoot,
        command: plan.manager,
        args: frozenInstallArgs(plan.manager, managerVersion),
        signal,
        timeoutMs: INSTALL_TIMEOUT_MS,
        useSandbox,
      });
      signal?.throwIfAborted();
      const artifacts = dependencyArtifacts(installRoot);
      for (const artifact of artifacts) {
        const source = join(installRoot, artifact);
        const destination = join(publishRoot, artifact);
        mkdirSync(dirname(destination), { recursive: true });
        renameSync(source, destination);
      }
      // A valid empty dependency graph may leave no install artifact. Keep an
      // empty node_modules template so the successful fingerprint is still
      // cacheable and future worktrees do not reinstall forever.
      if (artifacts.length === 0) {
        mkdirSync(join(publishRoot, "node_modules"), { recursive: true });
        artifacts.push("node_modules");
      }
      writeFileSync(
        join(publishRoot, ".hoopedorc-deps.json"),
        JSON.stringify({
          fingerprint,
          manager: plan.manager,
          declaredVersion: plan.declaredVersion ?? null,
          managerVersion,
          lockfile: plan.lockfile,
          runtime,
          artifacts,
          inputs: plan.inputs.map((path) => slash(relative(worktreePath, path))),
          createdAt: new Date().toISOString(),
        }, null, 2),
      );
      try {
        renameSync(publishRoot, finalPath);
      } catch (err) {
        // Another process may have won the same atomic publish. Its entry is
        // reusable only when the metadata proves it is the exact same cache.
        if (!this.cacheReady(finalPath, fingerprint)) throw err;
      }
    } finally {
      if (existsSync(installRoot)) rmSync(installRoot, { recursive: true, force: true });
      if (existsSync(publishRoot)) rmSync(publishRoot, { recursive: true, force: true });
    }
  }

  private materializeDependencyCache(worktreePath: string, cachePath: string): void {
    const metadata = this.cacheMetadata(cachePath);
    if (
      !metadata?.artifacts?.length ||
      !metadata.artifacts.every((artifact) => validArtifactPath(cachePath, artifact))
    ) {
      throw new ProjectSetupError(`Dependency cache ${cachePath} has no published artifacts`);
    }
    const staging = mkdtempSync(join(dirname(worktreePath), ".hoopedorc-materialize-"));
    try {
      for (const artifact of metadata.artifacts) {
        const destination = join(staging, artifact);
        mkdirSync(dirname(destination), { recursive: true });
        cpSync(join(cachePath, artifact), destination, {
          recursive: true,
          verbatimSymlinks: true,
        });
      }
      for (const artifact of metadata.artifacts) {
        const destination = join(worktreePath, artifact);
        try {
          lstatSync(destination);
          rmSync(destination, { recursive: true, force: true });
        } catch {
          /* artifact is absent in this fresh worktree */
        }
        mkdirSync(dirname(destination), { recursive: true });
        renameSync(join(staging, artifact), destination);
      }
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  private async ensureNodeDeps(
    project: Project,
    worktreePath: string,
    plan: NodeDependencyPlan,
    signal?: AbortSignal,
  ): Promise<string> {
    const useSandbox = await this.resolveSetupMode(project, false, signal);
    const runtime = await this.nodeRuntime(project, worktreePath, useSandbox, signal);
    const version = await this.managerVersion(
      project,
      worktreePath,
      plan.manager,
      useSandbox,
      signal,
    );
    const fingerprint = nodeDependencyFingerprint(worktreePath, plan, version, runtime);
    const cacheRoot = (this.setupDeps.cacheRoot ?? dependencyCacheRoot)(project);
    const finalPath = join(cacheRoot, fingerprint);

    let pending = installLocks.get(finalPath);
    if (!pending) {
      pending = this.withFileInstallLock(finalPath, fingerprint, signal, () =>
        this.publishDependencyCache(
          project,
          worktreePath,
          plan,
          version,
          runtime,
          fingerprint,
          finalPath,
          useSandbox,
          signal,
        ),
      ).finally(() => {
        if (installLocks.get(finalPath) === pending) installLocks.delete(finalPath);
      });
      installLocks.set(finalPath, pending);
    }
    try {
      await waitForSharedInstall(pending, signal);
    } catch (err) {
      signal?.throwIfAborted();
      if (err instanceof ProjectSetupError) throw err;
      throw new ProjectSetupError(
        `${plan.manager} frozen install failed for project "${project.name}"; no dependency cache was published. Fix the lockfile/tooling error and retry: ${(err as Error).message}`,
      );
    }
    this.materializeDependencyCache(worktreePath, finalPath);
    return `${plan.manager}@${version} (${plan.lockfile}; ${runtime.nodeVersion} ${runtime.platform}/${runtime.arch})`;
  }

  private customSetupFingerprint(project: Project, worktreePath: string): string {
    const setup = project.config?.setupCommand;
    if (!setup) return "";
    const hash = createHash("sha256");
    hash.update(JSON.stringify({
      command: setup.command,
      args: setup.args,
      platform: this.setupDeps.hostPlatform ?? process.platform,
      arch: this.setupDeps.hostArch ?? process.arch,
      sandbox: this.settings?.sandboxGates ?? "auto",
      image: project.config?.gateImage ?? DEFAULT_GATE_IMAGE,
    }));
    const inputs = walkFiles(
      worktreePath,
      (name) => SETUP_MANIFESTS.has(name) || name.endsWith(".csproj") || name.endsWith(".fsproj"),
    );
    for (const path of inputs) {
      hash.update("\0");
      hash.update(slash(relative(worktreePath, path)));
      hash.update("\0");
      hash.update(readFileSync(path));
    }
    return hash.digest("hex");
  }

  private async ensureCustomSetup(
    project: Project,
    worktreePath: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const setup = project.config?.setupCommand;
    if (!setup) return null;
    const fingerprint = this.customSetupFingerprint(project, worktreePath);
    const marker = join(worktreePath, ".hoopedorc-setup-hash");
    if (existsSync(marker) && readFileSync(marker, "utf8").trim() === fingerprint) {
      return `${setup.command} (cached for this worktree)`;
    }
    const appleToolchain = containsAppleProject(worktreePath, setup.command);
    const useSandbox = await this.resolveSetupMode(
      project,
      appleToolchain,
      signal,
    );
    try {
      await this.executeSetup({
        project,
        cwd: worktreePath,
        command: setup.command,
        args: [...setup.args],
        signal,
        timeoutMs: INSTALL_TIMEOUT_MS,
        useSandbox,
      });
    } catch (err) {
      signal?.throwIfAborted();
      throw new ProjectSetupError(
        `Project setup command ${JSON.stringify(setup.command)} failed. Install the required tool on the Hoopedorc host or in ${project.config?.gateImage || DEFAULT_GATE_IMAGE}, then retry: ${(err as Error).message}`,
      );
    }
    signal?.throwIfAborted();
    writeFileSync(marker, `${fingerprint}\n`);
    return `${setup.command} ${setup.args.join(" ")}`.trim();
  }

  /** Prepare reproducible Node dependencies plus the project's optional,
   * structured non-Node setup command. Failures are hard, actionable setup
   * failures: an unpublished/partial cache is never treated as usable. */
  private async ensureDeps(
    project: Project,
    worktreePath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    if (containsAppleProject(worktreePath, project.config?.setupCommand?.command)) {
      await this.resolveSetupMode(project, true, signal);
    }
    const plan = inspectNodeDependencies(worktreePath);
    if (plan) await this.ensureNodeDeps(project, worktreePath, plan, signal);
    await this.ensureCustomSetup(project, worktreePath, signal);
  }

  /** Project-aware Setup & Health line. It resolves the same package manager,
   * runtime, sandbox, and Apple-host policy used by real task preparation. */
  async setupHealth(
    project: Project,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; detail: string }> {
    try {
      signal?.throwIfAborted();
      if (!existsSync(project.localPath)) {
        throw new ProjectSetupError(`local clone not found at ${project.localPath}`);
      }
      const details: string[] = [];
      const setup = project.config?.setupCommand;
      const apple = containsAppleProject(project.localPath, setup?.command);
      if (apple) {
        await this.resolveSetupMode(project, true, signal);
        details.push("Apple/Xcode project — macOS host toolchain");
      }
      const plan = inspectNodeDependencies(project.localPath);
      if (plan) {
        const useSandbox = await this.resolveSetupMode(project, false, signal);
        const runtime = await this.nodeRuntime(
          project,
          project.localPath,
          useSandbox,
          signal,
        );
        const version = await this.managerVersion(
          project,
          project.localPath,
          plan.manager,
          useSandbox,
          signal,
        );
        details.push(`${plan.manager}@${version} via ${plan.lockfile} (${runtime.nodeVersion} ${runtime.platform}/${runtime.arch})`);
      }
      if (setup) {
        const useSandbox = await this.resolveSetupMode(project, apple, signal);
        if (useSandbox) {
          try {
            await this.executeSetup({
              project,
              cwd: project.localPath,
              command: "sh",
              args: ["-c", 'command -v "$1" >/dev/null 2>&1', "hoopedorc", setup.command],
              signal,
              timeoutMs: PROBE_TIMEOUT_MS,
              useSandbox: true,
            });
          } catch {
            throw new ProjectSetupError(
              `setup command ${JSON.stringify(setup.command)} was not found in Docker image ${project.config?.gateImage || DEFAULT_GATE_IMAGE}; install it in that image or change the project image`,
            );
          }
        } else if (!executableOnHost(setup.command, project.localPath)) {
          throw new ProjectSetupError(
            `setup command ${JSON.stringify(setup.command)} was not found on the host PATH; install it or configure a gate image that contains it`,
          );
        }
        details.push(
          `custom: ${setup.command} ${setup.args.join(" ")} (${useSandbox ? `docker ${project.config?.gateImage || DEFAULT_GATE_IMAGE}` : "host"})`.trim(),
        );
      }
      return {
        ok: true,
        detail: details.length > 0 ? details.join("; ") : "no Node lockfile or custom setup command — nothing to prepare",
      };
    } catch (err) {
      signal?.throwIfAborted();
      return { ok: false, detail: (err as Error).message };
    }
  }

  async remove(project: Project, task: Task): Promise<void> {
    const path = task.worktreePath;
    const branch = task.branch;
    if (!path || !branch) return;

    try {
      await git(["worktree", "remove", path, "--force"], project.localPath);
    } catch {
      /* worktree may already be gone */
    }

    try {
      await git(["branch", "-D", branch], project.localPath);
    } catch {
      /* branch may already be deleted */
    }
  }

  async prepareForGates(
    project: Project,
    task: Task,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!task.worktreePath) throw new Error("no worktree path set");
    await this.ensureGitExclude(task.worktreePath, signal);
    await this.ensureDeps(project, task.worktreePath, signal);
  }

  async changedFiles(project: Project, task: Task): Promise<string[]> {
    const worktreePath = task.worktreePath;
    if (!worktreePath) return [];
    // Three-dot diff (merge-base...HEAD) — only THIS branch's own changes.
    // The two-dot form (origin/main HEAD) also reports files that advanced on
    // main since this worktree was created, so when a sibling task merges
    // mid-run those files leak into this task's "changed" set and the inScope
    // gate fails it for files it never touched.
    const output = await git(
      ["diff", "--name-only", `origin/${project.defaultBranch}...HEAD`],
      worktreePath,
    );
    return output
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
  }

  async changedFilesInScope(project: Project, task: Task): Promise<boolean> {
    if (!task.worktreePath) return false;
    if (task.scopePaths.length === 0) return true;

    let changed: string[];
    try {
      changed = await this.changedFiles(project, task);
    } catch {
      return false;
    }
    if (changed.length === 0) return true;

    return changed.every((file) =>
      task.scopePaths.some((pattern) => minimatch(file, pattern, { dot: true })),
    );
  }

  async revertOutOfScope(task: Task, allowedPatterns: string[]): Promise<string[]> {
    const worktreePath = task.worktreePath;
    if (!worktreePath) return [];

    // `git diff --name-only HEAD` catches both staged and unstaged changes to
    // already-tracked files; `ls-files --others` catches brand-new files
    // (e.g. a freshly created CHANGELOG.md) that diff-against-HEAD can't see
    // since they aren't tracked yet.
    const [modifiedOut, untrackedOut] = await Promise.all([
      git(["diff", "--name-only", "HEAD"], worktreePath).catch(() => ""),
      git(["ls-files", "--others", "--exclude-standard"], worktreePath).catch(() => ""),
    ]);
    const modified = modifiedOut.split("\n").map((f) => f.trim()).filter(Boolean);
    const untracked = untrackedOut.split("\n").map((f) => f.trim()).filter(Boolean);

    const isAllowed = (f: string) =>
      allowedPatterns.some((p) => minimatch(f, p, { dot: true }));

    const revertModified = modified.filter((f) => !isAllowed(f));
    const revertUntracked = untracked.filter((f) => !isAllowed(f));

    if (revertModified.length > 0) {
      // Restores tracked files (including deletions) to their last-committed
      // content — `checkout --` can't touch untracked paths, hence the
      // separate branch below.
      await git(["checkout", "--", ...revertModified], worktreePath);
    }
    for (const f of revertUntracked) {
      try {
        rmSync(join(worktreePath, f), { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }

    return [...revertModified, ...revertUntracked];
  }

  async changedFilesWithStatus(
    project: Project,
    task: Task,
  ): Promise<GitAcquisition<{ path: string; status: string }[]>> {
    const worktreePath = task.worktreePath;
    if (!worktreePath) {
      return {
        ok: false,
        value: [],
        error: "no worktree path set",
        byteCount: 0,
        truncated: false,
      };
    }
    try {
      // Same three-dot reasoning as changedFiles: only this branch's own
      // changes, not files that advanced on main since the worktree was
      // created.
      const { stdout: output } = await execManagedProcess(
        "git",
        ["diff", "--name-status", `origin/${project.defaultBranch}...HEAD`],
        { cwd: worktreePath, maxOutputBytes: MAX_STATUS_BYTES },
      );
      const value = output
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => {
          // Plain add/modify/delete: "M\tpath". Renames/copies carry a
          // similarity score and TWO paths: "R100\told\tnew" — the path
          // that matters here is where the file ended up, not where it
          // came from.
          const parts = line.split("\t");
          return { status: parts[0] ?? "", path: parts[parts.length - 1] ?? "" };
        });
      return acquisitionSuccess(value, output);
    } catch (err) {
      return acquisitionFailure(err, []);
    }
  }

  async diffText(project: Project, task: Task): Promise<GitAcquisition<string>> {
    const worktreePath = task.worktreePath;
    if (!worktreePath) {
      return {
        ok: false,
        value: "",
        error: "no worktree path set",
        byteCount: 0,
        truncated: false,
      };
    }
    try {
      const { stdout: output } = await execManagedProcess(
        "git",
        ["diff", `origin/${project.defaultBranch}...HEAD`],
        { cwd: worktreePath, maxOutputBytes: MAX_SAFETY_DIFF_BYTES },
      );
      return acquisitionSuccess(output, output);
    } catch (err) {
      const processError = err as { stdout?: string };
      return acquisitionFailure(err, processError.stdout ?? "");
    }
  }

  async worktreeChanges(task: Task): Promise<GitAcquisition<string[]>> {
    const worktreePath = task.worktreePath;
    if (!worktreePath) {
      return {
        ok: false,
        value: [],
        error: "no worktree path set",
        byteCount: 0,
        truncated: false,
      };
    }
    try {
      const { stdout } = await execManagedProcess(
        "git",
        ["status", "--porcelain=v1", "--untracked-files=all"],
        { cwd: worktreePath, maxOutputBytes: MAX_STATUS_BYTES },
      );
      const paths = stdout
        .split("\n")
        .filter(Boolean)
        .map((entry) => entry.slice(3).trim())
        .filter(Boolean);
      return acquisitionSuccess(paths, stdout);
    } catch (err) {
      return acquisitionFailure(err, []);
    }
  }

  async restoreToHead(task: Task): Promise<GitAcquisition<void>> {
    const worktreePath = task.worktreePath;
    if (!worktreePath) {
      return {
        ok: false,
        value: undefined,
        error: "no worktree path set",
        byteCount: 0,
        truncated: false,
      };
    }
    try {
      const reset = await execManagedProcess("git", ["reset", "--hard", "HEAD"], {
        cwd: worktreePath,
        maxOutputBytes: MAX_STATUS_BYTES,
      });
      // Two -f flags allow removal of an untracked nested repository. This is
      // safe here because the path is the disposable per-task worktree, never
      // the operator's primary clone; ignored files (for example node_modules)
      // remain untouched because -x is deliberately absent.
      const clean = await execManagedProcess("git", ["clean", "-ffd"], {
        cwd: worktreePath,
        maxOutputBytes: MAX_STATUS_BYTES,
      });
      const remaining = await this.worktreeChanges(task);
      if (!remaining.ok) {
        return {
          ok: false,
          value: undefined,
          error: `restore completed but cleanliness could not be verified: ${remaining.error ?? "unknown git error"}`,
          byteCount: remaining.byteCount,
          truncated: remaining.truncated,
        };
      }
      if (remaining.value.length > 0) {
        return {
          ok: false,
          value: undefined,
          error: `restore left worktree changes: ${remaining.value.join(", ")}`,
          byteCount: remaining.byteCount,
          truncated: false,
        };
      }
      return acquisitionSuccess(
        undefined,
        reset.stdout + reset.stderr + clean.stdout + clean.stderr,
      );
    } catch (err) {
      return acquisitionFailure(err, undefined);
    }
  }

  async primaryDirtyFiles(project: Project): Promise<string[]> {
    try {
      // Porcelain format: two status chars + a space, then the path (or,
      // for a rename, "old -> new" — left as-is, good enough for a
      // diagnostic message).
      const output = await git(["status", "--porcelain"], project.localPath);
      return output
        .split("\n")
        .map((l) => l.slice(3).trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}
