import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { execManagedProcess, safeNpmConfigEnv } from "@orc/adapters";

// F13-P1 (phase 1 of docs/specs/sandbox.md): runs gate scripts and
// `ensureDeps`'s `npm ci|install` inside Docker instead of directly on the
// host. Deliberately NOT `sanitizedEnv()` minus a denylist — a container
// boundary makes an allowlist assembled from scratch cheap to maintain, per
// the spec doc's two-layer env note, so the container's env is built up from
// nothing rather than filtered down from the host's.

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
const CONTAINER_NPM_CACHE = `${CONTAINER_HOME}/.npm`;
const CONTAINER_CERT_DIR = "/run/hoopedorc-certs";
const MAX_CERTIFICATE_BUNDLE_BYTES = 5 * 1024 * 1024;

interface ReadOnlyMount {
  source: string;
  target: string;
}

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

export const DOCKER_PROBE_TTL_MS = 30_000;

let dockerProbeResult: Promise<boolean> | null = null;
let dockerProbeAt = 0;

async function runDockerVersionProbe(): Promise<boolean> {
  try {
    await execManagedProcess("docker", ["version"], { timeoutMs: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a Docker daemon responds. The short cache avoids a subprocess for
 * every gate while still recovering when Docker Desktop/the daemon starts or
 * stops after Hoopedorc. Failed docker executions invalidate it immediately.
 */
export function detectDocker(
  probe: () => Promise<boolean> = runDockerVersionProbe,
  options: { now?: () => number; ttlMs?: number } = {},
): Promise<boolean> {
  const now = (options.now ?? Date.now)();
  const ttlMs = options.ttlMs ?? DOCKER_PROBE_TTL_MS;
  if (!dockerProbeResult || now - dockerProbeAt >= ttlMs) {
    dockerProbeAt = now;
    dockerProbeResult = probe().catch(() => false);
  }
  return dockerProbeResult;
}

export function invalidateDockerDetection(): void {
  dockerProbeResult = null;
  dockerProbeAt = 0;
}

/** Test-only: clears the cached probe so a test can simulate the daemon
 *  appearing/disappearing between calls. */
export function _resetDockerDetectionForTests(): void {
  invalidateDockerDetection();
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
  warnedNoDockerForAuto = false;
  return { useSandbox: true, detail: "docker (auto)" };
}

export interface SandboxExecOptions {
  timeout?: number;
  maxBuffer?: number;
  signal?: AbortSignal;
  /**
   * Additional read-only bind mounts, each mounted at the SAME absolute path
   * inside the container as on the host. B38 dependencies normally live in
   * the worktree itself; this compatibility escape hatch is needed only when
   * the primary mount contains a legacy/user-provided symlink whose target is
   * outside it and would otherwise dangle in the container mount namespace.
   */
  readOnlyMounts?: string[];
}

/**
 * Resolve an operator-provided PEM certificate bundle into one file-only,
 * read-only mount. A Docker sandbox cannot safely use arbitrary host paths
 * from environment variables: a missing path breaks npm, and mounting a
 * directory or arbitrary file would violate the worktree-only isolation
 * boundary. Both npm's `cafile` and Node's `NODE_EXTRA_CA_CERTS` name PEM
 * bundles, so require a bounded regular file with a certificate marker.
 */
function certificateMount(value: string, target: string): ReadOnlyMount | undefined {
  if (!isAbsolute(value)) return undefined;
  try {
    const source = realpathSync(value);
    const stats = statSync(source);
    if (!lstatSync(source).isFile() || stats.size <= 0 || stats.size > MAX_CERTIFICATE_BUNDLE_BYTES) {
      return undefined;
    }
    return readFileSync(source, "utf8").includes("-----BEGIN CERTIFICATE-----")
      ? { source, target }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Env vars forwarded into the sandbox — assembled from scratch (an
 *  allowlist), never the host's `process.env` filtered down. Only what
 *  `npm`/`node`/the target repo's own tooling need to run; no CLI auth
 *  (`ANTHROPIC_*`, `GH_TOKEN`, etc.) since gates never call `gh`/`claude`/
 *  `opencode` — that's the author stage's problem (phase 2/3, not this). */
function sandboxEnv(): { env: Record<string, string>; readOnlyMounts: ReadOnlyMount[] } {
  const env: Record<string, string> = {
    HOME: CONTAINER_HOME,
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  };
  const readOnlyMounts: ReadOnlyMount[] = [];
  for (const [key, value] of Object.entries(safeNpmConfigEnv())) {
    if (value === undefined) continue;
    const normalized = key.toLowerCase();
    if (normalized === "npm_config_cache") continue;
    if (normalized === "npm_config_cafile") {
      const mount = certificateMount(value, `${CONTAINER_CERT_DIR}/npm-cafile.pem`);
      if (mount) {
        env.npm_config_cafile = mount.target;
        readOnlyMounts.push(mount);
      }
      continue;
    }
    env[key] = value;
  }
  // The service itself is started through npm, which exports its host cache
  // path (for example /home/ubuntu/.npm). npm inside Docker must never try to
  // create that unmounted host path; its disposable cache belongs under the
  // container HOME instead.
  env.npm_config_cache = CONTAINER_NPM_CACHE;

  const extraCaCerts = process.env.NODE_EXTRA_CA_CERTS;
  if (extraCaCerts !== undefined) {
    const mount = certificateMount(
      extraCaCerts,
      `${CONTAINER_CERT_DIR}/node-extra-ca-certs.pem`,
    );
    if (mount) {
      env.NODE_EXTRA_CA_CERTS = mount.target;
      readOnlyMounts.push(mount);
    }
  }
  const nodeEnv = process.env.NODE_ENV;
  if (nodeEnv !== undefined) {
    env.NODE_ENV = nodeEnv;
  }
  return { env, readOnlyMounts };
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
  runner: typeof execManagedProcess = execManagedProcess,
): Promise<{ stdout: string; stderr: string }> {
  const sandbox = sandboxEnv();
  const envArgs = Object.entries(sandbox.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const mountArgs = [
    ...(opts.readOnlyMounts ?? []).flatMap((p) => ["-v", `${p}:${p}:ro`]),
    ...sandbox.readOnlyMounts.flatMap(({ source, target }) => ["-v", `${source}:${target}:ro`]),
  ];
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
  const containerName = `hoopedorc-${randomUUID()}`;
  const dockerArgs = [
    "run",
    "--rm",
    "--name",
    containerName,
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
  try {
    return await runner("docker", dockerArgs, {
      signal: opts.signal,
      timeoutMs: opts.timeout,
      maxOutputBytes: opts.maxBuffer,
    });
  } catch (err) {
    invalidateDockerDetection();
    // Killing the docker CLI does not guarantee the daemon stopped the
    // container. The unique name gives us an unambiguous cleanup target.
    await runner("docker", ["rm", "-f", containerName], {
      timeoutMs: 10_000,
      maxOutputBytes: 1024 * 1024,
    }).catch(() => {});
    throw err;
  }
}
