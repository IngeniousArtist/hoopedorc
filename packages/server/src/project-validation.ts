import { execFile } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { isPlausibleImageRef } from "@orc/engine";
import {
  SECRET_SENTINEL,
  type MergePolicy,
  type ProjectConfig,
  type Settings,
} from "@orc/types";
import { parseSetupCommand } from "./project-config.js";

const pexecFile = promisify(execFile);
const VALID_BRANCH_NAME = /^[A-Za-z0-9._/-]+$/;
const VALID_REPO_URL =
  /^(https:\/\/github\.com\/[\w.-]+\/[\w.-]+|git@github\.com:[\w.-]+\/[\w.-]+)(\.git)?\/?$/;
const VALID_MERGE_POLICIES: MergePolicy[] = [
  "hard_gate_flag_risky",
  "fully_autonomous",
  "always_ask",
];

/** Branch names are passed to Git as argv but still must not become flags. */
export function isValidBranchName(branch: string): boolean {
  return VALID_BRANCH_NAME.test(branch) && !branch.startsWith("-");
}

/** Only the GitHub URL forms supported by the Git/GitHub boundaries. */
export function isValidRepoUrl(url: string): boolean {
  return VALID_REPO_URL.test(url);
}

/**
 * Validate and normalize a project's config override. Returns the first
 * actionable field error, or a canonical value (`undefined` means no override).
 */
