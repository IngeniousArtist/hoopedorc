import { execSync } from "node:child_process";
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
