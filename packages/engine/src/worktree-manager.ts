import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { minimatch } from "minimatch";
import type { Project, Task } from "@orc/types";
import type { WorktreeManager } from "./index.js";

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

    return { branch, path };
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
