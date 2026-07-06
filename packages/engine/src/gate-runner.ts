import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { sanitizedEnv } from "@orc/adapters";
import type { GateResult, Project, ProjectConfig, Task } from "@orc/types";
import type { GateRunner, WorktreeManager } from "./index.js";

// Async exec everywhere: gates run npm scripts (up to 2 min each) and git
// commands. The old execSync versions blocked Node's single event loop for the
// whole duration, so while ANY task was running its gates the server couldn't
// answer HTTP/WS — it looked frozen. promisify(execFile) keeps the loop free.
const pexecFile = promisify(execFile);

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
  constructor(private readonly worktrees: WorktreeManager) {}

  async run(project: Project, task: Task): Promise<GateResult> {
    const worktreePath = task.worktreePath;
    if (!worktreePath) {
      return this.allFail("no worktree path set");
    }

    const gates = project.config?.gates;
    const typecheck = await this.runGate(worktreePath, "typecheck", gates?.typecheckScript);
    const lint = await this.runGate(worktreePath, "lint", gates?.lintScript);
    const build = await this.runGate(worktreePath, "build", gates?.buildScript);
    const tests = await this.runTestsGate(worktreePath, gates);
    const noConflicts = await this.checkNoConflicts(project, worktreePath);
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
        noConflicts: noConflicts ? "" : "conflicts with default branch detected",
        inScope: inScope ? "" : "files modified outside task.scopePaths",
      },
    };
  }

  /** typecheck/lint/build: run the configured script name (or the slot's
   *  default), or skip entirely when the override is `false`. */
  private async runGate(
    cwd: string,
    slot: string,
    scriptOverride: string | false | undefined,
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
    return this.runScript(cwd, scriptOverride || slot);
  }

  private async runTestsGate(
    cwd: string,
    gates: ProjectConfig["gates"] | undefined,
  ): Promise<{ passed: boolean; ran: boolean; output: string }> {
    if (gates?.testScript === false) {
      return { passed: true, ran: false, output: 'gate "test" disabled by project config' };
    }
    if (gates?.testCommand) {
      return this.runCommand(cwd, gates.testCommand);
    }
    if (gates?.testScript) {
      if (!hasNpmScript(cwd, gates.testScript)) {
        return {
          passed: false,
          ran: true,
          output: `configured gate script "${gates.testScript}" not found in package.json`,
        };
      }
      return this.runScript(cwd, gates.testScript);
    }
    // Default: support either a "test" or "tests" npm script; both must pass if present.
    const testRun = await this.runScript(cwd, "test");
    const testsRun = await this.runScript(cwd, "tests");
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
    cwd: string,
    command: string,
  ): Promise<{ passed: boolean; ran: boolean; output: string }> {
    const [cmd, ...args] = command.trim().split(/\s+/).filter(Boolean);
    if (!cmd) return { passed: true, ran: false, output: "empty testCommand" };
    try {
      const { stdout } = await pexecFile(cmd, args, {
        cwd,
        encoding: "utf-8",
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
        env: sanitizedEnv({ PWD: cwd }),
      });
      return { passed: true, ran: true, output: stdout };
    } catch (err: unknown) {
      const e = err as { stderr?: string; stdout?: string; message?: string; killed?: boolean };
      const out = e.stderr || e.stdout || e.message || "";
      if (e.killed) {
        return { passed: false, ran: true, output: `command "${command}" timed out` };
      }
      return { passed: false, ran: true, output: String(out) };
    }
  }

  private async runScript(
    cwd: string,
    script: string,
  ): Promise<{ passed: boolean; ran: boolean; output: string }> {
    if (!hasNpmScript(cwd, script)) {
      return { passed: true, ran: false, output: `script "${script}" not defined in package.json` };
    }
    try {
      const { stdout } = await pexecFile(
        "npm",
        ["run", script, "--if-present"],
        {
          cwd,
          encoding: "utf-8",
          timeout: 120_000,
          maxBuffer: 16 * 1024 * 1024,
          env: sanitizedEnv({ PWD: cwd }),
        },
      );
      return { passed: true, ran: true, output: stdout };
    } catch (err: unknown) {
      const e = err as {
        stderr?: string;
        stdout?: string;
        message?: string;
        code?: number | string;
        killed?: boolean;
      };
      const out = e.stderr || e.stdout || e.message || "";
      // Timed out / hung → a real failure, don't let it pass.
      if (e.killed) {
        return { passed: false, ran: true, output: `script "${script}" timed out` };
      }
      // Non-numeric code (ENOENT etc.) at this point means npm itself (or the
      // script's own tool) couldn't be spawned, not that the script is
      // missing (hasNpmScript already confirmed it's declared) — treat it as
      // "nothing to run" rather than failing the gate outright.
      if (typeof e.code !== "number") {
        return {
          passed: true,
          ran: false,
          output: `script "${script}" unavailable — ${String(out).slice(0, 200)}`,
        };
      }
      return { passed: false, ran: true, output: String(out) };
    }
  }

  private async checkNoConflicts(
    project: Project,
    cwd: string,
  ): Promise<boolean> {
    try {
      await pexecFile("git", ["fetch", "origin", project.defaultBranch], {
        cwd,
        timeout: 30_000,
      });
    } catch {
      return false;
    }

    // Dry-run merge of the default branch into the task branch. A clean merge —
    // OR "Already up to date" when the branch is simply ahead — exits 0 and means
    // no conflict. A non-zero exit means a real conflict.
    let clean: boolean;
    try {
      await pexecFile(
        "git",
        ["merge", "--no-commit", "--no-ff", `origin/${project.defaultBranch}`],
        { cwd, timeout: 30_000 },
      );
      clean = true;
    } catch {
      clean = false;
    }

    // Roll back any merge state. When the branch was already up to date there is
    // no merge in progress, so this fails harmlessly — ignore it.
    try {
      await pexecFile("git", ["merge", "--abort"], { cwd });
    } catch {
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
