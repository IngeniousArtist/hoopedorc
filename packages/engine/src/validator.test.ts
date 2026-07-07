import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentAdapter, AgentRunResult } from "@orc/adapters";
import type { GateResult, Project, Settings, Task } from "@orc/types";
import { ValidatorImpl } from "./validator.js";

const PROJECT: Project = {
  id: "p1",
  name: "p",
  repoUrl: "",
  defaultBranch: "main",
  // Deliberately not a git repo — getDiff() fails fast and falls back to
  // its placeholder text; this test only cares about the prompt's shape,
  // not real diff content.
  localPath: "/tmp",
  status: "running",
  createdAt: "",
  updatedAt: "",
};

const GATE: GateResult = {
  typecheck: true,
  lint: true,
  build: true,
  tests: true,
  noConflicts: true,
  inScope: true,
  details: {},
};

function task(over: Partial<Task> = {}): Task {
  return {
    id: "t1",
    projectId: "p1",
    title: "Task",
    description: "desc",
    difficulty: "medium",
    status: "in_review",
    dependsOn: [],
    acceptanceCriteria: ["works"],
    assignedModel: "deepseek-flash",
    scopePaths: ["**/*"],
    attempts: 1,
    maxAttempts: 3,
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

function baseSettings(): Settings {
  return {
    models: [],
    routing: {
      planner: "claude",
      byDifficulty: { easy: "deepseek-flash", medium: "deepseek-flash", hard: "deepseek-flash" },
      byRole: {},
      validatorByDifficulty: { easy: "claude", medium: "claude", hard: "claude" },
    },
    mergePolicy: "hard_gate_flag_risky",
    riskyChangeRules: {
      dbSchema: false,
      newDependencies: false,
      authOrSecrets: false,
      outOfScopeEdits: true,
    },
    confidenceThreshold: 0.7,
  };
}

function capturingAdapterFactory(sink: string[]): (modelId: string) => AgentAdapter {
  return () => ({
    runner: "opencode",
    async run(opts): Promise<AgentRunResult> {
      sink.push(opts.prompt);
      return {
        ok: true,
        exitReason: "completed",
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
        summary: JSON.stringify({ verdict: "approve", reasons: ["ok"], confidence: 0.9 }),
      };
    },
  });
}

test("F31: validator review prompt includes guidelines — ux only for a frontend-role task", async () => {
  const prompts: string[] = [];
  const settings = baseSettings();
  settings.guidelines = {
    coding: "Follow existing conventions.",
    ux: "Every action shows a loading state.",
    security: "Never hardcode secrets.",
  };
  const validator = new ValidatorImpl(capturingAdapterFactory(prompts), settings);

  await validator.review(PROJECT, task({ role: "frontend" }), GATE, "deepseek-flash");
  await validator.review(PROJECT, task({ role: undefined }), GATE, "deepseek-flash");

  assert.equal(prompts.length, 2);
  const [frontendPrompt, backendPrompt] = prompts;

  assert.match(frontendPrompt!, /## Engineering standards/);
  assert.match(frontendPrompt!, /### Coding\nFollow existing conventions\./);
  assert.match(frontendPrompt!, /### UX\nEvery action shows a loading state\./);
  assert.match(frontendPrompt!, /### Security\nNever hardcode secrets\./);
  assert.match(
    frontendPrompt!,
    /clearly violates the Engineering standards above/,
    "should tell the validator to flag standards violations",
  );

  assert.match(backendPrompt!, /### Coding/);
  assert.match(backendPrompt!, /### Security/);
  assert.doesNotMatch(backendPrompt!, /### UX/);
});

test("F31: no guidelines configured leaves the review prompt unchanged (no flag-violations instruction either)", async () => {
  const prompts: string[] = [];
  const settings = baseSettings(); // no guidelines set
  const validator = new ValidatorImpl(capturingAdapterFactory(prompts), settings);

  await validator.review(PROJECT, task(), GATE, "deepseek-flash");

  assert.equal(prompts.length, 1);
  assert.doesNotMatch(prompts[0]!, /## Engineering standards/);
  assert.doesNotMatch(prompts[0]!, /clearly violates the Engineering standards/);
});
