import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(
  resolve(rootDir, ".github/workflows/ci.yml"),
  "utf8",
);

test("O32: PR concurrency cancels by head while every non-PR run is isolated", () => {
  assert.match(
    workflow,
    /group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.head_ref \|\| github\.run_id \}\}/,
  );
  assert.match(
    workflow,
    /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/,
  );
  assert.doesNotMatch(workflow, /group: .*github\.ref/);
});

test("O32: deterministic CI uses non-vacuous diff ranges and one build", () => {
  assert.match(workflow, /fetch-depth: 2/);
  assert.match(
    workflow,
    /DIFF_RANGE: \$\{\{ github\.event_name == 'pull_request' && 'HEAD\^1\.\.\.HEAD' \|\| 'HEAD\^\.\.\.HEAD' \}\}/,
  );
  assert.match(workflow, /run: git diff --check "\$DIFF_RANGE"/);

  const buildIndex = workflow.indexOf("- run: npm run build");
  const typecheckIndex = workflow.indexOf("- run: npm run typecheck:prebuilt");
  assert.ok(buildIndex > 0);
  assert.ok(typecheckIndex > buildIndex);
  assert.equal(workflow.includes("- run: npm run typecheck\n"), false);
});

test("O32: Playwright cache keys exact binaries and preserves both install paths", () => {
  assert.match(workflow, /id: playwright-version/);
  assert.match(
    workflow,
    /key: \$\{\{ runner\.os \}\}-playwright-\$\{\{ steps\.playwright-version\.outputs\.version \}\}-\$\{\{ hashFiles\('package-lock\.json'\) \}\}/,
  );
  assert.match(workflow, /path: ~\/\.cache\/ms-playwright/);
  assert.doesNotMatch(workflow, /restore-keys:/);
  assert.match(
    workflow,
    /if: steps\.playwright-cache\.outputs\.cache-hit != 'true'\n\s+run: npx playwright install --with-deps chromium/,
  );
  assert.match(
    workflow,
    /if: steps\.playwright-cache\.outputs\.cache-hit == 'true'\n\s+run: npx playwright install-deps chromium/,
  );
});

test("O32: audit is scheduled/manual, owned, classified, and always archived", () => {
  assert.match(workflow, /cron: "17 8 \* \* 1"/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(
    workflow,
    /if: github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'/,
  );
  assert.match(workflow, /AUDIT_OWNER: IngeniousArtist/);
  assert.match(workflow, /run: node scripts\/audit-advisory\.mjs/);
  assert.match(
    workflow,
    /if: \$\{\{ always\(\) \}\}\n\s+uses: actions\/upload-artifact@v4/,
  );
  assert.match(workflow, /path: audit-results\//);
});

test("O32: the committed CI diff range rejects trailing whitespace", () => {
  const repoDir = mkdtempSync(join(tmpdir(), "hoopedorc-o32-diff-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "o32@example.invalid"], {
      cwd: repoDir,
    });
    execFileSync("git", ["config", "user.name", "O32 Test"], {
      cwd: repoDir,
    });
    writeFileSync(join(repoDir, "fixture.txt"), "clean\n", "utf8");
    execFileSync("git", ["add", "fixture.txt"], { cwd: repoDir });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: repoDir });

    writeFileSync(join(repoDir, "fixture.txt"), "trailing whitespace  \n", "utf8");
    execFileSync("git", ["add", "fixture.txt"], { cwd: repoDir });
    execFileSync("git", ["commit", "-qm", "mutation"], { cwd: repoDir });

    const result = spawnSync(
      "git",
      ["diff", "--check", "HEAD^...HEAD"],
      {
        cwd: repoDir,
        encoding: "utf8",
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /trailing whitespace/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});
