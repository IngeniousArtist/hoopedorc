import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { minimatch } from "minimatch";
import { sanitizedEnv } from "@orc/adapters";
import type { Project, Settings, Task } from "@orc/types";
import type { WorktreeManager } from "./index.js";
import {
  DEFAULT_GATE_IMAGE,
  resolveSandboxMode,
  sandboxedExecFile,
  SANDBOX_TIMEOUT_GRACE_MS,
} from "./sandbox.js";

const pexecFile = promisify(execFile);
const DEPS_TIMEOUT_MS = 10 * 60 * 1000;
const DEPS_MAX_BUFFER = 32 * 1024 * 1024;
// S8: same cap validator.ts's own (separate) diff fetch uses — bounds the
// text detectDestructiveChanges scans without needing the whole diff for a
// huge change.
const MAX_DIFF_CHARS = 40_000;

// Argument arrays only, never a shell — otherwise project.defaultBranch and
// task.branch (both derived from HTTP-supplied fields) could smuggle shell
// metacharacters into a command. See git-service.ts for the same pattern.
async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await pexecFile("git", args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

const LOCKFILES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"];
const DEPS_MARKER = ".hoopedorc-deps-hash";
// Things the orchestrator (or an agent) generates that must never get staged by
// `git add -A` and committed into a task's PR — most importantly the symlinked
// node_modules we drop into every worktree for the gates.
const GIT_EXCLUDE_ENTRIES = ["node_modules", ".hoopedorc-deps-hash"];

export class WorktreeManagerImpl implements WorktreeManager {
  constructor(
    // Narrowed to just the one field this class reads — see the same choice
    // on GateRunnerImpl in gate-runner.ts.
    private readonly settings?: Pick<Settings, "sandboxGates">,
  ) {}

  async create(
    project: Project,
    task: Task,
  ): Promise<{ branch: string; path: string }> {
    const branch = `orc/${task.id}`;
    const path = `${project.localPath}-wt-${task.id}`;

    // Always branch off the latest remote default branch, not the primary
    // clone's local HEAD. Sibling tasks merge to origin throughout a run, and
    // the primary clone is never fast-forwarded in between — branching off a
    // stale local HEAD makes a new task invisible to work that already
    // landed, which is how independent tasks end up colliding on the same
    // files (see e.g. two tasks both creating index.html from scratch).
    await git(["fetch", "origin", project.defaultBranch], project.localPath);

    // Defense in depth: the branch name is deterministic (orc/<taskId>), so a
    // retried task reuses it. If a prior attempt already pushed to and opened
    // a PR on this branch, the remote ref has history this fresh local branch
    // doesn't — pushing later would be rejected as non-fast-forward, failing
    // every retry regardless of model. The retry endpoint clears the task's
    // prNumber/branch so a fresh PR gets opened; deleting the stale remote
    // branch here (best-effort — fine if it doesn't exist) lets that PR's old
    // branch go away cleanly instead of blocking the new push.
    try {
      await git(["push", "origin", "--delete", branch], project.localPath);
    } catch {
      /* no remote branch by this name — the common case */
    }

    // Defense in depth, local side: `remove()` (called from executeTask's
    // finally) only runs if the process stays alive long enough to reach it.
    // If the server itself dies mid-task — crash, manual kill, a dev-server
    // reload — the worktree directory is orphaned on disk with nothing to
    // ever clean it up, and `git worktree add` fails outright with "already
    // exists" on every subsequent dispatch of this same task, forever.
    try {
      await git(["worktree", "remove", path, "--force"], project.localPath);
    } catch {
      /* not a registered worktree — fall through to the raw rmSync below */
    }
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      /* path didn't exist — the common case */
    }
    try {
      await git(["worktree", "prune"], project.localPath);
    } catch {
      /* best effort */
    }
    try {
      await git(["branch", "-D", branch], project.localPath);
    } catch {
      /* branch may not exist locally — the common case */
    }

    await git(
      ["worktree", "add", path, "-b", branch, `origin/${project.defaultBranch}`],
      project.localPath,
    );

    // MUST run before ensureDeps drops the node_modules symlink, and before the
    // agent's `git add -A`: otherwise node_modules gets committed into the
    // task's PR and the inScope gate fails it as an out-of-scope change. This
    // is the local safety net; new repos also get a committed .gitignore.
    await this.ensureGitExclude(path);
    await this.ensureDeps(project, path);

    return { branch, path };
  }

  /**
   * Append node_modules (etc.) to git's local exclude so `git add -A` in a
   * worktree never stages the symlinked deps. Uses `info/exclude` (shared
   * across all worktrees via the common git dir, never committed) so it works
   * even for older projects whose repo has no .gitignore.
   */
  private async ensureGitExclude(cwd: string): Promise<void> {
    try {
      const rel = (
        await git(["rev-parse", "--git-path", "info/exclude"], cwd)
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
    } catch {
      /* best effort */
    }
  }

  /**
   * A fresh `git worktree add` checkout has no node_modules (it's gitignored),
   * so the pre-merge gates (`npm run build/typecheck/...`) would fail for lack
   * of deps unless the agent happened to install them. Rather than reinstall
   * per worktree (minutes each), keep ONE installed node_modules in the
   * primary clone and symlink it into every worktree. The install only re-runs
   * when the lockfile (or package.json, if no lockfile) changes — tracked via
   * a hash marker inside node_modules.
   *
   * Caveat: concurrent worktrees share this node_modules, so a task that runs
   * `npm install <newdep>` mutates it for siblings. New-dependency tasks are
   * the rare case (and are flagged risky by the merge policy), and scope
   * serialization keeps most overlap out, so this trade is worth the massive
   * per-task time saving.
   *
   * B29: fingerprint (and install) against the WORKTREE's manifest, not the
   * primary clone's. `create()` just branched this worktree off a freshly-
   * fetched `origin/<defaultBranch>`, so its package.json/lockfile always
   * reflect the latest merged state. The primary clone's own working tree
   * doesn't: nothing here keeps it in sync (git-service.ts's syncPrimary()
   * runs on a different lock, in a different module, after PR merges — a
   * best-effort call this class doesn't coordinate with), so once any task
   * changes package.json the primary clone can go stale indefinitely and
   * every later task would otherwise silently symlink into deps installed
   * for that stale snapshot. Copying the worktree's manifest(s) into primary
   * before installing keeps the single shared node_modules (still the
   * expensive part to avoid repeating) while guaranteeing what actually gets
   * fingerprinted and installed is always current.
   */
  private async ensureDeps(project: Project, worktreePath: string): Promise<void> {
    const primary = project.localPath;
    if (!existsSync(join(worktreePath, "package.json"))) return; // not a node project

    try {
      const lockName = LOCKFILES.find((f) => existsSync(join(worktreePath, f)));
      const fingerprintFile = lockName ?? "package.json";
      const want = createHash("sha1")
        .update(readFileSync(join(worktreePath, fingerprintFile)))
        .digest("hex");

      const nm = join(primary, "node_modules");
      const marker = join(nm, DEPS_MARKER);
      const have = existsSync(marker)
        ? readFileSync(marker, "utf-8").trim()
        : null;

      if (!existsSync(marker) || have !== want) {
        copyFileSync(join(worktreePath, "package.json"), join(primary, "package.json"));
        if (lockName) {
          copyFileSync(join(worktreePath, lockName), join(primary, lockName));
        }

        // `npm ci` is faster + reproducible when a lockfile exists; fall back
        // to `npm install` otherwise. Async (not execSync) so a multi-minute
        // install doesn't block the server's event loop. 10-min cap so a hung
        // install can't wedge the run.
        const args =
          lockName === "package-lock.json" ? ["ci"] : ["install"];
        // F13-P1: postinstall hooks are repo code too — the sneakiest kind,
        // since they run implicitly. Route through the same Docker sandbox
        // as gate scripts when enabled; `resolveSandboxMode` throwing
        // ("required" with no daemon) is caught by the outer try/catch below
        // and treated the same as any other install failure — best effort,
        // the actual gate run surfaces the real "no daemon" error loudly.
        const sandbox = await resolveSandboxMode(this.settings?.sandboxGates);
        if (sandbox.useSandbox) {
          await sandboxedExecFile(project.config?.gateImage || DEFAULT_GATE_IMAGE, primary, "npm", args, {
            timeout: DEPS_TIMEOUT_MS + SANDBOX_TIMEOUT_GRACE_MS,
            maxBuffer: DEPS_MAX_BUFFER,
          });
        } else {
          await pexecFile("npm", args, {
            cwd: primary,
            timeout: DEPS_TIMEOUT_MS,
            maxBuffer: DEPS_MAX_BUFFER,
            env: sanitizedEnv({ PWD: primary }),
          });
        }
        // A package.json with no dependencies leaves npm creating no
        // node_modules at all — make the dir so the marker (and the symlink
        // target) exist, and so we don't reinstall on every task forever.
        mkdirSync(nm, { recursive: true });
        writeFileSync(marker, want);
      }

      // Symlink the worktree's node_modules at the shared install. Skip if the
      // checkout somehow already has a real one.
      const link = join(worktreePath, "node_modules");
      if (existsSync(nm) && !existsSync(link)) {
        symlinkSync(nm, link, "dir");
      }
    } catch {
      // Best effort — if install/symlink fails, the gate will surface the
      // missing-deps error on this task rather than silently wedging the run.
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

  async changedFiles(project: Project, task: Task): Promise<string[]> {
    const worktreePath = task.worktreePath;
    if (!worktreePath) return [];
    try {
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
    } catch {
      return [];
    }
  }

  async changedFilesInScope(project: Project, task: Task): Promise<boolean> {
    if (!task.worktreePath) return false;
    if (task.scopePaths.length === 0) return true;

    const changed = await this.changedFiles(project, task);
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
  ): Promise<{ path: string; status: string }[]> {
    const worktreePath = task.worktreePath;
    if (!worktreePath) return [];
    try {
      // Same three-dot reasoning as changedFiles: only this branch's own
      // changes, not files that advanced on main since the worktree was
      // created.
      const output = await git(
        ["diff", "--name-status", `origin/${project.defaultBranch}...HEAD`],
        worktreePath,
      );
      return output
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
    } catch {
      return [];
    }
  }

  async diffText(project: Project, task: Task): Promise<string> {
    const worktreePath = task.worktreePath;
    if (!worktreePath) return "";
    try {
      const output = await git(
        ["diff", `origin/${project.defaultBranch}...HEAD`],
        worktreePath,
      );
      return output.length > MAX_DIFF_CHARS
        ? output.slice(0, MAX_DIFF_CHARS) + "\n... (diff truncated)"
        : output;
    } catch {
      return "";
    }
  }
}
