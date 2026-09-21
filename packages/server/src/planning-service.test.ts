import assert from "node:assert/strict";
import { test } from "node:test";
import type { Project, RepositoryInspection, VerifiedFigmaReference } from "@orc/types";
import type { PlannerModel, PlanOutput } from "./planner.js";
import {
  describeRepositoryFailure,
  productionPlanningService,
  RepositoryUnavailableError,
  selectPlanningService,
  type PlanningRepositoryAccess,
  type PlanningService,
  type ProductionPlannerRunners,
} from "./planning-service.js";

const PLANNER: PlannerModel = { id: "claude", runner: "claude-code", model: "sonnet" };
const OUTPUT: PlanOutput = { prdMarkdown: "# PRD", agentsMd: "# AGENTS", tasks: [] };
const NOW = new Date("2026-09-21T10:00:00.000Z");
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const REPOSITORY: RepositoryInspection = {
  state: "existing",
  inspectedAt: NOW.toISOString(),
  branch: "main",
  commit: HEAD,
  trackedFileCount: 2,
  stack: ["node"],
  packageScripts: ["test"],
};

function project(): Project {
  return {
    id: "proj-1",
    name: "Wired project",
    repoUrl: "https://github.com/example/wired",
    defaultBranch: "main",
    localPath: "/clones/wired",
    status: "paused",
    prdPath: "docs/PRD.md",
    createdAt: "2026-09-21T00:00:00.000Z",
    updatedAt: "2026-09-21T00:00:00.000Z",
  };
}

function fakeService(kind: PlanningService["kind"]): PlanningService {
  return {
    kind,
    inspect: () => Promise.reject(new Error("unused")),
    chat: () => Promise.reject(new Error("unused")),
    deconstruct: () => Promise.reject(new Error("unused")),
    planGoal: () => Promise.reject(new Error("unused")),
  };
}

function recordingRunners(calls: unknown[][]): ProductionPlannerRunners {
  return {
    chat: (...args) => {
      calls.push(["chat", ...args]);
      return Promise.resolve({ reply: "real reply", costUsd: 0.25 });
    },
    deconstruct: (...args) => {
      calls.push(["deconstruct", ...args]);
      return Promise.resolve({ output: OUTPUT, costUsd: 0.5 });
    },
    plan: (...args) => {
      calls.push(["plan", ...args]);
      return Promise.resolve(OUTPUT);
    },
  };
}

function gitWith(
  description: { branch: string | null; headSha: string | null; trackedFiles: string[] },
  log: string[] = [],
): PlanningRepositoryAccess {
  return {
    ensureClone(target) {
      log.push(`ensureClone:${target.localPath}`);
      return Promise.resolve();
    },
    describeRepository(target) {
      log.push(`describe:${target.localPath}`);
      return Promise.resolve({
        ...description,
        trackedFileCount: description.trackedFiles.length,
      });
    },
  };
}

test("VW01: env.mock selects the mock planner and real mode selects production, each built once", () => {
  const built: string[] = [];
  const factories = {
    production: () => {
      built.push("production");
      return fakeService("production");
    },
    mock: () => {
      built.push("mock");
      return fakeService("mock");
    },
  };
  assert.equal(selectPlanningService(true, factories).kind, "mock");
  assert.deepEqual(built, ["mock"]);
  assert.equal(selectPlanningService(false, factories).kind, "production");
  assert.deepEqual(built, ["mock", "production"]);
});

test("VW03: production inspection classifies an existing codebase from the real clone description", async () => {
  const log: string[] = [];
  const service = productionPlanningService({
    git: gitWith(
      {
        branch: "main",
        headSha: HEAD,
        trackedFiles: ["README.md", "package.json", "src/index.ts", "tsconfig.json"],
      },
      log,
    ),
    runners: recordingRunners([]),
    readPackageJson: () => Promise.resolve({ scripts: { test: "vitest", build: "tsc" } }),
    now: () => NOW,
  });
  const inspection = await service.inspect(project());
  assert.deepEqual(inspection, {
    state: "existing",
    inspectedAt: NOW.toISOString(),
    branch: "main",
    commit: HEAD,
    trackedFileCount: 2,
    stack: ["node", "typescript"],
    packageScripts: ["build", "test"],
  });
  assert.deepEqual(log, ["ensureClone:/clones/wired", "describe:/clones/wired"]);
});

