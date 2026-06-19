import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { Project, Task } from "@orc/types";
import type { GitService } from "./index.js";

export class GitServiceImpl implements GitService {
  async ensureClone(project: Project): Promise<void> {
    if (existsSync(project.localPath)) {
      try {
        execSync("git remote get-url origin", {
          cwd: project.localPath,
          stdio: "pipe",
        });
        return;
      } catch {
        /* directory exists but not a git repo — remove and reclone */
      }
    }

    execSync(`git clone "${project.repoUrl}" "${project.localPath}"`, {
      stdio: "pipe",
    });
  }

  async commitAll(worktreePath: string, message: string): Promise<void> {
    execSync("git add -A", { cwd: worktreePath, stdio: "pipe" });
    try {
      execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
        cwd: worktreePath,
        stdio: "pipe",
      });
    } catch {
      /* commit may fail if nothing to commit — that's ok */
    }
  }

  async push(worktreePath: string, branch: string): Promise<void> {
    execSync(`git push origin "${branch}"`, {
      cwd: worktreePath,
      stdio: "pipe",
    });
  }

  async openPr(project: Project, task: Task): Promise<number> {
    const body = task.description + "\n\n## Acceptance Criteria\n" +
      task.acceptanceCriteria.map((c) => `- ${c}`).join("\n");

    const output = execSync(
      `gh pr create` +
        ` --repo "${project.repoUrl}"` +
        ` --base "${project.defaultBranch}"` +
        ` --head "${task.branch}"` +
        ` --title "${task.title.replace(/"/g, '\\"')}"` +
        ` --body "${body.replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`,
      { cwd: task.worktreePath ?? project.localPath, stdio: "pipe", encoding: "utf-8" },
    );

    const match = output.match(/\/pull\/(\d+)/);
    if (match) return parseInt(match[1]!, 10);

    const num = parseInt(output.trim(), 10);
    if (!isNaN(num)) return num;

    throw new Error(`Could not parse PR number from: ${output}`);
  }

  async mergePr(project: Project, prNumber: number): Promise<void> {
    execSync(
      `gh pr merge "${prNumber}" --squash --delete-branch` +
        ` --repo "${project.repoUrl}"`,
      { stdio: "pipe" },
    );
  }

  async revertMerge(project: Project, prNumber: number): Promise<void> {
    const listOutput = execSync(
      `gh pr view "${prNumber}" --repo "${project.repoUrl}" --json mergeCommit --jq ".mergeCommit.oid"`,
      { cwd: project.localPath, stdio: "pipe", encoding: "utf-8" },
    ).trim();

    if (!listOutput) {
      throw new Error(`No merge commit found for PR #${prNumber}`);
    }

    execSync(`git fetch origin`, {
      cwd: project.localPath,
      stdio: "pipe",
    });

    execSync(`git revert -m 1 "${listOutput}" --no-edit`, {
      cwd: project.localPath,
      stdio: "pipe",
    });

    execSync(`git push origin "${project.defaultBranch}"`, {
      cwd: project.localPath,
      stdio: "pipe",
    });
  }
}
