import { execFile } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
  SelfUpdateState,
  SelfUpdateStatusResponse,
} from "@orc/types";

export const SELF_UPDATE_UNIT = "hoopedorc-self-update.service";
const ACTIVE_STATES = new Set<SelfUpdateState>([
  "queued",
  "checking",
  "pulling",
  "installing",
  "building",
  "restarting",
]);
const ALL_STATES = new Set<SelfUpdateState>([
  "idle",
  ...ACTIVE_STATES,
  "succeeded",
  "failed",
]);
const STALE_UPDATE_MS = 2 * 60 * 60 * 1000;

interface PersistedSelfUpdateStatus {
  state: SelfUpdateState;
  message: string;
  startedAt?: string;
  updatedAt?: string;
  finishedAt?: string;
  fromCommit?: string;
  toCommit?: string;
  updateUnit?: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  cwd?: string;
  timeoutMs?: number;
}

export type RunCommand = (
  file: string,
  args: string[],
  options?: CommandOptions,
) => Promise<CommandResult>;

function defaultRunCommand(
  file: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: options.timeoutMs ?? 10_000,
      },
      (error, stdout, stderr) => {
        if (error) {
          const failure = error as Error & { stdout?: string; stderr?: string };
          failure.stdout = stdout;
          failure.stderr = stderr;
          reject(failure);
          return;
        }
        resolvePromise({ stdout, stderr });
      },
    );
  });
}

function compactError(error: unknown): string {
  const candidate = error as Error & { stderr?: string; stdout?: string };
  const detail =
    candidate.stderr?.trim() ||
    candidate.stdout?.trim() ||
    candidate.message ||
    String(error);
  return detail.replace(/\s+/g, " ").slice(0, 500);
}

function isPersistedStatus(value: unknown): value is PersistedSelfUpdateStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.state === "string" &&
    ALL_STATES.has(record.state as SelfUpdateState) &&
    typeof record.message === "string"
  );
}

function idleStatus(): PersistedSelfUpdateStatus {
  return {
    state: "idle",
    message: "No UI update has run yet.",
    updateUnit: SELF_UPDATE_UNIT,
  };
}

export class SelfUpdateRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelfUpdateRefusedError";
  }
}

export interface SelfUpdaterOptions {
  repoRoot: string;
  mock: boolean;
  statusFile?: string;
  platform?: NodeJS.Platform;
  uid?: number;
  username?: string;
  homeDir?: string;
  pathEnv?: string;
  runCommand?: RunCommand;
  now?: () => Date;
}

interface GitState {
  branch?: string;
  commit?: string;
  dirty?: boolean;
  error?: string;
}

interface InfrastructureState {
  available: boolean;
  reason?: string;
}

/**
 * F50's fixed self-update boundary. The HTTP route supplies only the list of
 * active projects; every executable, argument, checkout path and unit name is
 * derived from server-owned deployment state.
 */
export class SelfUpdater {
  readonly repoRoot: string;
  readonly statusFile: string;
  readonly updateUnit = SELF_UPDATE_UNIT;

  private readonly mock: boolean;
  private readonly platform: NodeJS.Platform;
  private readonly uid: number;
  private readonly username: string;
  private readonly homeDir: string;
  private readonly pathEnv: string;
  private readonly runCommand: RunCommand;
  private readonly now: () => Date;
  private readonly bootedAtMs: number;
  private launching = false;

  constructor(options: SelfUpdaterOptions) {
    const account = userInfo();
    this.repoRoot = resolve(options.repoRoot);
    this.mock = options.mock;
    this.platform = options.platform ?? process.platform;
    this.uid = options.uid ?? process.getuid?.() ?? account.uid;
    this.username = options.username ?? account.username;
    this.homeDir = options.homeDir ?? account.homedir ?? homedir();
    this.pathEnv =
      options.pathEnv ??
      process.env.PATH ??
      "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
    this.statusFile =
      options.statusFile ??
      join(this.homeDir, ".hoopedorc", "self-update-status.json");
    this.runCommand = options.runCommand ?? defaultRunCommand;
    this.now = options.now ?? (() => new Date());
    this.bootedAtMs = this.now().getTime();
  }

  private readPersistedStatus(): PersistedSelfUpdateStatus {
    try {
      const parsed = JSON.parse(readFileSync(this.statusFile, "utf8")) as unknown;
      return isPersistedStatus(parsed) ? parsed : idleStatus();
    } catch {
      return idleStatus();
    }
  }

