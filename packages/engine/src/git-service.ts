import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

export type GitOperationStage =
  | "inspect"
  | "fetch"
  | "checkout"
  | "merge"
  | "write"
  | "stage"
  | "commit"
  | "push"
  | "cleanup";

function processErrorDetail(err: unknown): string {
  const processError = err as { stderr?: string; stdout?: string; message?: string };
  return (
    processError.stderr?.trim() ||
    processError.stdout?.trim() ||
    processError.message ||
    String(err)
  );
}

/** B39: infrastructure failures remain machine-identifiable while retaining
 * the underlying Git/OS detail needed for an operator to fix them. */
export class GitOperationError extends Error {
  override name = "GitOperationError";

  constructor(
    readonly stage: GitOperationStage,
    message: string,
    readonly originalError?: unknown,
  ) {
    super(
      `${stage}: ${message}${originalError ? ` (${processErrorDetail(originalError)})` : ""}`,
    );
  }
}

export interface RepositoryFileWrite {
  path: string;
  content: string;
  /** Preserve a hand-maintained file (used for CLAUDE.md). */
  ifMissing?: boolean;
}

type ResolvedRepositoryFile = RepositoryFileWrite & {
  full: string;
  relative: string;
};

const HOOPEDORC_LOCAL_CONTEXT_PREFIXES = [
  "context/attachments/",
  "context/plan-sessions/",
];

