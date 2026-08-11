import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { execManagedProcess } from "@orc/adapters";

export interface RepositoryLockOptions {
  /** `ensureClone` is the only caller allowed to lock a not-yet-created repo. */
  allowMissingRepository?: boolean;
  /** Keep every clone bootstrap caller on one key even after `.git` appears. */
  useCanonicalTargetPath?: boolean;
}

export class RepositoryLockResolutionError extends Error {
  override name = "RepositoryLockResolutionError";

  constructor(
    readonly repositoryPath: string,
    readonly originalError: unknown,
  ) {
    const detail = originalError instanceof Error
      ? originalError.message
      : String(originalError);
    super(`could not resolve the common Git directory for ${repositoryPath}: ${detail}`);
  }
}

async function commonGitDirectory(
  repositoryPath: string,
  signal?: AbortSignal,
): Promise<string> {
  const { stdout } = await execManagedProcess(
    "git",
    ["rev-parse", "--git-common-dir"],
    {
      cwd: repositoryPath,
      signal,
      maxOutputBytes: 1024 * 1024,
    },
  );
  const raw = stdout.trim();
  if (!raw) throw new Error("git returned an empty common-directory path");
  const absolute = isAbsolute(raw) ? raw : resolve(repositoryPath, raw);
  const canonical = await realpath(absolute);
  const metadata = await stat(canonical);
  if (!metadata.isDirectory()) {
    throw new Error(`${canonical} is not a directory`);
  }
  return canonical;
}

async function canonicalTargetPath(repositoryPath: string): Promise<string> {
  const absolute = resolve(repositoryPath);
  try {
    return await realpath(absolute);
  } catch {
    const parent = await realpath(dirname(absolute));
    return join(parent, basename(absolute));
  }
}

export type RepositoryLockKeyResolver = (
  repositoryPath: string,
  signal: AbortSignal | undefined,
  options: RepositoryLockOptions,
) => Promise<string>;

async function resolveRepositoryKey(
  repositoryPath: string,
  signal: AbortSignal | undefined,
  options: RepositoryLockOptions,
): Promise<string> {
  if (options.useCanonicalTargetPath) {
    return `path:${await canonicalTargetPath(repositoryPath)}`;
  }
  try {
    return `git:${await commonGitDirectory(repositoryPath, signal)}`;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (!options.allowMissingRepository) {
      throw new RepositoryLockResolutionError(repositoryPath, error);
    }
    return `path:${await canonicalTargetPath(repositoryPath)}`;
  }
}

/**
 * Serializes mutations by Git's common metadata directory. Linked worktrees
 * and symlinked paths therefore share a queue, while unrelated repositories
 * remain independent. Idle chains are evicted after their final waiter.
 */
export class RepositoryLock {
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    private readonly resolveKey: RepositoryLockKeyResolver = resolveRepositoryKey,
  ) {}

  get activeKeyCount(): number {
    return this.chains.size;
  }

  async run<T>(
    repositoryPath: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
    options: RepositoryLockOptions = {},
  ): Promise<T> {
    signal?.throwIfAborted();

    const key = await this.resolveKey(repositoryPath, signal, options);

    const previous = this.chains.get(key) ?? Promise.resolve();
    let started = false;
    const guarded = () => {
      signal?.throwIfAborted();
      started = true;
      return operation();
    };
    const run = previous.then(guarded, guarded);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, tail);
    void tail.finally(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });

    if (!signal) return run;
    signal.throwIfAborted();
    return new Promise<T>((resolvePromise, rejectPromise) => {
      let settled = false;
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        settle();
      };
      const onAbort = () => {
        // A queued mutation can reject immediately. Once it starts, its
        // managed child process owns cancellation and settlement.
        if (!started) {
          finish(() => rejectPromise(
            new DOMException("The operation was aborted", "AbortError"),
          ));
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      run.then(
        (value) => finish(() => resolvePromise(value)),
        (error) => finish(() => rejectPromise(error)),
      );
    });
  }
}

export const repositoryLock = new RepositoryLock();
