import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { execManagedProcess, sanitizedEnv } from "@orc/adapters";
import type { GateResult, Project, ProjectConfig, Settings, Task } from "@orc/types";
import type { GateRunner, WorktreeManager } from "./index.js";
import {
  DEFAULT_GATE_IMAGE,
  resolveSandboxMode,
  sandboxedExecFile,
  SANDBOX_TIMEOUT_GRACE_MS,
} from "./sandbox.js";

const GATE_TIMEOUT_MS = 120_000;

/** Resolved once per `run()` call and threaded through every gate so a
 *  single task's gates don't each independently re-decide (and potentially
 *  disagree on) whether they're sandboxed. */
type GateExecContext =
  | { sandboxed: false }
  | { sandboxed: true; image: string; readOnlyMounts: string[] };

/** F13-P1 test seam: lets gate-runner.test.ts cover Docker mode selection
 *  and dispatch with a fake exec layer instead of a real daemon. Defaults to
 *  the real implementations in production. */
export interface SandboxDeps {
  resolveMode: typeof resolveSandboxMode;
  exec: typeof sandboxedExecFile;
}

const REAL_SANDBOX_DEPS: SandboxDeps = {
  resolveMode: resolveSandboxMode,
  exec: sandboxedExecFile,
};

function processOutput(stdout: string, stderr?: string): string {
  return [stdout, stderr].filter((value) => value && value.trim()).join("\n");
}

/**
 * Whether `cwd`'s package.json declares a non-empty npm script named
 * `script`. `npm run <script> --if-present` exits 0 whether or not the
 * script exists (verified directly against the installed npm) — it does NOT
 * throw for a missing script the way earlier code here assumed, so relying
 * on a thrown error to detect "nothing to run" silently defeated vacuous-gate
 * detection (B11) for every real repo. Checking package.json directly is
 * unambiguous.
 */
function hasNpmScript(cwd: string, script: string): boolean {
  try {
    const pkgPath = join(cwd, "package.json");
    if (!existsSync(pkgPath)) return false;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      scripts?: Record<string, unknown>;
    };
    const cmd = pkg.scripts?.[script];
    return typeof cmd === "string" && cmd.trim().length > 0;
  } catch {
    return false;
  }
}

export class GateRunnerImpl implements GateRunner {
  constructor(
    private readonly worktrees: WorktreeManager,
    // Narrowed to just the one field this class reads (rather than the full
    // `Settings`) so callers — tests especially — don't need to fabricate an
    // entire valid Settings object just to pick a sandbox mode.
    private readonly settings?: Pick<Settings, "sandboxGates">,
    private readonly sandbox: SandboxDeps = REAL_SANDBOX_DEPS,
  ) {}

