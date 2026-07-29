import eslint from "@eslint/js";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

const backendFiles = [
  "packages/types/src/**/*.ts",
  "packages/adapters/src/**/*.ts",
  "packages/engine/src/**/*.ts",
  "packages/server/src/**/*.ts",
];
const nodeBackendFiles = [
  "packages/adapters/src/**/*.ts",
  "packages/engine/src/**/*.ts",
  "packages/server/src/**/*.ts",
];
const webFiles = ["apps/web/**/*.{ts,tsx}"];
const webSourceFiles = ["apps/web/src/**/*.{ts,tsx}"];
const webToolFiles = ["apps/web/e2e/**/*.{ts,tsx}", "apps/web/*.config.ts"];
const allFiles = [...backendFiles, ...webFiles];
const rootDir = dirname(fileURLToPath(import.meta.url));

const baseline = JSON.parse(
  readFileSync(new URL("./eslint-baseline.json", import.meta.url), "utf8"),
);
const legacyRuleIds = [
  ...new Set(
    Object.values(baseline).flatMap((workspace) => Object.keys(workspace)),
  ),
];
const legacyRuleSeverities = Object.fromEntries(
  legacyRuleIds.map((ruleId) => [ruleId, "warn"]),
);

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "playwright-report/**",
      "test-results/**",
    ],
  },
  { ...eslint.configs.recommended, files: allFiles },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: webFiles,
  })),
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: backendFiles,
  })),
  {
    files: backendFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: rootDir,
      },
    },
    rules: {
      ...legacyRuleSeverities,
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [
            {
              from: "package",
              name: "test",
              package: "node:test",
            },
          ],
        },
      ],
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  {
    files: nodeBackendFiles,
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: webSourceFiles,
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: webToolFiles,
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    files: webFiles,
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
);
