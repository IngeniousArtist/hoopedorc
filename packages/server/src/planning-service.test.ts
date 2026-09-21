import assert from "node:assert/strict";
import { test } from "node:test";
import type { Project, VerifiedFigmaReference } from "@orc/types";
import type { PlannerModel, PlanOutput } from "./planner.js";
import {
  productionPlanningService,
  resolvePlannerCwd,
  selectPlanningService,
  type PlanningService,
  type ProductionPlannerRunners,
} from "./planning-service.js";

const PLANNER: PlannerModel = { id: "claude", runner: "claude-code", model: "sonnet" };
const OUTPUT: PlanOutput = { prdMarkdown: "# PRD", agentsMd: "# AGENTS", tasks: [] };

function project(): Project {
  return {
    id: "proj-1",
    name: "Wired project",
    repoUrl: "https://github.com/example/wired",
    defaultBranch: "main",
    localPath: "/clones/wired",
    status: "paused",
    createdAt: "2026-09-21T00:00:00.000Z",
    updatedAt: "2026-09-21T00:00:00.000Z",
  };
}

function fakeService(kind: PlanningService["kind"]): PlanningService {
  return {
    kind,
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

test("VW01: production planning resolves the clone first and forwards every argument in order", async () => {
  const calls: unknown[][] = [];
  const cloned: string[] = [];
  const service = productionPlanningService({
    git: {
      ensureClone(target) {
        cloned.push(target.localPath);
        return Promise.resolve();
      },
    },
    runners: recordingRunners(calls),
    fallbackCwd: () => "/fallback",
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
  ]);

  const deconstructed = await service.deconstruct({
    project: project(),
    plannerModel: PLANNER,
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
  ]);

  const planned = await service.planGoal({
    project: project(),
    plannerModel: PLANNER,
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
  ]);
  assert.deepEqual(cloned, ["/clones/wired", "/clones/wired", "/clones/wired"]);
});

test("VW01: an unreachable clone keeps the documented fallback directory (VW03 owns disclosing it)", async () => {
  const calls: unknown[][] = [];
  const service = productionPlanningService({
    git: {
      ensureClone() {
        return Promise.reject(new Error("offline"));
      },
    },
    runners: recordingRunners(calls),
    fallbackCwd: () => "/fallback",
  });
  await service.chat({
    project: project(),
    plannerModel: PLANNER,
    messages: [{ role: "user", content: "hi" }],
    attachmentNames: [],
  });
  assert.equal(calls[0]?.[3], "/fallback");
  assert.equal(
    await resolvePlannerCwd(
      project(),
      { ensureClone: () => Promise.reject(new Error("offline")) },
      () => "/elsewhere",
    ),
    "/elsewhere",
  );
});
