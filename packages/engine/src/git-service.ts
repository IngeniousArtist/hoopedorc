import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { abortableDelay, execManagedProcess } from "@orc/adapters";
import type { Project, RollbackJob, Task } from "@orc/types";
import type { GitService } from "./index.js";

// All commands use the managed process runner with argument arrays (no shell), so task titles,
// descriptions, branch names, and repo URLs can't inject shell commands. Async
// so git/gh/network calls don't block the server's single
// event loop — synchronous versions froze the server during pushes/merges.
async function git(
  args: string[],
  cwd?: string,
  signal?: AbortSignal,
): Promise<string> {
  const { stdout } = await execManagedProcess("git", args, {
    cwd,
    signal,
    maxOutputBytes: 64 * 1024 * 1024,
  });
  return stdout;
}

async function gh(
  args: string[],
  cwd?: string,
  signal?: AbortSignal,
): Promise<string> {
  const { stdout } = await execManagedProcess("gh", args, {
    cwd,
    signal,
    maxOutputBytes: 64 * 1024 * 1024,
  });
  return stdout;
}

// Per-repo serialization. Several operations mutate the PRIMARY clone's working
// tree (checkout main, ff-merge, write+commit+push CHANGELOG/PRD, revert). If
// two tasks finish at nearly the same time, concurrent git on the same working
// tree collides on index.lock and one fails. Chaining them per localPath keeps
// each repo's mutations serialized while different projects still run freely.
const repoChains = new Map<string, Promise<unknown>>();
async function withRepoLock<T>(
  key: string,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const prev = repoChains.get(key) ?? Promise.resolve();
  let started = false;
  const guarded = () => {
    signal?.throwIfAborted();
    started = true;
    return fn();
  };
  const run = prev.then(guarded, guarded);
  // Swallow rejections on the chain link so one failure doesn't reject the next.
  repoChains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  if (!signal) return run;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      // A queued operation can stop immediately; guarded() will observe the
      // signal and never run it later. Once fn() has started, however, its
      // managed child owns settlement and we wait for that child to close.
      if (!started) {
        finish(() => reject(new DOMException("The operation was aborted", "AbortError")));
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    run.then(
      (value) => finish(() => resolve(value)),
      (err) => finish(() => reject(err)),
    );
  });
}

export class GitServiceImpl implements GitService {
  async ensureClone(project: Project, signal?: AbortSignal): Promise<void> {
    await withRepoLock(project.localPath, async () => {
      if (existsSync(project.localPath)) {
        try {
          await git(["remote", "get-url", "origin"], project.localPath, signal);
          return;
        } catch {
          /* directory exists but not a git repo — fall through and clone */
        }
      }
      await git(["clone", project.repoUrl, project.localPath], undefined, signal);
    }, signal);
  }

  async commitAll(worktreePath: string, message: string, signal?: AbortSignal): Promise<void> {
    await git(["add", "-A"], worktreePath, signal);
    try {
      await git(["commit", "-m", message], worktreePath, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      /* nothing to commit — that's ok */
    }
  }

  async push(worktreePath: string, branch: string, signal?: AbortSignal): Promise<void> {
    await git(["push", "origin", branch], worktreePath, signal);
  }

  async openPr(project: Project, task: Task, signal?: AbortSignal): Promise<number> {
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
      signal,
    );

    const match = output.match(/\/pull\/(\d+)/);
    if (match) return parseInt(match[1]!, 10);

    const num = parseInt(output.trim(), 10);
    if (!isNaN(num)) return num;

    throw new Error(`Could not parse PR number from: ${output}`);
  }

