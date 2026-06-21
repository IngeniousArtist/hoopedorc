import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { minimatch } from "minimatch";
import type { Project, Task } from "@orc/types";
import type { WorktreeManager } from "./index.js";

const LOCKFILES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"];
const DEPS_MARKER = ".hoopedorc-deps-hash";
// Things the orchestrator (or an agent) generates that must never get staged by
// `git add -A` and committed into a task's PR — most importantly the symlinked
// node_modules we drop into every worktree for the gates.
const GIT_EXCLUDE_ENTRIES = ["node_modules", ".hoopedorc-deps-hash"];

export class WorktreeManagerImpl implements WorktreeManager {
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
    execSync(`git fetch origin "${project.defaultBranch}"`, {
      cwd: project.localPath,
      stdio: "pipe",
    });

    // Defense in depth: the branch name is deterministic (orc/<taskId>), so a
    // retried task reuses it. If a prior attempt already pushed to and opened
    // a PR on this branch, the remote ref has history this fresh local branch
    // doesn't — pushing later would be rejected as non-fast-forward, failing
    // every retry regardless of model. The retry endpoint clears the task's
    // prNumber/branch so a fresh PR gets opened; deleting the stale remote
    // branch here (best-effort — fine if it doesn't exist) lets that PR's old
    // branch go away cleanly instead of blocking the new push.
    try {
      execSync(`git push origin --delete "${branch}"`, {
        cwd: project.localPath,
        stdio: "pipe",
      });
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
      execSync(`git worktree remove "${path}" --force`, {
        cwd: project.localPath,
        stdio: "pipe",
      });
    } catch {
      /* not a registered worktree — fall through to the raw rmSync below */
    }
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      /* path didn't exist — the common case */
    }
    try {
      execSync(`git worktree prune`, { cwd: project.localPath, stdio: "pipe" });
    } catch {
      /* best effort */
    }
    try {
      execSync(`git branch -D "${branch}"`, {
        cwd: project.localPath,
        stdio: "pipe",
      });
    } catch {
      /* branch may not exist locally — the common case */
    }

    execSync(
      `git worktree add "${path}" -b "${branch}" "origin/${project.defaultBranch}"`,
      { cwd: project.localPath, stdio: "pipe" },
    );

    // MUST run before ensureDeps drops the node_modules symlink, and before the
    // agent's `git add -A`: otherwise node_modules gets committed into the
    // task's PR and the inScope gate fails it as an out-of-scope change. This
    // is the local safety net; new repos also get a committed .gitignore.
    this.ensureGitExclude(path);
    this.ensureDeps(project, path);

    return { branch, path };
  }

  /**
   * Append node_modules (etc.) to git's local exclude so `git add -A` in a
   * worktree never stages the symlinked deps. Uses `info/exclude` (shared
   * across all worktrees via the common git dir, never committed) so it works
   * even for older projects whose repo has no .gitignore.
   */
  private ensureGitExclude(cwd: string): void {
    try {
      const rel = execSync("git rev-parse --git-path info/exclude", {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
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
   */
  private ensureDeps(project: Project, worktreePath: string): void {
    const primary = project.localPath;
    if (!existsSync(join(primary, "package.json"))) return; // not a node project

    try {
      const lockName = LOCKFILES.find((f) => existsSync(join(primary, f)));
      const fingerprintFile = lockName ?? "package.json";
      const want = createHash("sha1")
        .update(readFileSync(join(primary, fingerprintFile)))
        .digest("hex");

      const nm = join(primary, "node_modules");
      const marker = join(nm, DEPS_MARKER);
      const have = existsSync(marker)
        ? readFileSync(marker, "utf-8").trim()
        : null;

      if (!existsSync(marker) || have !== want) {
        // `npm ci` is faster + reproducible when a lockfile exists; fall back
        // to `npm install` otherwise. 10-min cap so a hung install can't wedge
        // the whole run.
        const cmd = lockName === "package-lock.json" ? "npm ci" : "npm install";
        execSync(cmd, { cwd: primary, stdio: "pipe", timeout: 10 * 60 * 1000 });
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
      execSync(`git worktree remove "${path}" --force`, {
        cwd: project.localPath,
        stdio: "pipe",
      });
    } catch {
      /* worktree may already be gone */
    }

    try {
      execSync(`git branch -D "${branch}"`, {
        cwd: project.localPath,
        stdio: "pipe",
      });
    } catch {
      /* branch may already be deleted */
    }
  }

  async changedFiles(project: Project, task: Task): Promise<string[]> {
    const worktreePath = task.worktreePath;
    if (!worktreePath) return [];
    try {
      const output = execSync(
        `git diff --name-only origin/${project.defaultBranch} HEAD`,
        { cwd: worktreePath, stdio: "pipe", encoding: "utf-8" },
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
}
