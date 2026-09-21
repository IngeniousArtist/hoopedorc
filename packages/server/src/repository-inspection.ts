import type { RepositoryInspection } from "@orc/types";

/**
 * VW03: turn read-only facts about the primary clone into the shared
 * `RepositoryInspection`. Pure and I/O-free so the empty/existing decision,
 * stack detection, and summaries are unit-testable against fixtures; the
 * planning service supplies the facts (Git description + parsed package.json).
 *
 * "Empty" means no application code: Hoopedorc itself seeds a README and a
 * minimal `package.json` at project creation and owns the planning context
 * files, so those never count as a codebase. A `package.json` with real
 * scripts or dependencies does.
 */
export interface RepositoryFacts {
  branch: string | null;
  headSha: string | null;
  /** Tracked repository-relative paths (possibly bounded). */
  trackedFiles: string[];
  /** Total tracked paths before bounding. */
  trackedFileCount: number;
  /** Parsed root `package.json`, when present and parseable. */
  packageJson?: unknown;
  /** `Project.prdPath`, so a committed PRD is not mistaken for code. */
  prdPath?: string;
}

const SEED_FILES: ReadonlySet<string> = new Set([
  "README.md",
  "README",
  "readme.md",
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
  "package.json",
  "CLAUDE.md",
  "AGENTS.md",
  "CHANGELOG.md",
  "docs/PRD.md",
]);

const OWNED_PREFIXES = ["context/attachments/", "context/plan-sessions/"] as const;

/** Manifests are only meaningful near the root; deeper matches are vendored or fixtures. */
const MAX_MANIFEST_DEPTH = 2;

const STACK_MANIFESTS: ReadonlyArray<{ pattern: RegExp; stack: string }> = [
  { pattern: /(^|\/)tsconfig(\.[\w.-]+)?\.json$/u, stack: "typescript" },
  {
    pattern: /(^|\/)(pyproject\.toml|requirements(-[\w.]+)?\.txt|setup\.py|setup\.cfg|Pipfile|poetry\.lock)$/u,
    stack: "python",
  },
  { pattern: /(^|\/)go\.mod$/u, stack: "go" },
  { pattern: /(^|\/)Cargo\.toml$/u, stack: "rust" },
  { pattern: /(^|\/)Gemfile$/u, stack: "ruby" },
  { pattern: /(^|\/)(pom\.xml|build\.gradle(\.kts)?)$/u, stack: "java" },
  { pattern: /\.(csproj|fsproj|sln)$/u, stack: "dotnet" },
  { pattern: /(^|\/)Package\.swift$|\.xcodeproj\/project\.pbxproj$/u, stack: "swift" },
  { pattern: /(^|\/)composer\.json$/u, stack: "php" },
  { pattern: /(^|\/)(Dockerfile|docker-compose\.ya?ml|compose\.ya?ml)$/u, stack: "docker" },
];

function depth(path: string): number {
  return path.split("/").length - 1;
}

export function isHoopedorcOwnedOrSeed(path: string, prdPath?: string): boolean {
  if (SEED_FILES.has(path)) return true;
  if (prdPath && path === prdPath.replace(/^\.?\//u, "")) return true;
  return OWNED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Script names from a parsed package.json, or undefined when there are none. */
export function packageScripts(packageJson: unknown): string[] | undefined {
  const scripts = asRecord(asRecord(packageJson)?.scripts);
  if (!scripts) return undefined;
  const names = Object.keys(scripts).filter((name) => typeof scripts[name] === "string");
  return names.length > 0 ? names.sort() : undefined;
}

/** A seed package.json has no scripts and no dependencies; anything more is code. */
export function packageJsonHasSubstance(packageJson: unknown): boolean {
  const pkg = asRecord(packageJson);
  if (!pkg) return false;
  if (packageScripts(pkg)) return true;
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "workspaces"]) {
    const value = pkg[field];
    if (Array.isArray(value) ? value.length > 0 : Object.keys(asRecord(value) ?? {}).length > 0) {
      return true;
    }
  }
  return false;
}

export function detectStack(trackedFiles: string[], packageJson: unknown): string[] {
  const stacks = new Set<string>();
  if (packageJsonHasSubstance(packageJson)) stacks.add("node");
  for (const path of trackedFiles) {
    if (depth(path) > MAX_MANIFEST_DEPTH) continue;
    for (const { pattern, stack } of STACK_MANIFESTS) {
      if (pattern.test(path)) stacks.add(stack);
    }
  }
  // TypeScript without a substantive package.json is still a Node-family
  // project (the seed package.json is being grown into it).
  if (stacks.has("typescript")) stacks.add("node");
  return [...stacks].sort();
}

export function classifyRepository(
  facts: RepositoryFacts,
  inspectedAt: string,
): RepositoryInspection {
  const codeFiles = facts.trackedFiles.filter(
    (path) => !isHoopedorcOwnedOrSeed(path, facts.prdPath),
  );
  const unboundedRemainder = Math.max(0, facts.trackedFileCount - facts.trackedFiles.length);
  const codeFileCount = codeFiles.length + unboundedRemainder;
  const existing = codeFileCount > 0 || packageJsonHasSubstance(facts.packageJson);
  const stack = existing ? detectStack(facts.trackedFiles, facts.packageJson) : [];
  const scripts = stack.includes("node") ? packageScripts(facts.packageJson) : undefined;
  return {
    state: existing ? "existing" : "empty",
    inspectedAt,
    branch: facts.branch ?? undefined,
    commit: facts.headSha ?? undefined,
    trackedFileCount: codeFileCount,
    stack,
    packageScripts: scripts,
  };
}

export function shortCommit(commit: string | undefined): string {
  return commit ? commit.slice(0, 7) : "unknown";
}

/** One-line, secret-free summary for prompts, archives, and logs. */
export function summarizeRepository(repository: RepositoryInspection): string {
  const where = `${repository.branch ?? "unknown branch"} @ ${shortCommit(repository.commit)}`;
  if (repository.state === "unavailable") {
    return `unavailable — ${repository.error ?? "the clone could not be reached or read"}`;
  }
  const parts = [
    where,
    repository.state === "empty"
      ? "empty repository (seed files only)"
      : `existing codebase (${repository.trackedFileCount ?? 0} tracked files)`,
  ];
  if (repository.stack.length > 0) parts.push(repository.stack.join(", "));
  if (repository.packageScripts && repository.packageScripts.length > 0) {
    parts.push(`npm scripts: ${repository.packageScripts.join(", ")}`);
  }
  return parts.join(" · ");
}