  private writePersistedStatus(status: PersistedSelfUpdateStatus): void {
    mkdirSync(dirname(this.statusFile), { recursive: true });
    const temp = `${this.statusFile}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(status, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temp, this.statusFile);
  }

  private normalizePersistedStatus(
    status: PersistedSelfUpdateStatus,
    currentCommit?: string,
  ): PersistedSelfUpdateStatus {
    const updatedAtMs = status.updatedAt ? Date.parse(status.updatedAt) : Number.NaN;
    const now = this.now();

    // The old server writes "restarting" immediately before systemctl restart.
    // Seeing that marker from a process which booted later is the durable proof
    // that the new service came back successfully.
    if (
      status.state === "restarting" &&
      Number.isFinite(updatedAtMs) &&
      this.bootedAtMs > updatedAtMs
    ) {
      const succeeded: PersistedSelfUpdateStatus = {
        ...status,
        state: "succeeded",
        message: "Update completed and Hoopedorc restarted successfully.",
        updatedAt: now.toISOString(),
        finishedAt: now.toISOString(),
        toCommit: currentCommit ?? status.toCommit,
        updateUnit: SELF_UPDATE_UNIT,
      };
      this.writePersistedStatus(succeeded);
      return succeeded;
    }

    if (
      ACTIVE_STATES.has(status.state) &&
      Number.isFinite(updatedAtMs) &&
      now.getTime() - updatedAtMs > STALE_UPDATE_MS
    ) {
      const failed: PersistedSelfUpdateStatus = {
        ...status,
        state: "failed",
        message:
          `The update stopped reporting progress. Inspect ` +
          `journalctl -u ${SELF_UPDATE_UNIT}.`,
        updatedAt: now.toISOString(),
        finishedAt: now.toISOString(),
        updateUnit: SELF_UPDATE_UNIT,
      };
      this.writePersistedStatus(failed);
      return failed;
    }

    return status;
  }

  private async inspectInfrastructure(): Promise<InfrastructureState> {
    if (this.mock) {
      return {
        available: false,
        reason: "UI updates are disabled in mock mode.",
      };
    }
    if (this.platform !== "linux") {
      return {
        available: false,
        reason: "UI updates require the Linux systemd deployment.",
      };
    }

    let unitDir: string;
    try {
      const result = await this.runCommand(
        "systemctl",
        ["show", "hoopedorc.service", "-p", "WorkingDirectory", "--value"],
        { timeoutMs: 5_000 },
      );
      unitDir = result.stdout.trim();
    } catch (error) {
      return {
        available: false,
        reason: `hoopedorc.service is not available: ${compactError(error)}`,
      };
    }

    if (unitDir !== this.repoRoot) {
      return {
        available: false,
        reason:
          `hoopedorc.service serves ${unitDir || "<unset>"}, not ` +
          `${this.repoRoot}.`,
      };
    }

    try {
      if (this.uid === 0) {
        await this.runCommand("systemd-run", ["--version"], { timeoutMs: 5_000 });
      } else {
        await this.runCommand("sudo", ["-n", "systemd-run", "--version"], {
          timeoutMs: 5_000,
        });
        await this.runCommand(
          "sudo",
          [
            "-n",
            "-l",
            "systemctl",
            "restart",
            "hoopedorc.service",
          ],
          { timeoutMs: 5_000 },
        );
      }
    } catch (error) {
      return {
        available: false,
        reason:
          "The service user cannot run the passwordless systemd launch/restart commands: " +
          compactError(error),
      };
    }

    return { available: true };
  }

  private async inspectGit(): Promise<GitState> {
    try {
      const [branch, commit, status] = await Promise.all([
        this.runCommand("git", ["branch", "--show-current"], {
          cwd: this.repoRoot,
        }),
        this.runCommand("git", ["rev-parse", "--short", "HEAD"], {
          cwd: this.repoRoot,
        }),
        this.runCommand(
          "git",
          ["status", "--porcelain", "--untracked-files=normal"],
          { cwd: this.repoRoot },
        ),
      ]);
      return {
        branch: branch.stdout.trim(),
        commit: commit.stdout.trim(),
        dirty: status.stdout.trim().length > 0,
      };
    } catch (error) {
      return { error: compactError(error) };
    }
  }

  private async buildStatus(
    activeProjectNames: string[],
    includeLaunching: boolean,
    runtimeBlocker?: string,
  ): Promise<SelfUpdateStatusResponse> {
    const [infrastructure, git] = this.mock
      ? [await this.inspectInfrastructure(), {}]
      : await Promise.all([this.inspectInfrastructure(), this.inspectGit()]);
    const persisted = this.normalizePersistedStatus(
      this.readPersistedStatus(),
      git.commit,
    );

    let blockedReason: string | undefined;
    if (ACTIVE_STATES.has(persisted.state) || (includeLaunching && this.launching)) {
      blockedReason = "An update is already in progress.";
    } else if (activeProjectNames.length > 0) {
      const shown = activeProjectNames.slice(0, 3).join(", ");
      const remaining = activeProjectNames.length - Math.min(activeProjectNames.length, 3);
      blockedReason =
        `Stop or pause the running project${activeProjectNames.length === 1 ? "" : "s"} ` +
        `${shown}${remaining > 0 ? ` and ${remaining} more` : ""} before updating.`;
    } else if (runtimeBlocker) {
      blockedReason = runtimeBlocker;
    } else if (git.error) {
      blockedReason = `Git state could not be verified: ${git.error}`;
    } else if (git.branch !== "main") {
      blockedReason = `The deployed checkout must be on main (currently ${git.branch || "detached"}).`;
    } else if (git.dirty) {
      blockedReason =
        "The Hoopedorc checkout has unrelated changes. Commit or remove them before updating.";
    }

    return {
      available: infrastructure.available,
      unavailableReason: infrastructure.reason,
      blockedReason,
      state: persisted.state,
      message: persisted.message,
      startedAt: persisted.startedAt,
      updatedAt: persisted.updatedAt,
      finishedAt: persisted.finishedAt,
      branch: git.branch,
      fromCommit: persisted.fromCommit ?? git.commit,
      toCommit: persisted.toCommit,
      updateUnit: SELF_UPDATE_UNIT,
    };
  }

  async status(
    activeProjectNames: string[] = [],
    runtimeBlocker?: string,
  ): Promise<SelfUpdateStatusResponse> {
    return this.buildStatus(activeProjectNames, true, runtimeBlocker);
  }

  async start(
    activeProjectNames: string[] = [],
    runtimeBlocker?: string,
  ): Promise<SelfUpdateStatusResponse> {
    if (this.launching) {
      throw new SelfUpdateRefusedError("An update is already being launched.");
    }
    this.launching = true;

    try {
      const status = await this.buildStatus(
        activeProjectNames,
        false,
        runtimeBlocker,
      );
      if (!status.available) {
        throw new SelfUpdateRefusedError(
          status.unavailableReason ?? "UI updates are not available.",
        );
      }
      if (status.blockedReason) {
        throw new SelfUpdateRefusedError(status.blockedReason);
      }

      const startedAt = this.now().toISOString();
      this.writePersistedStatus({
        state: "queued",
        message: "Update queued in a separate systemd service.",
        startedAt,
        updatedAt: startedAt,
        fromCommit: status.fromCommit,
        updateUnit: SELF_UPDATE_UNIT,
      });

      const script = join(this.repoRoot, "scripts", "update.sh");
      const systemdArgs = [
        `--unit=${SELF_UPDATE_UNIT.replace(/\.service$/, "")}`,
        "--collect",
        "--service-type=exec",
        `--uid=${this.username}`,
        `--working-directory=${this.repoRoot}`,
        `--setenv=HOME=${this.homeDir}`,
        `--setenv=USER=${this.username}`,
        `--setenv=LOGNAME=${this.username}`,
        `--setenv=PATH=${this.pathEnv}`,
        "--",
        "/usr/bin/bash",
        script,
        "--non-interactive",
        "--require-main",
        "--require-systemd-restart",
        "--status-file",
        this.statusFile,
        "--started-at",
        startedAt,
      ];

      try {
        if (this.uid === 0) {
          await this.runCommand("systemd-run", systemdArgs, {
            cwd: this.repoRoot,
            timeoutMs: 15_000,
          });
        } else {
          await this.runCommand("sudo", ["-n", "systemd-run", ...systemdArgs], {
            cwd: this.repoRoot,
            timeoutMs: 15_000,
          });
        }
      } catch (error) {
        const now = this.now().toISOString();
        this.writePersistedStatus({
          state: "failed",
          message:
            `Could not launch ${SELF_UPDATE_UNIT}: ${compactError(error)} ` +
            `Inspect journalctl -u ${SELF_UPDATE_UNIT}.`,
          startedAt,
          updatedAt: now,
          finishedAt: now,
          fromCommit: status.fromCommit,
          updateUnit: SELF_UPDATE_UNIT,
        });
        throw new SelfUpdateRefusedError(
          `Could not launch the update service: ${compactError(error)}`,
        );
      }

      return this.buildStatus(activeProjectNames, false, runtimeBlocker);
    } finally {
      this.launching = false;
    }
  }

}
