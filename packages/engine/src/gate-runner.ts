import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GateResult, Project, Task } from "@orc/types";
import type { GateRunner, WorktreeManager } from "./index.js";

// Async exec everywhere: gates run npm scripts (up to 2 min each) and git
// commands. The old execSync versions blocked Node's single event loop for the
// whole duration, so while ANY task was running its gates the server couldn't
// answer HTTP/WS — it looked frozen. promisify(execFile) keeps the loop free.
const pexecFile = promisify(execFile);

export class GateRunnerImpl implements GateRunner {
  constructor(private readonly worktrees: WorktreeManager) {}

  async run(project: Project, task: Task): Promise<GateResult> {
    const worktreePath = task.worktreePath;
    if (!worktreePath) {
      return this.allFail("no worktree path set");
    }

    const typecheck = await this.runScript(worktreePath, "typecheck");
    const lint = await this.runScript(worktreePath, "lint");
    const build = await this.runScript(worktreePath, "build");
    // Support either a "test" or "tests" npm script; both must pass if present.
    const testRun = await this.runScript(worktreePath, "test");
    const testsRun = await this.runScript(worktreePath, "tests");
    const tests = {
      passed: testRun.passed && testsRun.passed,
      ran: testRun.ran || testsRun.ran,
      output: [testRun.output, testsRun.output].filter(Boolean).join("\n"),
    };
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

  private async runScript(
    cwd: string,
    script: string,
  ): Promise<{ passed: boolean; ran: boolean; output: string }> {
    try {
      const { stdout } = await pexecFile(
        "npm",
        ["run", script, "--if-present"],
        {
          cwd,
          encoding: "utf-8",
          timeout: 120_000,
          maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env, PWD: cwd },
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
      // Non-numeric code (ENOENT etc.) means the script/tool isn't applicable
      // — `npm run --if-present` already no-ops missing scripts, so this is the
      // "nothing to run" case: pass with a note rather than fail the gate.
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
