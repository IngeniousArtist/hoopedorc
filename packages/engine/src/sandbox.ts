import { execFile } from "node:child_process";
import { promisify } from "node:util";

// F13-P1 (phase 1 of docs/specs/sandbox.md): runs gate scripts and
// `ensureDeps`'s `npm ci|install` inside Docker instead of directly on the
// host. Deliberately NOT `sanitizedEnv()` minus a denylist — a container
// boundary makes an allowlist assembled from scratch cheap to maintain, per
// the spec doc's two-layer env note, so the container's env is built up from
// nothing rather than filtered down from the host's.

const pexecFile = promisify(execFile);

export type SandboxMode = "off" | "auto" | "required";

export const DEFAULT_GATE_IMAGE = "node:22";

/**
 * Extra wall-clock time a sandboxed run gets on top of a gate's normal
 * timeout — booting a container isn't instant, and a script that would have
 * passed natively shouldn't fail purely from that startup overhead.
 */
export const SANDBOX_TIMEOUT_GRACE_MS = 30_000;

const CONTAINER_WORKDIR = "/work";
// Never the container's real root user's home — a gate script that resolves
// "~" should land somewhere empty inside the container, not accidentally
// find a mounted path.
const CONTAINER_HOME = "/tmp";

/**
 * A plausible Docker image reference — `[registry/]repo[:tag]`, the same
 * shape `docker pull` accepts. Not exhaustive validation (Docker's own name
 * grammar has more edge cases), just enough to reject obvious garbage typed
 * into a settings field before it reaches `execFile`.
 */
const IMAGE_REF_RE =
  /^[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*)*(?::[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127})?$/;

export function isPlausibleImageRef(ref: string): boolean {
  return ref.length > 0 && ref.length <= 200 && IMAGE_REF_RE.test(ref);
}

let dockerProbeResult: Promise<boolean> | null = null;

async function runDockerVersionProbe(): Promise<boolean> {
  try {
    await pexecFile("docker", ["version"], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a Docker daemon responds, cached for the process lifetime — a gate
 * run can call this several times (typecheck/lint/build/test each check
 * independently), and re-probing before every one would add real latency for
 * no benefit (the daemon doesn't flap mid-run in practice).
 */
export function detectDocker(probe: () => Promise<boolean> = runDockerVersionProbe): Promise<boolean> {
  if (!dockerProbeResult) {
    dockerProbeResult = probe();
  }
  return dockerProbeResult;
}

/** Test-only: clears the cached probe so a test can simulate the daemon
 *  appearing/disappearing between calls. */
export function _resetDockerDetectionForTests(): void {
  dockerProbeResult = null;
}

let warnedNoDockerForAuto = false;

/** Test-only: resets the auto-mode warn-once flag. */
export function _resetSandboxWarningForTests(): void {
  warnedNoDockerForAuto = false;
}

export interface ResolvedSandbox {
  useSandbox: boolean;
  /** Human-readable summary of the resolved mode — safe to log and exactly
   *  what the Setup & Health panel surfaces. */
  detail: string;
}

/**
 * Decide whether gate/dep-install execution should run inside Docker, given
 * the operator's configured mode. Throws when `required` has no daemon to
 * use — callers must surface that as a hard failure (a loud gate failure),
 * not a silent host fallback, since `required` exists specifically to
 * guarantee the sandbox is active.
 */
export async function resolveSandboxMode(
  mode: SandboxMode | undefined,
  probe: () => Promise<boolean> = detectDocker,
): Promise<ResolvedSandbox> {
  if (mode === "off") return { useSandbox: false, detail: "host (sandbox off)" };

  const available = await probe();
  if (mode === "required") {
    if (!available) {
      throw new Error(
        'sandboxGates is "required" but no Docker daemon responded to `docker version`',
      );
    }
    return { useSandbox: true, detail: "docker (required)" };
  }

  // auto (also the fallback for an unset mode)
  if (!available) {
    if (!warnedNoDockerForAuto) {
      warnedNoDockerForAuto = true;
      console.warn(
        "[hoopedorc] sandboxGates=auto but no Docker daemon responded — " +
          "gates are running unsandboxed on the host until one is available",
      );
    }
    return { useSandbox: false, detail: "host (auto — docker not detected)" };
  }
  return { useSandbox: true, detail: "docker (auto)" };
}

export interface SandboxExecOptions {
  timeout?: number;
  maxBuffer?: number;
  /**
   * Additional read-only bind mounts, each mounted at the SAME absolute path
   * inside the container as on the host. Needed when the primary mount
   * contains an absolute-path symlink pointing outside itself — e.g. a
   * task worktree's symlinked `node_modules`, which points at the shared
   * install in the project's primary clone (see worktree-manager.ts) and
   * would otherwise dangle once the container's mount namespace no longer
   * has that host path reachable at all.
   */
  readOnlyMounts?: string[];
}

/** Env vars forwarded into the sandbox — assembled from scratch (an
 *  allowlist), never the host's `process.env` filtered down. Only what
 *  `npm`/`node`/the target repo's own tooling need to run; no CLI auth
 *  (`ANTHROPIC_*`, `GH_TOKEN`, etc.) since gates never call `gh`/`claude`/
 *  `opencode` — that's the author stage's problem (phase 2/3, not this). */
function sandboxEnv(): Record<string, string> {
  const env: Record<string, string> = {
    HOME: CONTAINER_HOME,
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  };
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("NODE_") || key.startsWith("npm_config_")) env[key] = value;
  }
  return env;
}

/**
 * Run one command inside a disposable `docker run --rm` container: `cwd` is
 * bind-mounted read-write at `/work` (the container's cwd) and nothing else
 * from the host filesystem is reachable — not $HOME, not the orchestrator's
 * own DB, not any other task's worktree — except `readOnlyMounts`, mounted
 * read-only at their own host paths. `cmd` becomes the container's
 * entrypoint so its exit code (and stdout/stderr) map directly onto what a
 * native `execFile(cmd, args, ...)` call would have produced, keeping the
 * caller's existing pass/fail parsing unchanged.
 */
export async function sandboxedExecFile(
  image: string,
  cwd: string,
  cmd: string,
  args: string[],
  opts: SandboxExecOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const envArgs = Object.entries(sandboxEnv()).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const mountArgs = (opts.readOnlyMounts ?? []).flatMap((p) => ["-v", `${p}:${p}:ro`]);
  // Map the container process to the host's own uid:gid so files it writes
  // into the bind-mounted worktree (build output, node_modules, coverage)
  // stay owned by the operator afterward instead of becoming root-owned —
  // official images like node:22 default to root, and root-owned files left
  // behind in a worktree the host user doesn't own can break the very next
  // step (the agent's own `git add`/commit, or worktree cleanup).
  const userArgs =
    typeof process.getuid === "function" && typeof process.getgid === "function"
      ? ["-u", `${process.getuid()}:${process.getgid()}`]
      : [];
  const dockerArgs = [
    "run",
    "--rm",
    "-v",
    `${cwd}:${CONTAINER_WORKDIR}`,
    "-w",
    CONTAINER_WORKDIR,
    ...mountArgs,
    ...userArgs,
    ...envArgs,
    "--entrypoint",
    cmd,
    image,
    ...args,
  ];
  return pexecFile("docker", dockerArgs, {
    encoding: "utf-8",
    timeout: opts.timeout,
    maxBuffer: opts.maxBuffer,
  });
}