function isHoopedorcLocalContextPath(path: string): boolean {
  return HOOPEDORC_LOCAL_CONTEXT_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function safeRepositoryPath(
  root: string,
  candidate: string,
): { full: string; relative: string } {
  if (!candidate || candidate.includes("\0") || isAbsolute(candidate)) {
    throw new GitOperationError(
      "write",
      `invalid repository-relative path ${JSON.stringify(candidate)}`,
    );
  }
  const full = resolve(root, candidate);
  const rel = relative(root, full);
  if (
    !rel ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel) ||
    rel.split(sep).includes(".git")
  ) {
    throw new GitOperationError(
      "write",
      `path escapes the repository: ${JSON.stringify(candidate)}`,
    );
  }
  return { full, relative: rel.split(sep).join("/") };
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
    try {
      await git(["add", "-A"], worktreePath, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new GitOperationError("stage", "could not stage task changes", err);
    }
    let status: string;
    try {
      status = await git(["status", "--porcelain=v1"], worktreePath, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new GitOperationError("inspect", "could not verify whether the task has changes", err);
    }
    if (!status.trim()) return;
    try {
      await git(["commit", "-m", message], worktreePath, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new GitOperationError("commit", "task commit failed", err);
    }
  }

  /** B39: write one planning artifact set as one commit, then push it before
   * the server may create tasks or clear its retryable planning scratch. The
   * push always runs—even after a no-diff retry—so a prior locally committed
   * but unpushed attempt can recover without creating a duplicate commit. */
  async commitFiles(
    project: Project,
    files: RepositoryFileWrite[],
    message: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (files.length === 0) {
      throw new GitOperationError("write", "at least one repository file is required");
    }
    const resolved: ResolvedRepositoryFile[] = files.map((file) => ({
      ...file,
      ...safeRepositoryPath(project.localPath, file.path),
    }));
    const unique = new Set(resolved.map((file) => file.relative));
    if (unique.size !== resolved.length) {
      throw new GitOperationError("write", "planning artifact paths must be unique");
    }

    try {
      await this.ensureClone(project, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      if (err instanceof GitOperationError) throw err;
      throw new GitOperationError("fetch", "could not prepare the project clone", err);
    }

    await withRepoLock(project.localPath, async () => {
      let managed = await this.managedRepositoryFiles(
        resolved,
        project.localPath,
        signal,
      );
      await this.assertOnlyExpectedPrimaryChanges(
        project.localPath,
        new Set(resolved.map((file) => file.relative)),
        signal,
      );
      await this.syncPrimaryForPersistence(project, signal);
      // Origin may have added a conditional file since the previous attempt.
      managed = await this.managedRepositoryFiles(
        resolved,
        project.localPath,
        signal,
      );
      await this.assertOnlyExpectedPrimaryChanges(
        project.localPath,
        new Set(resolved.map((file) => file.relative)),
        signal,
      );

      try {
        for (const file of managed) {
          mkdirSync(dirname(file.full), { recursive: true });
          writeFileSync(
            file.full,
            file.content.endsWith("\n") ? file.content : `${file.content}\n`,
            "utf8",
          );
        }
      } catch (err) {
        throw new GitOperationError("write", "could not write planning artifacts", err);
      }

      const paths = managed.map((file) => file.relative);
      try {
        await git(["add", "--", ...paths], project.localPath, signal);
      } catch (err) {
        if (signal?.aborted) throw err;
        throw new GitOperationError("stage", "could not stage planning artifacts", err);
      }

      let staged: string;
      try {
        staged = await git(
          ["diff", "--cached", "--name-only", "--", ...paths],
          project.localPath,
          signal,
        );
      } catch (err) {
        if (signal?.aborted) throw err;
        throw new GitOperationError(
          "inspect",
          "could not verify staged planning artifacts",
          err,
        );
      }
      if (staged.trim()) {
        try {
          await git(
            ["commit", "-m", message, "--", ...paths],
            project.localPath,
            signal,
          );
        } catch (err) {
          if (signal?.aborted) throw err;
          throw new GitOperationError("commit", "planning artifact commit failed", err);
        }
      }

      try {
        await git(["push", "origin", project.defaultBranch], project.localPath, signal);
      } catch (err) {
        if (signal?.aborted) throw err;
        throw new GitOperationError("push", "planning artifact push failed", err);
      }
    }, signal);
  }

  async push(worktreePath: string, branch: string, signal?: AbortSignal): Promise<void> {
    try {
      await git(["push", "origin", branch], worktreePath, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new GitOperationError("push", `could not push ${branch}`, err);
    }
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
    let alreadyMerged = false;
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
      alreadyMerged = state === "MERGED";
    } catch (err) {
      if (signal?.aborted) throw err;
      // A transient state lookup must not prevent the normal merge path.
    }
    if (alreadyMerged) {
      await this.syncPrimaryAfterMerge(project, prNumber);
      return;
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

    // The GitHub merge is already durable. Refresh the primary clone, but do
    // not turn a remotely completed task into a failure if this housekeeping
    // step fails; later strict primary-clone writes fetch again.
    await this.syncPrimaryAfterMerge(project, prNumber);
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
      await this.syncPrimary(project, signal);

      let lines: string[];
      try {
        lines = readFileSync(path, "utf-8").split("\n");
      } catch {
        lines = ["# Changelog", "", "Auto-generated as tasks merge.", ""];
      }

      // Group entries under a date heading; append under today's heading if
      // it exists, otherwise insert a new heading+entry after the title.
      const entryLine = entry.trimEnd();
      if (!lines.includes(entryLine)) {
        const heading = `## ${date}`;
        const headingIdx = lines.indexOf(heading);
        if (headingIdx !== -1) {
          lines.splice(headingIdx + 1, 0, entryLine);
        } else {
          const titleIdx = lines.findIndex((line) => line.startsWith("# "));
          const insertAt = titleIdx === -1 ? 0 : titleIdx + 1;
          lines.splice(insertAt, 0, "", heading, entryLine);
        }
      }

      writeFileSync(path, lines.join("\n"), "utf-8");
      await git(["add", "CHANGELOG.md"], project.localPath, signal);
      const staged = await git(
        ["diff", "--cached", "--name-only", "--", "CHANGELOG.md"],
        project.localPath,
        signal,
      );
      if (staged.trim()) {
        await git(
          ["commit", "-m", `docs: changelog — ${task.title}`, "--", "CHANGELOG.md"],
          project.localPath,
          signal,
        );
      }
      // Retry-safe after an ambiguous/failed prior push.
      await git(["push", "origin", project.defaultBranch], project.localPath, signal);
    }, signal);
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
      throw new GitOperationError(
        "fetch",
        `could not fetch ${project.defaultBranch} before merging the task PR`,
        err,
      );
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
      // Only an actual unmerged path is a content conflict. Identity, hook,
      // permission, index-lock, and other merge failures are infrastructure
      // errors and must not masquerade as a clean/retryable conflict.
      let conflicts = "";
      try {
        conflicts = await git(["diff", "--name-only", "--diff-filter=U"], wt, signal);
      } catch (inspectError) {
        throw new GitOperationError(
          "inspect",
          "could not inspect a failed branch sync",
          inspectError,
        );
      }
      if (conflicts.trim()) {
        try {
          await git(["merge", "--abort"], wt, signal);
        } catch {
          /* best-effort cleanup; the reported conflict remains the cause */
        }
        return "conflict";
      }
      throw new GitOperationError(
        "merge",
        "task branch sync failed without a content conflict",
        err,
      );
    }
    // Push the (possibly merge-commit-bearing) branch so the PR is current.
    // No-op if the merge changed nothing.
    try {
      await git(["push", "origin", task.branch], wt, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new GitOperationError("push", "could not push the synchronized task branch", err);
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

  private async managedRepositoryFiles(
    files: ResolvedRepositoryFile[],
    root: string,
    signal?: AbortSignal,
  ): Promise<ResolvedRepositoryFile[]> {
    const managed: ResolvedRepositoryFile[] = [];
    for (const file of files) {
      if (!file.ifMissing || !existsSync(file.full)) {
        managed.push(file);
        continue;
      }
      try {
        const trackedAtHead = await git(
          ["ls-tree", "-r", "--name-only", "HEAD", "--", file.relative],
          root,
          signal,
        );
        // A tracked file belongs to the repository owner and is preserved.
        if (trackedAtHead.split("\n").includes(file.relative)) continue;

        // An untracked file may be B39 output left after a stage/commit
        // failure, but it may equally be an owner's not-yet-committed file.
        // Retry only our exact content; preserve every other hand-maintained
        // file instead of overwriting or accidentally committing it.
        const desired = file.content.endsWith("\n") ? file.content : `${file.content}\n`;
        if (readFileSync(file.full, "utf8") === desired) managed.push(file);
      } catch (err) {
        if (signal?.aborted) throw err;
        throw new GitOperationError(
          "inspect",
          `could not inspect conditional planning file ${file.relative}`,
          err,
        );
      }
    }
    return managed;
  }

  private async assertOnlyExpectedPrimaryChanges(
    root: string,
    expected: Set<string>,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      const [unstaged, staged, untracked] = await Promise.all([
        git(["diff", "--name-only"], root, signal),
        git(["diff", "--cached", "--name-only"], root, signal),
        git(["ls-files", "--others", "--exclude-standard"], root, signal),
      ]);
      const dirty = [...new Set(
        `${unstaged}\n${staged}\n${untracked}`
          .split("\n")
          .map((path) => path.trim())
          .filter(Boolean),
      )];
      // Plan chat writes these local-only files before /plan/commit reaches
      // this guard. They are deliberately outside the planning artifact
      // commit, so treating them as unrelated dirt makes every non-ignored
      // context archive/attachment block its own plan from being approved.
      const unexpected = dirty.filter(
        (path) => !expected.has(path) && !isHoopedorcLocalContextPath(path),
      );
      if (unexpected.length > 0) {
        throw new GitOperationError(
          "inspect",
          `primary clone has unrelated changes; commit or remove them before retrying: ${unexpected.join(", ")}`,
        );
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      if (err instanceof GitOperationError) throw err;
      throw new GitOperationError("inspect", "could not verify primary-clone cleanliness", err);
    }
  }

  /** Planning retries may find a clean local commit whose prior push failed.
   * Fast-forward when possible; if origin advanced independently, rebase that
   * local planning commit so a retry can still publish without duplicating it. */
  private async syncPrimaryForPersistence(
    project: Project,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await git(["fetch", "origin", project.defaultBranch], project.localPath, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new GitOperationError("fetch", `could not fetch ${project.defaultBranch}`, err);
    }
    try {
      await git(["checkout", project.defaultBranch], project.localPath, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new GitOperationError("checkout", `could not check out ${project.defaultBranch}`, err);
    }
    try {
      await git(
        ["merge", "--ff-only", `origin/${project.defaultBranch}`],
        project.localPath,
        signal,
      );
      return;
    } catch (mergeError) {
      if (signal?.aborted) throw mergeError;
      try {
        await git(
          ["rebase", `origin/${project.defaultBranch}`],
          project.localPath,
          signal,
        );
        return;
      } catch (rebaseError) {
        if (signal?.aborted) throw rebaseError;
        await git(["rebase", "--abort"], project.localPath).catch(() => {});
        throw new GitOperationError(
          "merge",
          `could not reconcile local planning state with origin/${project.defaultBranch}`,
          rebaseError ?? mergeError,
        );
      }
    }
  }

  /** Fetch + checkout + ff-merge the primary clone to origin's default branch.
   *  Caller must hold the repo lock. */
  private async syncPrimary(project: Project, signal?: AbortSignal): Promise<void> {
    try {
      await git(["fetch", "origin", project.defaultBranch], project.localPath, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new GitOperationError("fetch", `could not fetch ${project.defaultBranch}`, err);
    }
    try {
      await git(["checkout", project.defaultBranch], project.localPath, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new GitOperationError("checkout", `could not check out ${project.defaultBranch}`, err);
    }
    try {
      await git(
        ["merge", "--ff-only", `origin/${project.defaultBranch}`],
        project.localPath,
        signal,
      );
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new GitOperationError(
        "merge",
        `could not fast-forward ${project.defaultBranch}`,
        err,
      );
    }
  }

  private async syncPrimaryAfterMerge(
    project: Project,
    prNumber: number,
  ): Promise<void> {
    try {
      await withRepoLock(project.localPath, () => this.syncPrimary(project));
    } catch (err) {
      const detail = err instanceof Error ? `: ${err.message}` : "";
      console.warn(
        `[hoopedorc] PR #${prNumber} merged, but the primary clone refresh failed${detail}`,
      );
    }
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
    const failures: string[] = [];
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
      } catch (err) {
        const detail = processErrorDetail(err);
        if (!/not open|already (?:closed|merged)/i.test(detail)) {
          failures.push(`close PR #${task.prNumber}: ${detail}`);
        }
      }
    }
    // Belt and suspenders: a branch can exist with no PR (push succeeded but
    // PR creation failed), and `--delete-branch` above can itself fail.
    if (task.branch) {
      try {
        await git(["push", "origin", "--delete", task.branch], project.localPath);
      } catch (err) {
        const detail = processErrorDetail(err);
        if (!/remote ref does not exist|unable to delete/i.test(detail)) {
          failures.push(`delete ${task.branch}: ${detail}`);
        }
      }
    }
    if (failures.length > 0) {
      throw new GitOperationError("cleanup", failures.join("; "));
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
