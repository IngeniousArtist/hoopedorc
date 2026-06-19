import { execSync } from "node:child_process";
import type { GateResult, Project, Task } from "@orc/types";
import type { GateRunner, WorktreeManager } from "./index.js";

export class GateRunnerImpl implements GateRunner {
  constructor(private readonly worktrees: WorktreeManager) {}

  async run(project: Project, task: Task): Promise<GateResult> {
    const worktreePath = task.worktreePath;
    if (!worktreePath) {
      return this.allFail("no worktree path set");
    }

    const typecheck = this.runScript(worktreePath, "typecheck");
    const lint = this.runScript(worktreePath, "lint");
    const build = this.runScript(worktreePath, "build");
    const tests = this.runScript(worktreePath, "test") &&
      this.runScript(worktreePath, "tests");
    const noConflicts = this.checkNoConflicts(project, worktreePath);
    const inScope = await this.worktrees.changedFilesInScope(project, task);

    return {
      typecheck: typecheck.passed,
      lint: lint.passed,
      build: build.passed,
      tests: tests.passed,
      noConflicts,
      inScope,
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

  private runScript(
    cwd: string,
    script: string,
  ): { passed: boolean; output: string } {
    try {
      const stdout = execSync(`npm run ${script} --if-present`, {
        cwd,
        stdio: "pipe",
        encoding: "utf-8",
        timeout: 120_000,
      });
      return { passed: true, output: stdout };
    } catch (err: unknown) {
      const stderr =
        (err as { stderr?: string }).stderr ??
        (err as { stdout?: string }).stdout ??
        (err as { message?: string }).message ??
        "";
      const status = (err as { status?: number }).status;

      if (status === null || status === undefined) {
        return { passed: true, output: `script "${script}" not found — pass with note` };
      }

      return { passed: false, output: String(stderr) };
    }
  }

  private checkNoConflicts(project: Project, cwd: string): boolean {
    try {
      execSync(`git fetch origin "${project.defaultBranch}"`, {
        cwd,
        stdio: "pipe",
        timeout: 30_000,
      });
    } catch {
      return false;
    }

    try {
      execSync(
        `git merge --no-commit --no-ff "origin/${project.defaultBranch}"`,
        { cwd, stdio: "pipe", timeout: 30_000 },
      );
      execSync("git merge --abort", { cwd, stdio: "pipe" });
      return true;
    } catch {
      try {
        execSync("git merge --abort", { cwd, stdio: "pipe" });
      } catch {
        /* ignore */
      }
      return false;
    }
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
