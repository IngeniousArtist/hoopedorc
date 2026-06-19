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
    const worktreeRel = `.worktrees/${task.id}`;
    const path = `${project.localPath}-wt-${task.id}`;

    execSync(`git worktree add "${path}" -b "${branch}"`, {
      cwd: project.localPath,
      stdio: "pipe",
    });

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

  async changedFilesInScope(project: Project, task: Task): Promise<boolean> {
    const worktreePath = task.worktreePath;
    if (!worktreePath) return false;

    if (task.scopePaths.length === 0) return true;

    let changedFiles: string[] = [];
    try {
      const output = execSync(
        `git diff --name-only origin/${project.defaultBranch} HEAD`,
        { cwd: worktreePath, stdio: "pipe", encoding: "utf-8" },
      );
      changedFiles = output
        .split("\n")
        .map((f) => f.trim())
        .filter(Boolean);
    } catch {
      return false;
    }

    if (changedFiles.length === 0) return true;

    return changedFiles.every((file) =>
      task.scopePaths.some((pattern) => minimatch(file, pattern, { dot: true })),
    );
  }
}
