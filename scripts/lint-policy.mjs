import { relative, sep } from "node:path";

export const WORKSPACE_ROOTS = [
  "apps/web",
  "packages/adapters",
  "packages/engine",
  "packages/server",
  "packages/types",
];

export const LINT_TARGETS = [
  "apps/web/src",
  "apps/web/e2e",
  "apps/web/*.config.ts",
  "packages/adapters/src",
  "packages/engine/src",
  "packages/server/src",
  "packages/types/src",
];

function normalizePath(value) {
  return value.split(sep).join("/");
}

export function workspaceForFile(filePath, rootDir) {
  const repoPath = normalizePath(relative(rootDir, filePath));
  return (
    WORKSPACE_ROOTS.find(
      (workspace) =>
        repoPath === workspace || repoPath.startsWith(`${workspace}/`),
    ) ?? "<root>"
  );
}

export function countWarningsByWorkspaceAndRule(results, rootDir) {
  const counts = {};

  for (const result of results) {
    const workspace = workspaceForFile(result.filePath, rootDir);
    for (const message of result.messages) {
      if (message.severity !== 1) continue;
      const ruleId = message.ruleId ?? "<unknown>";
      counts[workspace] ??= {};
      counts[workspace][ruleId] = (counts[workspace][ruleId] ?? 0) + 1;
    }
  }

  return sortCounts(counts);
}

export function sortCounts(counts) {
  return Object.fromEntries(
    Object.entries(counts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([workspace, rules]) => [
        workspace,
        Object.fromEntries(
          Object.entries(rules).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        ),
      ]),
  );
}

export function validateBaseline(baseline) {
  const errors = [];

  for (const [workspace, rules] of Object.entries(baseline)) {
    if (!WORKSPACE_ROOTS.includes(workspace)) {
      errors.push(`unknown workspace ${workspace}`);
    }
    if (rules == null || Array.isArray(rules) || typeof rules !== "object") {
      errors.push(`${workspace} must map rule IDs to counts`);
      continue;
    }
    for (const [ruleId, count] of Object.entries(rules)) {
      if (!ruleId || !Number.isInteger(count) || count <= 0) {
        errors.push(`${workspace}/${ruleId} must be a positive integer`);
      }
    }
  }

  for (const workspace of WORKSPACE_ROOTS) {
    if (!(workspace in baseline)) {
      errors.push(`missing workspace ${workspace}`);
    }
  }

  return errors;
}

function countAt(counts, workspace, ruleId) {
  return counts[workspace]?.[ruleId] ?? 0;
}

function allKeys(left, right) {
  const keys = new Set();
  for (const counts of [left, right]) {
    for (const [workspace, rules] of Object.entries(counts)) {
      for (const ruleId of Object.keys(rules)) {
        keys.add(`${workspace}\0${ruleId}`);
      }
    }
  }
  return [...keys]
    .map((key) => key.split("\0"))
    .sort(([leftWorkspace, leftRule], [rightWorkspace, rightRule]) =>
      leftWorkspace === rightWorkspace
        ? leftRule.localeCompare(rightRule)
        : leftWorkspace.localeCompare(rightWorkspace),
    );
}

export function compareCurrentToBaseline(current, baseline) {
  return allKeys(current, baseline)
    .map(([workspace, ruleId]) => {
      const actual = countAt(current, workspace, ruleId);
      const expected = countAt(baseline, workspace, ruleId);
      if (actual === expected) return undefined;
      return {
        workspace,
        ruleId,
        actual,
        expected,
        direction: actual > expected ? "increased" : "decreased",
      };
    })
    .filter(Boolean);
}

export function compareBaselineToPrevious(current, previous) {
  return allKeys(current, previous)
    .map(([workspace, ruleId]) => {
      const actual = countAt(current, workspace, ruleId);
      const expectedMaximum = countAt(previous, workspace, ruleId);
      if (actual <= expectedMaximum) return undefined;
      return {
        workspace,
        ruleId,
        actual,
        expectedMaximum,
      };
    })
    .filter(Boolean);
}

export function totalFindings(counts) {
  return Object.values(counts)
    .flatMap((rules) => Object.values(rules))
    .reduce((total, count) => total + count, 0);
}
