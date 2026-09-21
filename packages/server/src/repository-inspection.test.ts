import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyRepository,
  detectStack,
  isHoopedorcOwnedOrSeed,
  packageJsonHasSubstance,
  packageScripts,
  summarizeRepository,
} from "./repository-inspection.js";

const NOW = "2026-09-21T10:00:00.000Z";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const SEED_PACKAGE = { name: "seed", private: true, version: "0.0.0" };

test("VW03: Hoopedorc seeds and planning context never count as application code", () => {
  for (const path of [
    "README.md",
    "package.json",
    ".gitignore",
    "CLAUDE.md",
    "AGENTS.md",
    "docs/PRD.md",
    "context/attachments/brief.pdf",
    "context/plan-sessions/2026-09-21-1000.md",
  ]) {
    assert.equal(isHoopedorcOwnedOrSeed(path), true, path);
  }
  assert.equal(isHoopedorcOwnedOrSeed("docs/spec/PRD.md", "docs/spec/PRD.md"), true);
  for (const path of ["src/index.ts", "docs/guide.md", "README.txt", "contexts/x"]) {
    assert.equal(isHoopedorcOwnedOrSeed(path), false, path);
  }
});

test("VW03: a seed-only repository is empty; any code or a substantive package.json makes it existing", () => {
  const empty = classifyRepository(
    {
      branch: "main",
      headSha: HEAD,
      trackedFiles: ["README.md", "package.json", "docs/PRD.md", "context/plan-sessions/a.md"],
      trackedFileCount: 4,
      packageJson: SEED_PACKAGE,
      prdPath: "docs/PRD.md",
    },
    NOW,
  );
  assert.deepEqual(empty, {
    state: "empty",
    inspectedAt: NOW,
    branch: "main",
    commit: HEAD,
    trackedFileCount: 0,
    stack: [],
    packageScripts: undefined,
  });

  const withCode = classifyRepository(
    {
      branch: "main",
      headSha: HEAD,
      trackedFiles: ["README.md", "package.json", "src/index.ts", "tsconfig.json"],
      trackedFileCount: 4,
      packageJson: { ...SEED_PACKAGE, scripts: { test: "vitest", build: "tsc" } },
    },
    NOW,
  );
  assert.equal(withCode.state, "existing");
  assert.equal(withCode.trackedFileCount, 2);
  assert.deepEqual(withCode.stack, ["node", "typescript"]);
  assert.deepEqual(withCode.packageScripts, ["build", "test"]);

  const scriptsOnly = classifyRepository(
    {
      branch: "main",
      headSha: HEAD,
      trackedFiles: ["README.md", "package.json"],
      trackedFileCount: 2,
      packageJson: { ...SEED_PACKAGE, dependencies: { fastify: "^5" } },
    },
    NOW,
  );
  assert.equal(scriptsOnly.state, "existing", "dependencies alone mean the seed was grown into code");
  assert.deepEqual(scriptsOnly.stack, ["node"]);
});

test("VW03: a non-Node codebase is detected without inventing npm scripts", () => {
  const python = classifyRepository(
    {
      branch: "trunk",
      headSha: HEAD,
      trackedFiles: ["README.md", "package.json", "pyproject.toml", "src/app/__init__.py", "tests/test_app.py"],
      trackedFileCount: 5,
      packageJson: SEED_PACKAGE,
    },
    NOW,
  );
  assert.equal(python.state, "existing");
  assert.deepEqual(python.stack, ["python"]);
  assert.equal(python.packageScripts, undefined);
  assert.equal(python.branch, "trunk");

  assert.deepEqual(detectStack(["go.mod", "cmd/app/main.go", "Dockerfile"], undefined), ["docker", "go"]);
  assert.deepEqual(detectStack(["Cargo.toml", "src/main.rs"], undefined), ["rust"]);
  assert.deepEqual(detectStack(["App/App.xcodeproj/project.pbxproj", "Package.swift"], undefined), ["swift"]);
  assert.deepEqual(
    detectStack(["vendor/deep/nested/dir/go.mod", "src/x.txt"], undefined),
    [],
    "manifests deeper than two directories are vendored, not the project's stack",
  );
});

test("VW03: an unborn branch and a bounded listing classify honestly", () => {
  const unborn = classifyRepository(
    { branch: "main", headSha: null, trackedFiles: [], trackedFileCount: 0, packageJson: undefined },
    NOW,
  );
  assert.equal(unborn.state, "empty");
  assert.equal(unborn.commit, undefined);

  const bounded = classifyRepository(
    {
      branch: null,
      headSha: HEAD,
      trackedFiles: ["README.md", "package.json"],
      trackedFileCount: 9_000,
      packageJson: SEED_PACKAGE,
    },
    NOW,
  );
  assert.equal(bounded.state, "existing", "unlisted tracked files are still code");
  assert.equal(bounded.trackedFileCount, 8_998);
  assert.equal(bounded.branch, undefined);
});

test("VW03: package.json helpers and summaries are precise", () => {
  assert.equal(packageJsonHasSubstance(SEED_PACKAGE), false);
  assert.equal(packageJsonHasSubstance({ scripts: {} }), false);
  assert.equal(packageJsonHasSubstance({ scripts: { test: "node --test" } }), true);
  assert.equal(packageJsonHasSubstance({ workspaces: ["packages/*"] }), true);
  assert.equal(packageJsonHasSubstance("not an object"), false);
  assert.deepEqual(packageScripts({ scripts: { test: "x", build: "y", bad: 1 } }), ["build", "test"]);
  assert.equal(packageScripts({ scripts: {} }), undefined);

  assert.equal(
    summarizeRepository({
      state: "existing",
      inspectedAt: NOW,
      branch: "main",
      commit: HEAD,
      trackedFileCount: 12,
      stack: ["node", "typescript"],
      packageScripts: ["build", "test"],
    }),
    "main @ 0123456 · existing codebase (12 tracked files) · node, typescript · npm scripts: build, test",
  );
  assert.equal(
    summarizeRepository({ state: "empty", inspectedAt: NOW, branch: "main", commit: HEAD, trackedFileCount: 0, stack: [] }),
    "main @ 0123456 · empty repository (seed files only)",
  );
  assert.equal(
    summarizeRepository({ state: "unavailable", inspectedAt: NOW, stack: [], error: "offline" }),
    "unavailable — offline",
  );
});
