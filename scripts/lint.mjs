import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import {
  LINT_TARGETS,
  compareBaselineToPrevious,
  compareCurrentToBaseline,
  countWarningsByWorkspaceAndRule,
  totalFindings,
  validateBaseline,
} from "./lint-policy.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = resolve(rootDir, "eslint-baseline.json");

function readBaselineText(text, source) {
  let baseline;
  try {
    baseline = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in ${source}: ${String(error)}`);
  }

  const errors = validateBaseline(baseline);
  if (errors.length > 0) {
    throw new Error(`Invalid ${source}:\n- ${errors.join("\n- ")}`);
  }
  return baseline;
}

function previousBaseline() {
  const ref = process.env.GITHUB_BASE_REF ? "HEAD^1" : "HEAD";
  const object = `${ref}:eslint-baseline.json`;

  try {
    return readBaselineText(
      execFileSync("git", ["show", object], {
        cwd: rootDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
      object,
    );
  } catch (error) {
    try {
      execFileSync("git", ["cat-file", "-e", `${ref}^{commit}`], {
        cwd: rootDir,
        stdio: "ignore",
      });
    } catch {
      if (process.env.GITHUB_BASE_REF) {
        throw new Error(
          `Cannot inspect ${ref}; pull-request checkout must retain both parents`,
        );
      }
      return undefined;
    }

    const message =
      error instanceof Error && "stderr" in error
        ? String(error.stderr)
        : String(error);
    if (message.includes("does not exist") || message.includes("exists on disk")) {
      return undefined;
    }
    throw error;
  }
}

function formatBaselineMismatch(mismatch) {
  const summary = `${mismatch.workspace} ${mismatch.ruleId}: expected ${mismatch.expected}, found ${mismatch.actual}`;
  return mismatch.direction === "decreased"
    ? `${summary}; lower eslint-baseline.json in the same change`
    : `${summary}; fix the new finding instead of raising the baseline`;
}

async function main() {
  const baseline = readBaselineText(
    readFileSync(baselinePath, "utf8"),
    "eslint-baseline.json",
  );
  const prior = previousBaseline();
  const baselineIncreases =
    prior == null ? [] : compareBaselineToPrevious(baseline, prior);

  const eslint = new ESLint({ cwd: rootDir });
  const results = await eslint.lintFiles(LINT_TARGETS);
  const current = countWarningsByWorkspaceAndRule(results, rootDir);
  const mismatches = compareCurrentToBaseline(current, baseline);
  const errorCount = results.reduce(
    (total, result) => total + result.errorCount,
    0,
  );

  if (errorCount > 0) {
    const formatter = await eslint.loadFormatter("stylish");
    const errorsOnly = results
      .map((result) => {
        const messages = result.messages.filter(
          (message) => message.severity === 2,
        );
        return {
          ...result,
          messages,
          errorCount: messages.length,
          warningCount: 0,
          fixableErrorCount: messages.filter((message) => message.fix != null)
            .length,
          fixableWarningCount: 0,
        };
      })
      .filter((result) => result.messages.length > 0);
    process.stderr.write(`${formatter.format(errorsOnly)}\n`);
  }

  for (const mismatch of mismatches) {
    process.stderr.write(`Lint baseline mismatch: ${formatBaselineMismatch(mismatch)}\n`);
  }
  for (const increase of baselineIncreases) {
    process.stderr.write(
      `Lint baseline increase refused: ${increase.workspace} ${increase.ruleId}: base maximum ${increase.expectedMaximum}, proposed ${increase.actual}\n`,
    );
  }

  if (errorCount > 0 || mismatches.length > 0 || baselineIncreases.length > 0) {
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `Linted ${results.length} files across all five workspaces; ${totalFindings(current)} legacy findings exactly match the non-increasing baseline.\n`,
  );
}

await main();
