import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import {
  LINT_TARGETS,
  WORKSPACE_ROOTS,
  compareBaselineToPrevious,
  compareCurrentToBaseline,
  countWarningsByWorkspaceAndRule,
  validateBaseline,
} from "./lint-policy.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("O31: lint targets cover every workspace", () => {
  for (const workspace of WORKSPACE_ROOTS) {
    assert.ok(
      LINT_TARGETS.some(
        (target) => target === workspace || target.startsWith(`${workspace}/`),
      ),
      `missing lint target for ${workspace}`,
    );
  }
});

test("O31: warning counts are grouped by exact workspace and rule", () => {
  const results = [
    {
      filePath: resolve(rootDir, "packages/server/src/index.ts"),
      messages: [
        { severity: 1, ruleId: "@typescript-eslint/require-await" },
        { severity: 1, ruleId: "@typescript-eslint/require-await" },
        { severity: 2, ruleId: "@typescript-eslint/no-floating-promises" },
      ],
    },
    {
      filePath: resolve(rootDir, "apps/web/src/App.tsx"),
      messages: [{ severity: 1, ruleId: "react-hooks/exhaustive-deps" }],
    },
  ];

  assert.deepEqual(countWarningsByWorkspaceAndRule(results, rootDir), {
    "apps/web": { "react-hooks/exhaustive-deps": 1 },
    "packages/server": { "@typescript-eslint/require-await": 2 },
  });
});

test("O31: current findings must exactly match the checked baseline", () => {
  const baseline = {
    "packages/server": { "@typescript-eslint/require-await": 2 },
  };

  assert.deepEqual(compareCurrentToBaseline(baseline, baseline), []);
  assert.deepEqual(
    compareCurrentToBaseline(
      { "packages/server": { "@typescript-eslint/require-await": 3 } },
      baseline,
    ),
    [
      {
        workspace: "packages/server",
        ruleId: "@typescript-eslint/require-await",
        actual: 3,
        expected: 2,
        direction: "increased",
      },
    ],
  );
  assert.deepEqual(
    compareCurrentToBaseline(
      { "packages/server": { "@typescript-eslint/require-await": 1 } },
      baseline,
    ),
    [
      {
        workspace: "packages/server",
        ruleId: "@typescript-eslint/require-await",
        actual: 1,
        expected: 2,
        direction: "decreased",
      },
    ],
  );
});

test("O31: a pull request cannot raise or add a baseline count", () => {
  const previous = {
    "packages/server": { "@typescript-eslint/require-await": 2 },
  };

  assert.deepEqual(
    compareBaselineToPrevious(
      { "packages/server": { "@typescript-eslint/require-await": 1 } },
      previous,
    ),
    [],
  );
  assert.deepEqual(
    compareBaselineToPrevious(
      {
        "packages/server": {
          "@typescript-eslint/require-await": 3,
          "@typescript-eslint/no-base-to-string": 1,
        },
      },
      previous,
    ),
    [
      {
        workspace: "packages/server",
        ruleId: "@typescript-eslint/no-base-to-string",
        actual: 1,
        expectedMaximum: 0,
      },
      {
        workspace: "packages/server",
        ruleId: "@typescript-eslint/require-await",
        actual: 3,
        expectedMaximum: 2,
      },
    ],
  );
});

test("O31: baseline schema is positive, complete, and workspace-scoped", () => {
  const valid = Object.fromEntries(
    WORKSPACE_ROOTS.map((workspace) => [workspace, {}]),
  );
  assert.deepEqual(validateBaseline(valid), []);

  assert.deepEqual(validateBaseline({ ...valid, "packages/unknown": {} }), [
    "unknown workspace packages/unknown",
  ]);
  assert.deepEqual(
    validateBaseline({
      ...valid,
      "packages/server": { "@typescript-eslint/require-await": 0 },
    }),
    ["packages/server/@typescript-eslint/require-await must be a positive integer"],
  );
});

test("O31: browser, tooling, backend, and type-only files get scoped globals", async () => {
  const eslint = new ESLint({ cwd: rootDir });
  const [browser, webTool, backend, types] = await Promise.all([
    eslint.calculateConfigForFile(resolve(rootDir, "apps/web/src/App.tsx")),
    eslint.calculateConfigForFile(resolve(rootDir, "apps/web/e2e/app.spec.ts")),
    eslint.calculateConfigForFile(
      resolve(rootDir, "packages/server/src/index.test.ts"),
    ),
    eslint.calculateConfigForFile(resolve(rootDir, "packages/types/src/domain.ts")),
  ]);

  assert.equal(browser.languageOptions.globals.window, false);
  assert.equal(browser.languageOptions.globals.process, undefined);
  assert.equal(webTool.languageOptions.globals.window, false);
  assert.equal(webTool.languageOptions.globals.process, false);
  assert.equal(backend.languageOptions.globals.process, false);
  assert.equal(backend.languageOptions.globals.window, undefined);
  assert.equal(types.languageOptions.globals?.process, undefined);
  assert.equal(types.languageOptions.globals?.window, undefined);
});

test("O31: real floating promises are errors while node:test registration is safe", async () => {
  const eslint = new ESLint({ cwd: rootDir });
  const config = await eslint.calculateConfigForFile(
    resolve(rootDir, "packages/server/src/index.ts"),
  );
  assert.equal(
    config.rules["@typescript-eslint/no-floating-promises"][0],
    2,
  );
  assert.equal(
    config.rules["@typescript-eslint/no-misused-promises"][0],
    2,
  );

  const [floating] = await eslint.lintText(
    'export function leak(): void { Promise.resolve("lost"); }\n',
    { filePath: resolve(rootDir, "packages/server/src/index.ts") },
  );
  assert.ok(
    floating.messages.some(
      (message) =>
        message.ruleId === "@typescript-eslint/no-floating-promises" &&
        message.severity === 2,
    ),
  );

  const [registeredTest] = await eslint.lintText(
    'import { test } from "node:test";\ntest("registered", () => {});\n',
    { filePath: resolve(rootDir, "packages/server/src/pricing.test.ts") },
  );
  assert.equal(
    registeredTest.messages.some(
      (message) =>
        message.ruleId === "@typescript-eslint/no-floating-promises",
    ),
    false,
  );
});