export function parseProjectConfig(
  input: unknown,
): { error: string } | { value: ProjectConfig | undefined } {
  if (input == null) return { value: undefined };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { error: "config must be an object" };
  }
  const raw = input as Record<string, unknown>;
  const value: ProjectConfig = {};

  if (raw.setupCommand !== undefined) {
    const parsed = parseSetupCommand(raw.setupCommand);
    if ("error" in parsed) return parsed;
    value.setupCommand = parsed.value;
  }

  if (raw.maxAttempts !== undefined) {
    const n = raw.maxAttempts;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 20) {
      return { error: "config.maxAttempts must be an integer between 1 and 20" };
    }
    value.maxAttempts = n;
  }

  if (raw.mergePolicy !== undefined) {
    if (!VALID_MERGE_POLICIES.includes(raw.mergePolicy as MergePolicy)) {
      return {
        error:
          `config.mergePolicy must be one of: ` +
          VALID_MERGE_POLICIES.join(", "),
      };
    }
    value.mergePolicy = raw.mergePolicy as MergePolicy;
  }

  if (raw.gates !== undefined) {
    if (
      typeof raw.gates !== "object" ||
      raw.gates === null ||
      Array.isArray(raw.gates)
    ) {
      return { error: "config.gates must be an object" };
    }
    const rawGates = raw.gates as Record<string, unknown>;
    const gates: NonNullable<ProjectConfig["gates"]> = {};
    for (const key of [
      "typecheckScript",
      "lintScript",
      "buildScript",
      "testScript",
    ] as const) {
      const candidate = rawGates[key];
      if (candidate === undefined) continue;
      if (candidate === false) {
        gates[key] = false;
        continue;
      }
      if (
        typeof candidate === "string" &&
        candidate.trim().length > 0 &&
        candidate.length <= 100
      ) {
        gates[key] = candidate.trim();
        continue;
      }
      return {
        error:
          `config.gates.${key} must be a non-empty script name ` +
          `(<=100 chars) or false`,
      };
    }
    if (rawGates.testCommand !== undefined) {
      if (
        typeof rawGates.testCommand !== "string" ||
        rawGates.testCommand.length > 500
      ) {
        return { error: "config.gates.testCommand must be a string (<=500 chars)" };
      }
      const trimmed = rawGates.testCommand.trim();
      if (trimmed) gates.testCommand = trimmed;
    }
    if (Object.keys(gates).length > 0) value.gates = gates;
  }

  if (raw.requireGithubChecks !== undefined) {
    if (typeof raw.requireGithubChecks !== "boolean") {
      return { error: "config.requireGithubChecks must be a boolean" };
    }
    value.requireGithubChecks = raw.requireGithubChecks;
  }

  if (raw.githubChecksTimeoutMin !== undefined) {
    const n = raw.githubChecksTimeoutMin;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 120) {
      return {
        error:
          "config.githubChecksTimeoutMin must be an integer between 1 and 120",
      };
    }
    value.githubChecksTimeoutMin = n;
  }

  if (raw.perTaskDocs !== undefined) {
    if (typeof raw.perTaskDocs !== "boolean") {
      return { error: "config.perTaskDocs must be a boolean" };
    }
    value.perTaskDocs = raw.perTaskDocs;
  }

  if (raw.skillHints !== undefined) {
    if (!Array.isArray(raw.skillHints)) {
      return { error: "config.skillHints must be an array of strings" };
    }
    if (raw.skillHints.length > 20) {
      return { error: "config.skillHints must have at most 20 entries" };
    }
    const hints: string[] = [];
    for (const hint of raw.skillHints) {
      if (typeof hint !== "string" || hint.length > 200) {
        return {
          error:
            "config.skillHints entries must be strings of at most 200 chars",
        };
      }
      const trimmed = hint.trim();
      if (trimmed) hints.push(trimmed);
    }
    if (hints.length > 0) value.skillHints = hints;
  }

  if (raw.gateImage !== undefined) {
    if (
      typeof raw.gateImage !== "string" ||
      !isPlausibleImageRef(raw.gateImage)
    ) {
      return {
        error:
          "config.gateImage must be a plausible Docker image reference " +
          "(<=200 chars)",
      };
    }
    value.gateImage = raw.gateImage;
  }

  if (raw.schedule !== undefined) {
    if (
      typeof raw.schedule !== "object" ||
      raw.schedule === null ||
      Array.isArray(raw.schedule)
    ) {
      return { error: "config.schedule must be an object" };
    }
    const schedule = raw.schedule as Record<string, unknown>;
    if (typeof schedule.enabled !== "boolean") {
      return { error: "config.schedule.enabled must be a boolean" };
    }
    if (schedule.mode !== "interval" && schedule.mode !== "daily") {
      return { error: 'config.schedule.mode must be "interval" or "daily"' };
    }
    if (schedule.mode === "interval") {
      const hours = schedule.intervalHours;
      if (
        typeof hours !== "number" ||
        !Number.isInteger(hours) ||
        hours < 1 ||
        hours > 24 * 30
      ) {
        return {
          error:
            "config.schedule.intervalHours must be an integer between 1 and 720",
        };
      }
      value.schedule = {
        enabled: schedule.enabled,
        mode: "interval",
        intervalHours: hours,
      };
    } else {
      const hour = schedule.hour;
      const minute = schedule.minute;
      if (
        typeof hour !== "number" ||
        !Number.isInteger(hour) ||
        hour < 0 ||
        hour > 23
      ) {
        return {
          error: "config.schedule.hour must be an integer between 0 and 23",
        };
      }
      if (
        typeof minute !== "number" ||
        !Number.isInteger(minute) ||
        minute < 0 ||
        minute > 59
      ) {
        return {
          error: "config.schedule.minute must be an integer between 0 and 59",
        };
      }
      value.schedule = {
        enabled: schedule.enabled,
        mode: "daily",
        hour,
        minute,
      };
    }
  }

  return { value: Object.keys(value).length > 0 ? value : undefined };
}

function isPathAncestorOrSame(ancestor: string, candidate: string): boolean {
  const normalizedAncestor = ancestor.endsWith("/")
    ? ancestor.slice(0, -1)
    : ancestor;
  const normalizedCandidate = candidate.endsWith("/")
    ? candidate.slice(0, -1)
    : candidate;
  return (
    normalizedCandidate === normalizedAncestor ||
    normalizedCandidate.startsWith(`${normalizedAncestor}/`)
  );
}

export interface LocalPathValidationContext {
  reposDir: string;
  homeDir?: string;
  serverCwd?: string;
}