  async run(project: Project, task: Task, signal?: AbortSignal): Promise<GateResult> {
    const worktreePath = task.worktreePath;
    if (!worktreePath) {
      return this.allFail("no worktree path set");
    }

    let ctx: GateExecContext;
    try {
      signal?.throwIfAborted();
      const resolved = await this.sandbox.resolveMode(this.settings?.sandboxGates);
      if (resolved.useSandbox) {
        // B38 materializes independent dependencies inside each worktree. Keep
        // compatibility with pre-B38/external node_modules symlinks: Docker
        // cannot see a sibling target unless it is bind-mounted at the same
        // host path. Ordinary local directories need no additional mount.
        let dependencyCache: string | undefined;
        try {
          const worktreeNodeModules = join(worktreePath, "node_modules");
          if (lstatSync(worktreeNodeModules).isSymbolicLink()) {
            dependencyCache = realpathSync(worktreeNodeModules);
          }
        } catch {
          /* non-Node project, or setup did not create a dependency link */
        }
        ctx = {
          sandboxed: true,
          image: project.config?.gateImage || DEFAULT_GATE_IMAGE,
          readOnlyMounts:
            dependencyCache && existsSync(dependencyCache) ? [dependencyCache] : [],
        };
      } else {
        ctx = { sandboxed: false };
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      // "required" with no daemon — fail loudly rather than silently running
      // on the host, per Settings.sandboxGates's contract.
      return this.allFail((err as Error).message);
    }

    const gates = project.config?.gates;
    const typecheck = await this.runGate(task, worktreePath, "typecheck", gates?.typecheckScript, ctx, signal);
    const lint = await this.runGate(task, worktreePath, "lint", gates?.lintScript, ctx, signal);
    const build = await this.runGate(task, worktreePath, "build", gates?.buildScript, ctx, signal);
    const tests = await this.runTestsGate(task, worktreePath, gates, ctx, signal);
    const noConflictsGate = await this.withCleanWorktree(task, "no-conflicts", async () => ({
      passed: await this.checkNoConflicts(project, worktreePath, signal),
      ran: true,
      output: "",
    }));
    const noConflicts = noConflictsGate.passed;
    const inScope = await this.worktrees.changedFilesInScope(project, task);
    // Every objective gate was a no-op (script-less repo, e.g. a brand-new
    // scaffold) — nothing actually verified this change; canAutoMerge treats
    // this as risky unless the operator opted in.
    const vacuous = !typecheck.ran && !lint.ran && !build.ran && !tests.ran;

    return {
      typecheck: typecheck.passed,
      lint: lint.passed,
      build: build.passed,
      tests: tests.passed,
      noConflicts,
      inScope,
      vacuous,
      details: {
        typecheck: typecheck.output,
        lint: lint.output,
        build: build.output,
        tests: tests.output,
        noConflicts: noConflicts
          ? ""
          : noConflictsGate.output || "conflicts with default branch detected",
        inScope: inScope ? "" : "files modified outside task.scopePaths",
      },
    };
  }

  /** typecheck/lint/build: run the configured script name (or the slot's
   *  default), or skip entirely when the override is `false`. */
  private async runGate(
    task: Task,
    cwd: string,
    slot: string,
    scriptOverride: string | false | undefined,
    ctx: GateExecContext,
    signal?: AbortSignal,
  ): Promise<{ passed: boolean; ran: boolean; output: string }> {
    if (scriptOverride === false) {
      return { passed: true, ran: false, output: `gate "${slot}" disabled by project config` };
    }
    // An override is an explicit operator choice, unlike the default slot name
    // — if it names a script that doesn't exist (typo, or the repo renamed its
    // scripts), that's a real gate failure, not "nothing to run" (mirrors
    // runCommand's reasoning for testCommand).
    if (typeof scriptOverride === "string" && !hasNpmScript(cwd, scriptOverride)) {
      return {
        passed: false,
        ran: true,
        output: `configured gate script "${scriptOverride}" not found in package.json`,
      };
    }
    return this.runScript(task, cwd, scriptOverride || slot, ctx, signal);
  }

  private async runTestsGate(
    task: Task,
    cwd: string,
    gates: ProjectConfig["gates"] | undefined,
    ctx: GateExecContext,
    signal?: AbortSignal,
  ): Promise<{ passed: boolean; ran: boolean; output: string }> {
    if (gates?.testScript === false) {
      return { passed: true, ran: false, output: 'gate "test" disabled by project config' };
    }
    if (gates?.testCommand) {
      return this.runCommand(task, cwd, gates.testCommand, ctx, signal);
    }
    if (gates?.testScript) {
      if (!hasNpmScript(cwd, gates.testScript)) {
        return {
          passed: false,
          ran: true,
          output: `configured gate script "${gates.testScript}" not found in package.json`,
        };
      }
      return this.runScript(task, cwd, gates.testScript, ctx, signal);
    }
    // Default: support either a "test" or "tests" npm script; both must pass if present.
    const testRun = await this.runScript(task, cwd, "test", ctx, signal);
    const testsRun = await this.runScript(task, cwd, "tests", ctx, signal);
    return {
      passed: testRun.passed && testsRun.passed,
      ran: testRun.ran || testsRun.ran,
      output: [testRun.output, testsRun.output].filter(Boolean).join("\n"),
    };
  }

  /**
   * Run a free-form command (F9's non-npm test override) directly via
   * execFile — split on whitespace, no shell, so quoting/pipes aren't
   * supported. Unlike runScript's "--if-present" no-op path, this command was
   * explicitly configured by the operator, so any failure (including "the
   * command doesn't exist") is a real gate failure, not a silent pass.
   */
  private async runCommand(
    task: Task,
    cwd: string,
    command: string,
    ctx: GateExecContext,
    signal?: AbortSignal,
  ): Promise<{ passed: boolean; ran: boolean; output: string }> {
    const [cmd, ...args] = command.trim().split(/\s+/).filter(Boolean);
    if (!cmd) return { passed: true, ran: false, output: "empty testCommand" };
    return this.withCleanWorktree(task, `command "${command}"`, async () => {
      try {
        const { stdout, stderr } = await this.exec(ctx, cwd, cmd, args, signal);
        return { passed: true, ran: true, output: processOutput(stdout, stderr) };
      } catch (err: unknown) {
        if (signal?.aborted) throw err;
        const e = err as { stderr?: string; stdout?: string; message?: string; killed?: boolean };
        const out = e.stderr || e.stdout || e.message || "";
        if (e.killed) {
          return { passed: false, ran: true, output: `command "${command}" timed out` };
        }
        return { passed: false, ran: true, output: String(out) };
      }
    });
  }

  private async runScript(
    task: Task,
    cwd: string,
    script: string,
    ctx: GateExecContext,
    signal?: AbortSignal,
  ): Promise<{ passed: boolean; ran: boolean; output: string }> {
    if (!hasNpmScript(cwd, script)) {
      return { passed: true, ran: false, output: `script "${script}" not defined in package.json` };
    }
    return this.withCleanWorktree(task, `script "${script}"`, async () => {
      try {
        const { stdout, stderr } = await this.exec(
          ctx,
          cwd,
          "npm",
          ["run", script, "--if-present"],
          signal,
        );
        return { passed: true, ran: true, output: processOutput(stdout, stderr) };
      } catch (err: unknown) {
        if (signal?.aborted) throw err;
        const e = err as {
          stderr?: string;
          stdout?: string;
          message?: string;
          killed?: boolean;
        };
        const out = e.stderr || e.stdout || e.message || "";
        if (e.killed) {
          return { passed: false, ran: true, output: `script "${script}" timed out` };
        }
        // hasNpmScript already proved the script is declared. ENOENT and
        // every other spawn/infrastructure failure are real failed gates.
        return { passed: false, ran: true, output: String(out) };
      }
    });
  }

  private async withCleanWorktree(
    task: Task,
    label: string,
    execute: () => Promise<{ passed: boolean; ran: boolean; output: string }>,
  ): Promise<{ passed: boolean; ran: boolean; output: string }> {
    const before = await this.worktrees.worktreeChanges(task);
    if (!before.ok) {
      return {
        passed: false,
        ran: true,
        output: `could not inspect worktree before ${label}: ${before.error ?? "unknown git error"}`,
      };
    }
    if (before.value.length > 0) {
      const restored = await this.worktrees.restoreToHead(task);
      return {
        passed: false,
        ran: true,
        output:
          `worktree was dirty before ${label}: ${before.value.join(", ")}` +
          (restored.ok ? " (restored to HEAD)" : `; restore failed: ${restored.error}`),
      };
    }

    const result = await execute();
    const after = await this.worktrees.worktreeChanges(task);
    if (!after.ok) {
      const restored = await this.worktrees.restoreToHead(task);
      return {
        passed: false,
        ran: true,
        output:
          `${result.output}\ncould not inspect worktree after ${label}: ` +
          `${after.error ?? "unknown git error"}` +
          (restored.ok ? " (restored to HEAD)" : `; restore failed: ${restored.error}`),
      };
    }
    if (after.value.length === 0) return result;

    const restored = await this.worktrees.restoreToHead(task);
    return {
      passed: false,
      ran: true,
      output:
        `${result.output}\n${label} modified the worktree: ${after.value.join(", ")}` +
        (restored.ok ? " (restored to HEAD)" : `; restore failed: ${restored.error}`),
    };
  }

  /** Dispatches to Docker or a direct host `execFile`, per the mode resolved
   *  once at the top of `run()`. Sandboxed calls get a fixed extra grace on
   *  top of the normal gate timeout — container startup isn't instant, and a
   *  script that would have passed natively shouldn't fail purely from that
   *  overhead. */
  private async exec(
    ctx: GateExecContext,
    cwd: string,
    cmd: string,
    args: string[],
    signal?: AbortSignal,
  ): Promise<{ stdout: string; stderr?: string }> {
    if (!ctx.sandboxed) {
      return execManagedProcess(cmd, args, {
        cwd,
        signal,
        timeoutMs: GATE_TIMEOUT_MS,
        maxOutputBytes: 16 * 1024 * 1024,
        env: sanitizedEnv({ PWD: cwd }),
      });
    }
    return this.sandbox.exec(ctx.image, cwd, cmd, args, {
      timeout: GATE_TIMEOUT_MS + SANDBOX_TIMEOUT_GRACE_MS,
      maxBuffer: 16 * 1024 * 1024,
      readOnlyMounts: ctx.readOnlyMounts,
      signal,
    });
  }

  private async checkNoConflicts(
    project: Project,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    try {
      await execManagedProcess("git", ["fetch", "origin", project.defaultBranch], {
        cwd,
        signal,
        timeoutMs: 30_000,
      });
    } catch {
      signal?.throwIfAborted();
      return false;
    }

    // Dry-run merge of the default branch into the task branch. A clean merge —
    // OR "Already up to date" when the branch is simply ahead — exits 0 and means
    // no conflict. A non-zero exit means a real conflict.
    let clean: boolean;
    try {
      await execManagedProcess(
        "git",
        ["merge", "--no-commit", "--no-ff", `origin/${project.defaultBranch}`],
        { cwd, signal, timeoutMs: 30_000 },
      );
      clean = true;
    } catch {
      signal?.throwIfAborted();
      clean = false;
    }

    // Roll back any merge state. When the branch was already up to date there is
    // no merge in progress, so this fails harmlessly — ignore it.
    try {
      await execManagedProcess("git", ["merge", "--abort"], { cwd, signal });
    } catch {
      signal?.throwIfAborted();
      /* no merge in progress — nothing to abort */
    }

    return clean;
  }

  private allFail(reason: string): GateResult {
    return {
      typecheck: false,
      lint: false,
      build: false,
      tests: false,
      noConflicts: false,
      inScope: false,
      details: {
        typecheck: reason,
        lint: reason,
        build: reason,
        tests: reason,
        noConflicts: reason,
        inScope: reason,
      },
    };
  }
}