  async mergePr(project: Project, prNumber: number, signal?: AbortSignal): Promise<void> {
    // Restart idempotency: a process can die after GitHub merged the PR but
    // before the durable caller records completion. Treat that state as done
    // instead of trying to merge the already-merged PR again.
    try {
      const state = (
        await gh(
          [
            "pr",
            "view",
            String(prNumber),
            "--repo",
            project.repoUrl,
            "--json",
            "state",
            "--jq",
            ".state",
          ],
          undefined,
          signal,
        )
      ).trim();
      if (state === "MERGED") {
        await withRepoLock(
          project.localPath,
          () => this.syncPrimary(project, signal).catch(() => {}),
          signal,
        );
        return;
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      // A transient state lookup must not prevent the normal merge path.
    }

    // GitHub computes a PR's mergeability asynchronously; for the first few
    // seconds after `gh pr create` it reports UNKNOWN, and `gh pr merge` then
    // fails with "Pull Request is not mergeable". Poll until GitHub resolves
    // it before merging. (The noConflicts gate already verified the content
    // merges cleanly, so UNKNOWN here is the compute race, not a real conflict.)
    await this.waitForMergeable(project, prNumber, signal);

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
        ], undefined, signal);
        lastErr = undefined;
        break;
      } catch (err) {
        if (signal?.aborted) throw err;
        lastErr = err;
        await abortableDelay(3000, signal);
      }
    }
    if (lastErr) throw lastErr;

    // Fast-forward the primary clone's default branch so it never drifts from
    // origin. Serialized per-repo (concurrent merges would collide on the
    // shared working tree's index.lock). Best effort — worktree creation
    // re-fetches from origin anyway.
    await withRepoLock(project.localPath, async () => {
      try {
        await this.syncPrimary(project, signal);
      } catch {
        /* best effort */
      }
    }, signal);
  }

  async appendChangelogEntry(
    project: Project,
    task: Task,
    prNumber: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const path = join(project.localPath, "CHANGELOG.md");
    const date = new Date().toISOString().slice(0, 10);
    const oneLineSummary = task.description.split("\n")[0]!.trim();
    const entry =
      `- **${task.title}** (${task.difficulty}, ${task.assignedModel}) — ` +
      `${oneLineSummary} — PR #${prNumber}\n`;

    await withRepoLock(project.localPath, async () => {
      try {
        await this.syncPrimary(project, signal);

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
        await git(["add", "CHANGELOG.md"], project.localPath, signal);
        await git(
          ["commit", "-m", `docs: changelog — ${task.title}`],
          project.localPath,
          signal,
        );
        await git(["push", "origin", project.defaultBranch], project.localPath, signal);
      } catch (err) {
        if (signal?.aborted) throw err;
        /* best effort — a changelog gap is cosmetic, never block the merge */
      }
    }, signal);
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

  async syncBranchWithMain(
    project: Project,
    task: Task,
    signal?: AbortSignal,
  ): Promise<"clean" | "conflict"> {
    const wt = task.worktreePath;
    if (!wt || !task.branch) return "clean"; // nothing to sync
    try {
      await git(["fetch", "origin", project.defaultBranch], wt, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      return "clean"; // can't fetch — let the merge attempt proceed as-is
    }
    try {
      // 3-way merge of latest main into the branch. Exits 0 on a clean merge
      // OR "already up to date"; non-zero only on a real content conflict.
      await git(
        ["merge", "--no-edit", `origin/${project.defaultBranch}`],
        wt,
        signal,
      );
    } catch (err) {
      if (signal?.aborted) throw err;
      // Genuine conflict — leave a clean tree and report it. The orchestrator
      // requeues the task for a fresh attempt against the now-current main.
      try {
        await git(["merge", "--abort"], wt, signal);
      } catch {
        /* nothing to abort */
      }
      return "conflict";
    }
    // Push the (possibly merge-commit-bearing) branch so the PR is current.
    // No-op if the merge changed nothing.
    try {
      await git(["push", "origin", task.branch], wt, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      /* best effort — mergePr re-checks mergeability regardless */
    }
    return "clean";
  }

  async waitForChecks(
    project: Project,
    prNumber: number,
    timeoutMs: number,
    onPoll?: (elapsedMs: number) => void,
    signal?: AbortSignal,
  ): Promise<"passed" | "failed" | "none" | "timeout"> {
    const POLL_MS = 15_000;
    const start = Date.now();
    for (;;) {
      onPoll?.(Date.now() - start);
      // --json makes `gh pr checks` exit 0 for pass/pending/fail alike — the
      // real state lives in each check's `bucket` field, not the exit code.
      // The ONE case that still throws even with --json is "no checks
      // configured at all", which prints a literal "no checks reported on
      // the '<branch>' branch" message instead of emitting JSON. Verified
      // directly against the installed `gh` (all four states) before
      // writing this, per the plan's instruction not to trust assumptions
      // about CLI exit-code semantics.
      try {
        const stdout = await gh([
          "pr",
          "checks",
          String(prNumber),
          "--repo",
          project.repoUrl,
          "--json",
          "bucket,state,name",
        ], undefined, signal);
        const checks = JSON.parse(stdout) as { bucket: string }[];
        if (checks.length > 0) {
          if (checks.some((c) => c.bucket === "fail" || c.bucket === "cancel")) {
            return "failed";
          }
          if (!checks.some((c) => c.bucket === "pending")) {
            return "passed"; // everything left is pass/skipping
          }
          // else still pending — fall through to the timeout/sleep below
        }
      } catch (err: unknown) {
        if (signal?.aborted) throw err;
        const message = String(
          (err as { stderr?: string; message?: string })?.stderr ??
            (err as Error)?.message ??
            "",
        );
        if (/no checks reported/i.test(message)) return "none";
        // Any other CLI hiccup (transient network blip, etc.) — tolerate and
        // keep polling until the timeout rather than failing the whole task
        // over one bad poll.
      }
      if (Date.now() - start >= timeoutMs) return "timeout";
      await abortableDelay(POLL_MS, signal);
    }
  }

  /** Fetch + checkout + ff-merge the primary clone to origin's default branch.
   *  Caller must hold the repo lock. */
  private async syncPrimary(project: Project, signal?: AbortSignal): Promise<void> {
    await git(["fetch", "origin", project.defaultBranch], project.localPath, signal);
    await git(["checkout", project.defaultBranch], project.localPath, signal);
    await git(
      ["merge", "--ff-only", `origin/${project.defaultBranch}`],
      project.localPath,
      signal,
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
    signal?: AbortSignal,
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
          ], undefined, signal)
        ).trim();
      } catch (err) {
        if (signal?.aborted) throw err;
        /* transient API error — treat as UNKNOWN and retry */
      }
      if (state === "MERGEABLE") return;
      if (state === "CONFLICTING") {
        throw new Error(
          `PR #${prNumber} conflicts with ${project.defaultBranch} and can't be auto-merged`,
        );
      }
      await abortableDelay(2000, signal); // UNKNOWN — give GitHub a moment to compute
    }
  }

  async cleanupTaskBranch(project: Project, task: Task): Promise<void> {
    // Closing the PR first gets the explanatory comment onto it; deleting
    // the head branch alone would auto-close the PR but silently.
    if (task.prNumber != null) {
      try {
        await gh([
          "pr",
          "close",
          String(task.prNumber),
          "--repo",
          project.repoUrl,
          "--comment",
          `Closed by Hoopedorc: task failed. ${task.statusReason ?? ""}`.trim(),
          "--delete-branch",
        ]);
      } catch {
        /* already closed/merged, or transient API error — best effort */
      }
    }
    // Belt and suspenders: a branch can exist with no PR (push succeeded but
    // PR creation failed), and `--delete-branch` above can itself fail.
    if (task.branch) {
      try {
        await git(["push", "origin", "--delete", task.branch], project.localPath);
      } catch {
        /* branch already gone — the common case */
      }
    }
  }

  async resolvePrMergeCommit(
    project: Project,
    prNumber: number,
    signal?: AbortSignal,
  ): Promise<string> {
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
        signal,
      )
    ).trim();
    if (!/^[0-9a-f]{40}$/i.test(mergeCommit)) {
      throw new Error(`No merge commit found for PR #${prNumber}`);
    }
    return mergeCommit;
  }

  async prepareRollback(
    project: Project,
    job: RollbackJob,
    signal?: AbortSignal,
  ): Promise<{ sourceCommit: string; sourceParentCount: number }> {
    const expectedBranch = `orc/rollback-${job.id}`;
    const expectedPath = `${project.localPath}-rollback-${job.id}`;
    if (job.branch !== expectedBranch || job.worktreePath !== expectedPath) {
      throw new Error("Rollback branch/worktree does not match its deterministic job path");
    }
    const sourceCommit =
      job.sourceCommit ??
      (await this.resolvePrMergeCommit(project, job.sourcePrNumber, signal));
    if (!/^[0-9a-f]{40}$/i.test(sourceCommit)) {
      throw new Error(`Invalid rollback source commit: ${sourceCommit}`);
    }

    return withRepoLock(
      project.localPath,
      async () => {
        await git(
          ["fetch", "origin", project.defaultBranch],
          project.localPath,
          signal,
        );
        try {
          await git(
            [
              "merge-base",
              "--is-ancestor",
              sourceCommit,
              `origin/${project.defaultBranch}`,
            ],
            project.localPath,
            signal,
          );
        } catch (err) {
          if (signal?.aborted) throw err;
          throw new Error(
            `PR #${job.sourcePrNumber} commit ${sourceCommit} is not on origin/${project.defaultBranch}`,
          );
        }

        const parentLine = (
          await git(
            ["rev-list", "--parents", "-n", "1", sourceCommit],
            project.localPath,
            signal,
          )
        ).trim();
        const sourceParentCount = Math.max(
          0,
          parentLine.split(/\s+/).filter(Boolean).length - 1,
        );
        if (sourceParentCount === 0) {
          throw new Error(`Cannot roll back root commit ${sourceCommit}`);
        }

        let worktreeReady = false;
        try {
          const currentBranch = (
            await git(
              ["rev-parse", "--abbrev-ref", "HEAD"],
              job.worktreePath,
              signal,
            )
          ).trim();
          worktreeReady = currentBranch === job.branch;
        } catch (err) {
          if (signal?.aborted) throw err;
        }

        if (!worktreeReady) {
          await git(
            ["worktree", "remove", job.worktreePath, "--force"],
            project.localPath,
            signal,
          ).catch((err) => {
            if (signal?.aborted) throw err;
          });
          rmSync(job.worktreePath, { recursive: true, force: true });
          await git(["worktree", "prune"], project.localPath, signal);

          let localBranchExists = true;
          try {
            await git(
              ["show-ref", "--verify", `refs/heads/${job.branch}`],
              project.localPath,
              signal,
            );
          } catch (err) {
            if (signal?.aborted) throw err;
            localBranchExists = false;
          }

          if (!localBranchExists) {
            let remoteBranchExists = true;
            try {
              await git(
                ["ls-remote", "--exit-code", "--heads", "origin", job.branch],
                project.localPath,
                signal,
              );
            } catch (err) {
              if (signal?.aborted) throw err;
              remoteBranchExists = false;
            }
            if (remoteBranchExists) {
              await git(
                ["fetch", "origin", `${job.branch}:refs/heads/${job.branch}`],
                project.localPath,
                signal,
              );
              localBranchExists = true;
            }
          }

          if (localBranchExists) {
            await git(
              ["worktree", "add", job.worktreePath, job.branch],
              project.localPath,
              signal,
            );
          } else {
            await git(
              [
                "worktree",
                "add",
                job.worktreePath,
                "-b",
                job.branch,
                `origin/${project.defaultBranch}`,
              ],
              project.localPath,
              signal,
            );
          }
        }

        const trailer = `Hoopedorc-Rollback-Job: ${job.id}`;
        const headMessage = await git(
          ["log", "-50", "--format=%B"],
          job.worktreePath,
          signal,
        );
        if (headMessage.includes(trailer)) {
          return { sourceCommit, sourceParentCount };
        }

        const head = (
          await git(["rev-parse", "HEAD"], job.worktreePath, signal)
        ).trim();
        const base = (
          await git(
            ["rev-parse", `origin/${project.defaultBranch}`],
            job.worktreePath,
            signal,
          )
        ).trim();
        if (head !== base) {
          throw new Error(
            `Rollback branch ${job.branch} has unrecognized commits; refusing to reset or reapply the revert`,
          );
        }

        const revertArgs = ["revert"];
        if (sourceParentCount > 1) revertArgs.push("-m", "1");
        revertArgs.push(sourceCommit, "--no-edit");
        try {
          await git(revertArgs, job.worktreePath, signal);
        } catch (err) {
          if (signal?.aborted) throw err;
          let conflicts = "";
          try {
            conflicts = await git(
              ["diff", "--name-only", "--diff-filter=U"],
              job.worktreePath,
            );
          } finally {
            await git(["revert", "--abort"], job.worktreePath).catch(() => {});
          }
          if (conflicts.trim()) {
            throw new RollbackConflictError(
              `Rollback conflicts in: ${conflicts.trim().split("\n").join(", ")}`,
            );
          }
          throw err;
        }

        const subject = (
          await git(
            ["show", "-s", "--format=%s", sourceCommit],
            job.worktreePath,
            signal,
          )
        ).trim();
        await git(
          [
            "commit",
            "--amend",
            "-m",
            `revert: rollback PR #${job.sourcePrNumber}`,
            "-m",
            `Reverts ${sourceCommit} (${subject}).`,
            "-m",
            trailer,
          ],
          job.worktreePath,
          signal,
        );
        return { sourceCommit, sourceParentCount };
      },
      signal,
    );
  }

  async openRollbackPr(
    project: Project,
    task: Task,
    job: RollbackJob,
    signal?: AbortSignal,
  ): Promise<number> {
    const existing = (
      await gh(
        [
          "pr",
          "list",
          "--repo",
          project.repoUrl,
          "--head",
          job.branch,
          "--state",
          "open",
          "--json",
          "number",
          "--jq",
          ".[0].number // empty",
        ],
        job.worktreePath,
        signal,
      )
    ).trim();
    if (/^\d+$/.test(existing)) return Number(existing);

    const gateNames = [
      "typecheck",
      "lint",
      "build",
      "tests",
      "noConflicts",
    ] as const;
    const gateSummary = job.gate
      ? gateNames
          .map((name) => `- ${name}: ${job.gate![name] ? "PASS" : "FAIL"}`)
          .join("\n")
      : "- not recorded";
    const reasons = job.decision?.reasons?.length
      ? job.decision.reasons.map((reason) => `- ${reason}`).join("\n")
      : "- validator supplied no reasons";
    const output = await gh(
      [
        "pr",
        "create",
        "--repo",
        project.repoUrl,
        "--base",
        project.defaultBranch,
        "--head",
        job.branch,
        "--title",
        `Rollback PR #${job.sourcePrNumber}: ${task.title}`,
        "--body",
        `## Rollback\nReverts the commit merged by PR #${job.sourcePrNumber}.\n\n## Gate results\n${gateSummary}\n\n## Independent validator\n${reasons}\n\nRollback job: ${job.id}`,
      ],
      job.worktreePath,
      signal,
    );
    const match = output.match(/\/pull\/(\d+)/);
    if (match) return Number(match[1]);
    if (/^\d+$/.test(output.trim())) return Number(output.trim());
    throw new Error(`Could not parse rollback PR number from: ${output}`);
  }

  async closeRollbackPr(
    project: Project,
    job: RollbackJob,
    reason: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (job.rollbackPrNumber != null) {
      const state = (
        await gh(
          [
            "pr",
            "view",
            String(job.rollbackPrNumber),
            "--repo",
            project.repoUrl,
            "--json",
            "state",
            "--jq",
            ".state",
          ],
          project.localPath,
          signal,
        )
      ).trim();
      if (state === "CLOSED") return;
      if (state === "MERGED") {
        throw new Error(
          `Rollback PR #${job.rollbackPrNumber} was already merged and cannot be rejected`,
        );
      }
      await gh(
        [
          "pr",
          "close",
          String(job.rollbackPrNumber),
          "--repo",
          project.repoUrl,
          "--comment",
          reason,
          "--delete-branch",
        ],
        project.localPath,
        signal,
      );
      return;
    }
    try {
      await git(
        ["push", "origin", "--delete", job.branch],
        project.localPath,
        signal,
      );
    } catch (err) {
      if (signal?.aborted) throw err;
      // No remote branch was pushed yet.
    }
  }
}

export class RollbackConflictError extends Error {
  override name = "RollbackConflictError";
}