/** Prevent a clone path from containing durable server/operator state. */
export function validateLocalPath(
  localPath: string,
  context: LocalPathValidationContext,
): string | null {
  if (!isAbsolute(localPath)) {
    return "localPath must be an absolute path";
  }
  const resolved = resolve(localPath);
  const home = resolve(context.homeDir ?? homedir());
  const serverCwd = resolve(context.serverCwd ?? process.cwd());
  const reposDir = resolve(context.reposDir);
  if (resolved === "/") return "localPath cannot be '/'";
  if (resolved === home) {
    return "localPath cannot be the home directory itself";
  }
  if (isPathAncestorOrSame(resolved, serverCwd)) {
    return (
      "localPath cannot be an ancestor of (or the same as) the server's " +
      "own working directory"
    );
  }
  if (isPathAncestorOrSame(resolved, reposDir)) {
    return (
      "localPath cannot be an ancestor of (or the same as) the repos directory"
    );
  }
  return null;
}

async function gitOutput(
  cwd: string,
  args: string[],
): Promise<string | null> {
  try {
    const { stdout } = await pexecFile("git", args, {
      cwd,
      encoding: "utf-8",
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** Existing non-empty paths must already be the exact requested clone. */
export async function localPathOkForClone(
  localPath: string,
  repoUrl: string,
): Promise<string | null> {
  if (!existsSync(localPath)) return null;
  if (!statSync(localPath).isDirectory()) {
    return "localPath already exists and is not a directory";
  }
  if (readdirSync(localPath).length === 0) return null;

  const origin = await gitOutput(localPath, ["remote", "get-url", "origin"]);
  if (origin === repoUrl) return null;
  return origin
    ? `localPath already exists and is a git clone of a different repository (${origin})`
    : "localPath already exists, is non-empty, and is not a git clone of this repository";
}

function hasRepositoryAncestor(localPath: string): boolean {
  let current = dirname(resolve(localPath));
  while (true) {
    if (existsSync(join(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function canonicalPath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * Fail-closed disk cleanup predicate. Project-row deletion remains independent:
 * a refusal here preserves the clone for explicit operator cleanup.
 */
export async function safeToDeleteLocalPath(
  localPath: string,
  repoUrl: string,
  homeDir = homedir(),
): Promise<boolean> {
  if (localPath.length <= resolve(homeDir).length + 1) return false;
  if (!existsSync(localPath)) return false;
  try {
    if (lstatSync(localPath).isSymbolicLink()) return false;
    const gitMetadata = join(localPath, ".git");
    if (!existsSync(gitMetadata) || lstatSync(gitMetadata).isSymbolicLink()) {
      return false;
    }
  } catch {
    return false;
  }
  if (hasRepositoryAncestor(localPath)) return false;

  const topLevel = await gitOutput(localPath, ["rev-parse", "--show-toplevel"]);
  const actualPath = canonicalPath(localPath);
  const actualTopLevel = topLevel ? canonicalPath(topLevel) : null;
  if (!actualPath || !actualTopLevel || actualPath !== actualTopLevel) {
    return false;
  }

  const origin = await gitOutput(localPath, ["remote", "get-url", "origin"]);
  if (origin !== repoUrl) return false;

  const status = await gitOutput(localPath, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  return status === "";
}

/** Replace write-only settings secrets before any API response. */
export function redactSettings(settings: Settings): Settings {
  return {
    ...settings,
    apiToken: settings.apiToken ? SECRET_SENTINEL : undefined,
    telegram: settings.telegram && {
      ...settings.telegram,
      botToken: settings.telegram.botToken ? SECRET_SENTINEL : undefined,
    },
  };
}

/** Constant-time token-content comparison with an explicit length guard. */
export function safeTokenEqual(
  candidate: string | undefined,
  expected: string,
): boolean {
  if (candidate === undefined) return false;
  const candidateBytes = Buffer.from(candidate, "utf-8");
  const expectedBytes = Buffer.from(expected, "utf-8");
  if (candidateBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(candidateBytes, expectedBytes);
}

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** Explain an unsafe unauthenticated bind; `null` means startup is allowed. */
export function unauthenticatedBindingError(
  host: string,
  apiToken: string | undefined,
  allowUnauthenticated: boolean,
): string | null {
  if (isLoopbackHost(host) || apiToken || allowUnauthenticated) return null;
  return (
    `HOST=${host} exposes the API beyond localhost with no API_TOKEN set. ` +
    `Set API_TOKEN (or settings.apiToken) to require auth, or set ` +
    `ALLOW_UNAUTHENTICATED=1 to start anyway (not recommended).`
  );
}
