import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { Project, Task } from "@orc/types";
import type { GitService } from "./index.js";

// All commands use execFileSync with argument arrays (no shell), so task titles,
// descriptions, branch names, and repo URLs can't inject shell commands.

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    encoding: "utf-8",
  });
}

function gh(args: string[], cwd?: string): string {
  return execFileSync("gh", args, {
    cwd,
    stdio: "pipe",
    encoding: "utf-8",
  });
}

export class GitServiceImpl implements GitService {
  async ensureClone(project: Project): Promise<void> {
    if (existsSync(project.localPath)) {
      try {
        git(["remote", "get-url", "origin"], project.localPath);
        return;
      } catch {
        /* directory exists but not a git repo — fall through and clone */
      }
    }
    git(["clone", project.repoUrl, project.localPath]);
  }

  async commitAll(worktreePath: string, message: string): Promise<void> {
    git(["add", "-A"], worktreePath);
    try {
      git(["commit", "-m", message], worktreePath);
    } catch {
      /* nothing to commit — that's ok */
    }
  }

  async push(worktreePath: string, branch: string): Promise<void> {
    git(["push", "origin", branch], worktreePath);
  }

  async openPr(project: Project, task: Task): Promise<number> {
    const body =
      task.description +
      "\n\n## Acceptance Criteria\n" +
      task.acceptanceCriteria.map((c) => `- ${c}`).join("\n");

    const output = gh(
      [
        "pr",
        "create",
        "--repo",
        project.repoUrl,
        "--base",
        project.defaultBranch,
        "--head",
        task.branch ?? "",
        "--title",
        task.title,
        "--body",
        body,
      ],
      task.worktreePath ?? project.localPath,
    );

    const match = output.match(/\/pull\/(\d+)/);
    if (match) return parseInt(match[1]!, 10);

    const num = parseInt(output.trim(), 10);
    if (!isNaN(num)) return num;

    throw new Error(`Could not parse PR number from: ${output}`);
  }

  async mergePr(project: Project, prNumber: number): Promise<void> {
    gh([
      "pr",
      "merge",
      String(prNumber),
      "--squash",
      "--delete-branch",
      "--repo",
      project.repoUrl,
    ]);

    // Fast-forward the primary clone's default branch so it never drifts from
    // origin. Nothing checks out this branch directly (each task gets its own
    // worktree), so this is always safe. Keeps the clone usable as a faithful
    // snapshot for the planner and any future worktree base.
    try {
      git(["fetch", "origin", project.defaultBranch], project.localPath);
      git(["checkout", project.defaultBranch], project.localPath);
      git(
        ["merge", "--ff-only", `origin/${project.defaultBranch}`],
        project.localPath,
      );
    } catch {
      /* best effort — worktree creation re-fetches from origin anyway */
    }
  }

  async revertMerge(project: Project, prNumber: number): Promise<void> {
    const mergeCommit = gh(
      [
        "pr",
        "view",
        String(prNumber),
        "--repo",
        project.repoUrl,
        "--json",
        "mergeCommit",
        "--jq",
        ".mergeCommit.oid",
      ],
      project.localPath,
    ).trim();

    if (!mergeCommit) {
      throw new Error(`No merge commit found for PR #${prNumber}`);
    }

    git(["fetch", "origin"], project.localPath);
    git(["revert", "-m", "1", mergeCommit, "--no-edit"], project.localPath);
    git(["push", "origin", project.defaultBranch], project.localPath);
  }
}