test("VW03: a seed-only clone is an empty repository, not an existing project", async () => {
  const service = productionPlanningService({
    git: gitWith({
      branch: "main",
      headSha: HEAD,
      trackedFiles: ["README.md", "package.json", "docs/PRD.md", "context/plan-sessions/a.md"],
    }),
    runners: recordingRunners([]),
    readPackageJson: () => Promise.resolve({ name: "seed", private: true, version: "0.0.0" }),
    now: () => NOW,
  });
  const inspection = await service.inspect(project());
  assert.equal(inspection.state, "empty");
  assert.equal(inspection.trackedFileCount, 0);
  assert.deepEqual(inspection.stack, []);
  assert.equal(inspection.packageScripts, undefined);
  assert.equal(inspection.commit, HEAD);
});

test("VW03: an unreachable clone is a typed, secret-free failure instead of a temporary directory", async () => {
  const calls: unknown[][] = [];
  const service = productionPlanningService({
    git: {
      ensureClone() {
        return Promise.reject(
          new Error(
            "fetch: could not prepare the project clone (fatal: unable to access 'https://x-access-token:ghp_secret@github.com/example/wired/': Could not resolve host)\nmore",
          ),
        );
      },
      describeRepository() {
        return Promise.reject(new Error("must not be reached"));
      },
    },
    runners: recordingRunners(calls),
    now: () => NOW,
  });
  await assert.rejects(
    service.inspect(project()),
    (err: unknown) =>
      err instanceof RepositoryUnavailableError &&
      err.code === "REPOSITORY_UNAVAILABLE" &&
      err.projectId === "proj-1" &&
      err.message.includes("https://***@github.com/example/wired/") &&
      !err.message.includes("ghp_secret") &&
      !err.message.includes("more") &&
      /planning did not run/.test(err.message),
  );
  assert.deepEqual(calls, [], "no planner runner may be invoked without an inspected clone");
  assert.equal(
    describeRepositoryFailure(new Error("x".repeat(400))).length,
    300,
    "failure details are bounded",
  );
});

test("VW03: production planning runs inside the inspected clone and forwards the inspection", async () => {
  const calls: unknown[][] = [];
  const service = productionPlanningService({
    git: gitWith({ branch: "main", headSha: HEAD, trackedFiles: ["src/app.py"] }),
    runners: recordingRunners(calls),
    now: () => NOW,
  });
  assert.equal(service.kind, "production");
  const signal = new AbortController().signal;
  const onInvocation = () => {};
  const onWarn = () => {};
  const onVerified = () => {};
  const cachedReferences: VerifiedFigmaReference[] = [];
  const messages = [{ role: "user" as const, content: "hi" }];

  const chat = await service.chat({
    project: project(),
    plannerModel: PLANNER,
    repository: REPOSITORY,
    messages,
    priorContext: "prior",
    attachmentNames: ["a.png"],
    signal,
    onInvocation,
  });
  assert.deepEqual(chat, { reply: "real reply", costUsd: 0.25 });
  assert.deepEqual(calls[0], [
    "chat",
    messages,
    "Wired project",
    "/clones/wired",
    PLANNER,
    "prior",
    ["a.png"],
    signal,
    onInvocation,
    REPOSITORY,
  ]);

  const deconstructed = await service.deconstruct({
    project: project(),
    plannerModel: PLANNER,
    repository: REPOSITORY,
    messages,
    priorContext: undefined,
    attachmentNames: [],
    onWarn,
    signal,
    onInvocation,
    cachedVerifiedFigmaReferences: cachedReferences,
    onVerifiedFigmaReferences: onVerified,
    figmaVerification: "attachments",
  });
  assert.deepEqual(deconstructed, { output: OUTPUT, costUsd: 0.5 });
  assert.deepEqual(calls[1], [
    "deconstruct",
    messages,
    "Wired project",
    "/clones/wired",
    PLANNER,
    undefined,
    [],
    onWarn,
    signal,
    onInvocation,
    cachedReferences,
    onVerified,
    "attachments",
    REPOSITORY,
  ]);

  const planned = await service.planGoal({
    project: project(),
    plannerModel: PLANNER,
    repository: REPOSITORY,
    goal: "build it",
    onWarn,
    signal,
    onInvocation,
  });
  assert.equal(planned, OUTPUT);
  assert.deepEqual(calls[2], [
    "plan",
    "build it",
    "Wired project",
    "/clones/wired",
    PLANNER,
    onWarn,
    signal,
    onInvocation,
    REPOSITORY,
  ]);
});
