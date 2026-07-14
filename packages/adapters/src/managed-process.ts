import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 2_000;

export interface ManagedProcessOptions extends SpawnOptionsWithoutStdio {
  input?: string | Buffer;
  signal?: AbortSignal;
  timeoutMs?: number;
  killGraceMs?: number;
  maxOutputBytes?: number;
}

export interface ManagedProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  aborted: boolean;
  timedOut: boolean;
  outputLimitExceeded: boolean;
}

export interface ManagedProcess {
  child: ChildProcessWithoutNullStreams;
  settled: Promise<ManagedProcessResult>;
}

export class ManagedProcessError extends Error {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly killed: boolean;
  readonly timedOut: boolean;
  readonly outputLimitExceeded: boolean;

  constructor(command: string, result: ManagedProcessResult) {
    const reason = result.aborted
      ? "aborted"
      : result.timedOut
        ? "timed out"
        : result.outputLimitExceeded
          ? "exceeded its output limit"
          : `exited with code ${result.code ?? "unknown"}`;
    super(`${command} ${reason}${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
    this.name = result.aborted ? "AbortError" : "ManagedProcessError";
    this.code = result.code;
    this.signal = result.signal;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
    this.killed = result.aborted || result.timedOut || result.outputLimitExceeded;
    this.timedOut = result.timedOut;
    this.outputLimitExceeded = result.outputLimitExceeded;
  }
}

function signalProcessTree(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (child.pid == null) return;

  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (err) {
      // ESRCH means the entire group is already gone. Other failures (for
      // example a platform that rejected process groups) fall back to the
      // direct child below.
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return;
    }
  }

  try {
    child.kill(signal);
  } catch {
    /* already exited */
  }
}

/**
 * Spawn a bounded, abortable process and settle only after its stdio closes.
 * On POSIX the child leads a new process group, allowing cancellation to reap
 * descendants created by CLIs, shell scripts, package managers, and Docker.
 */
export function spawnManagedProcess(
  command: string,
  args: readonly string[],
  options: ManagedProcessOptions = {},
): ManagedProcess {
  const {
    input,
    signal,
    timeoutMs,
    killGraceMs = DEFAULT_KILL_GRACE_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    ...spawnOptions
  } = options;
  const child = spawn(command, [...args], {
    ...spawnOptions,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });

  let closed = false;
  let terminating = false;
  let aborted = false;
  let timedOut = false;
  let outputLimitExceeded = false;
  let outputBytes = 0;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let timeout: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;

  const terminate = (reason: "abort" | "timeout" | "output"): void => {
    if (closed || terminating) return;
    terminating = true;
    aborted = reason === "abort";
    timedOut = reason === "timeout";
    outputLimitExceeded = reason === "output";
    signalProcessTree(child, "SIGTERM");
    killTimer = setTimeout(() => {
      if (!closed) signalProcessTree(child, "SIGKILL");
    }, killGraceMs);
    killTimer.unref();
  };

  const capture = (target: Buffer[], chunk: Buffer): void => {
    const remaining = Math.max(0, maxOutputBytes - outputBytes);
    if (remaining > 0) {
      const kept = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
      target.push(Buffer.from(kept));
      outputBytes += kept.byteLength;
    }
    if (chunk.byteLength > remaining || outputBytes >= maxOutputBytes) {
      terminate("output");
    }
  };
  const onStdout = (chunk: Buffer) => capture(stdout, chunk);
  const onStderr = (chunk: Buffer) => capture(stderr, chunk);
  const onAbort = () => terminate("abort");

  child.stdout.on("data", onStdout);
  child.stderr.on("data", onStderr);
  if (signal?.aborted) {
    onAbort();
  } else {
    signal?.addEventListener("abort", onAbort, { once: true });
  }
  if (timeoutMs != null) {
    timeout = setTimeout(() => terminate("timeout"), timeoutMs);
    timeout.unref();
  }

  const settled = new Promise<ManagedProcessResult>((resolve, reject) => {
    child.once("error", (err) => {
      // A spawn failure has no process to wait for. Errors emitted after a
      // pid exists (for example a platform rejecting child.kill()) must not
      // settle early; close remains the only proof that live work is gone.
      if (child.pid != null) return;
      closed = true;
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.once("close", (code, exitSignal) => {
      if (closed) return;
      closed = true;
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      child.stdout.removeListener("data", onStdout);
      child.stderr.removeListener("data", onStderr);
      resolve({
        code,
        signal: exitSignal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        aborted,
        timedOut,
        outputLimitExceeded,
      });
    });
  });

  child.stdin.on("error", () => {
    /* EPIPE is expected when a process exits before consuming all input. */
  });
  child.stdin.end(input);
  return { child, settled };
}

/** execFile-like convenience wrapper for non-streaming command paths. */
export async function execManagedProcess(
  command: string,
  args: readonly string[],
  options: ManagedProcessOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  options.signal?.throwIfAborted();
  const result = await spawnManagedProcess(command, args, options).settled;
  if (
    result.code !== 0 ||
    result.aborted ||
    result.timedOut ||
    result.outputLimitExceeded
  ) {
    throw new ManagedProcessError(command, result);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("The operation was aborted", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new DOMException("The operation was aborted", "AbortError"));
    };
    function done(): void {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
