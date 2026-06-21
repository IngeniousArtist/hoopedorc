import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Project, Task } from "@orc/types";
import type { GitService } from "./index.js";

// All commands use execFile with argument arrays (no shell), so task titles,
// descriptions, branch names, and repo URLs can't inject shell commands. Async
// (not execFileSync) so git/gh/network calls don't block the server's single
// event loop — synchronous versions froze the server during pushes/merges.
const pexecFile = promisify(execFile);

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await pexecFile("git", args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

async function gh(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await pexecFile("gh", args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Per-repo serialization. Several operations mutate the PRIMARY clone's working
// tree (checkout main, ff-merge, write+commit+push CHANGELOG/PRD, revert). If
// two tasks finish at nearly the same time, concurrent git on the same working
// tree collides on index.lock and one fails. Chaining them per localPath keeps
// each repo's mutations serialized while different projects still run freely.
const repoChains = new Map<string, Promise<unknown>>();
function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoChains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  // Swallow rejections on the chain link so one failure doesn't reject the next.
  repoChains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

export class GitServiceImpl implements GitService {
  async ensureClone(project: Project): Promise<void> {
    await withRepoLock(project.localPath, async () => {
      if (existsSync(project.localPath)) {
        try {
          await git(["remote", "get-url", "origin"], project.localPath);
          return;
        } catch {
          /* directory exists but not a git repo — fall through and clone */
        }
      }
      await git(["clone", project.repoUrl, project.localPath]);
    });
  }

  async commitAll(worktreePath: string, message: string): Promise<void> {
    await git(["add", "-A"], worktreePath);
    try {
      await git(["commit", "-m", message], worktreePath);
    } catch {
      /* nothing to commit — that's ok */
    }
  }

  async push(worktreePath: string, branch: string): Promise<void> {
    await git(["push", "origin", branch], worktreePath);
  }

  async openPr(project: Project, task: Task): Promise<number> {
    const body =
      task.description +
      "\n\n## Acceptance Criteria\n" +
      task.acceptanceCriteria.map((c) => `- ${c}`).join("\n");

    const output = await gh(
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
    // GitHub computes a PR's mergeability asynchronously; for the first few
    // seconds after `gh pr create` it reports UNKNOWN, and `gh pr merge` then
    // fails with "Pull Request is not mergeable". Poll until GitHub resolves
    // it before merging. (The noConflicts gate already verified the content
    // merges cleanly, so UNKNOWN here is the compute race, not a real conflict.)
    await this.waitForMergeable(project, prNumber);

    // Even once mergeable, the merge call can hit a transient API state —
    // retry a couple of times with a short backoff before giving up.
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await gh([
          "pr",
          "merge",
          String(prNumber),
          "--squash",
          "--delete-branch",
          "--repo",
          project.repoUrl,
        ]);
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        await delay(3000);
      }
    }
    if (lastErr) throw lastErr;

    // Fast-forward the primary clone's default branch so it never drifts from
    // origin. Serialized per-repo (concurrent merges would collide on the
    // shared working tree's index.lock). Best effort — worktree creation
    // re-fetches from origin anyway.
    await withRepoLock(project.localPath, async () => {
      try {
        await this.syncPrimary(project);
      } catch {
        /* best effort */
      }
    });
  }

  async appendChangelogEntry(
    project: Project,
    task: Task,
    prNumber: number,
  ): Promise<void> {
    const path = join(project.localPath, "CHANGELOG.md");
    const date = new Date().toISOString().slice(0, 10);
    const oneLineSummary = task.description.split("\n")[0]!.trim();
    const entry =
      `- **${task.title}** (${task.difficulty}, ${task.assignedModel}) — ` +
      `${oneLineSummary} — PR #${prNumber}\n`;

    await withRepoLock(project.localPath, async () => {
      try {
        await this.syncPrimary(project);

        let lines: string[];
        try {
          lines = readFileSync(path, "utf-8").split("\n");
        } catch {
          lines = ["# Changelog", "", "Auto-generated as tasks merge.", ""];
        }

        // Group entries under a date heading; append under today's heading if
        // it exists, otherwise insert a new heading+entry after the title.
        const heading = `## ${date}`;
        const headingIdx = lines.indexOf(heading);
        if (headingIdx !== -1) {
          lines.splice(headingIdx + 1, 0, entry.trimEnd());
        } else {
          const titleIdx = lines.findIndex((l) => l.startsWith("# "));
          const insertAt = titleIdx === -1 ? 0 : titleIdx + 1;
          lines.splice(insertAt, 0, "", heading, entry.trimEnd());
        }

        writeFileSync(path, lines.join("\n"), "utf-8");
        await git(["add", "CHANGELOG.md"], project.localPath);
        await git(
          ["commit", "-m", `docs: changelog — ${task.title}`],
          project.localPath,
        );
        await git(["push", "origin", project.defaultBranch], project.localPath);
      } catch {
        /* best effort — a changelog gap is cosmetic, never block the merge */
      }
    });
  }

  /**
   * Write a file into the primary clone and push it straight to the default
   * branch. Used to persist docs/PRD.md at plan-commit time so the PRD lives
   * in the repo (durable, visible, readable by the in-repo planner next time).
   * Best-effort: a push failure never blocks the commit flow.
   */
  async commitFile(
    project: Project,
    relPath: string,
    content: string,
    message: string,
  ): Promise<void> {
    await this.ensureClone(project);
    await withRepoLock(project.localPath, async () => {
      try {
        await this.syncPrimary(project);

        const full = join(project.localPath, relPath);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(
          full,
          content.endsWith("\n") ? content : content + "\n",
          "utf-8",
        );

        await git(["add", relPath], project.localPath);
        // No-op commit (content unchanged) exits non-zero — tolerate it.
        try {
          await git(["commit", "-m", message], project.localPath);
        } catch {
          return;
        }
        await git(["push", "origin", project.defaultBranch], project.localPath);
      } catch {
        /* best effort — PRD also persists in the DB */
      }
    });
  }

  /** Fetch + checkout + ff-merge the primary clone to origin's default branch.
   *  Caller must hold the repo lock. */
  private async syncPrimary(project: Project): Promise<void> {
    await git(["fetch", "origin", project.defaultBranch], project.localPath);
    await git(["checkout", project.defaultBranch], project.localPath);
    await git(
      ["merge", "--ff-only", `origin/${project.defaultBranch}`],
      project.localPath,
    );
  }

  /**
   * Poll a PR's GitHub-computed mergeability until it's no longer UNKNOWN.
   * Resolves on MERGEABLE; throws on CONFLICTING. On persistent UNKNOWN it
   * returns after the timeout and lets the caller attempt the merge anyway.
   */
  private async waitForMergeable(
    project: Project,
    prNumber: number,
  ): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt++) {
      let state = "UNKNOWN";
      try {
        state = (
          await gh([
            "pr",
            "view",
            String(prNumber),
            "--repo",
            project.repoUrl,
            "--json",
            "mergeable",
            "--jq",
            ".mergeable",
          ])
        ).trim();
      } catch {
        /* transient API error — treat as UNKNOWN and retry */
      }
      if (state === "MERGEABLE") return;
      if (state === "CONFLICTING") {
        throw new Error(
          `PR #${prNumber} conflicts with ${project.defaultBranch} and can't be auto-merged`,
        );
      }
      await delay(2000); // UNKNOWN — give GitHub a moment to compute
    }
  }

  async revertMerge(project: Project, prNumber: number): Promise<void> {
    const mergeCommit = (
      await gh(
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
      )
    ).trim();

    if (!mergeCommit) {
      throw new Error(`No merge commit found for PR #${prNumber}`);
    }

    await withRepoLock(project.localPath, async () => {
      await git(["fetch", "origin"], project.localPath);
      await git(
        ["revert", "-m", "1", mergeCommit, "--no-edit"],
        project.localPath,
      );
      await git(["push", "origin", project.defaultBranch], project.localPath);
    });
  }
}
