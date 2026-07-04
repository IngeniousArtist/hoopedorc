import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentAdapter, AgentRunResult } from "@orc/adapters";
import type { GateResult, Project, Run, Settings, Task } from "@orc/types";
import { Orchestrator } from "./orchestrator.js";
import type { SchedulerDeps } from "./index.js";

function settings(): Settings {
  return {
    models: [
      { id: "deepseek-flash", displayName: "f", runner: "opencode", opencodeModel: "x", roles: ["medium"], enabled: true, maxConcurrent: 2 },
      { id: "deepseek-pro", displayName: "p", runner: "opencode", opencodeModel: "y", roles: ["hard", "validator"], enabled: true, maxConcurrent: 1 },
    ],
    routing: {
      planner: "claude",
      byDifficulty: { easy: "deepseek-flash", medium: "deepseek-flash", hard: "deepseek-pro" },
      byRole: {},
      validatorByDifficulty: { easy: "deepseek-pro", medium: "deepseek-pro", hard: "deepseek-pro" },
    },
    mergePolicy: "hard_gate_flag_risky",
    riskyChangeRules: { dbSchema: false, newDependencies: false, authOrSecrets: false, outOfScopeEdits: true },
    confidenceThreshold: 0.7,
  };
}

const PROJECT: Project = {
  id: "p1", name: "p", repoUrl: "", defaultBranch: "main", localPath: ".",
  status: "running", createdAt: "", updatedAt: "",
};

const GOOD_GATE: GateResult = {
  typecheck: true, lint: true, build: true, tests: true,
  noConflicts: true, inScope: true, details: {},
};

function task(id: string, dependsOn: string[] = [], over: Partial<Task> = {}): Task {
  return {
    id, projectId: "p1", title: id, description: "", difficulty: "medium",
    status: "ready", dependsOn, acceptanceCriteria: [], assignedModel: "deepseek-flash",
    scopePaths: ["**/*"], attempts: 0, maxAttempts: 2, createdAt: "", updatedAt: "", ...over,
  };
}

const approveAdapter: AgentAdapter = {
  runner: "opencode",
  async run(): Promise<AgentRunResult> {
    return { ok: true, exitReason: "completed", costUsd: 0.01, tokensIn: 1, tokensOut: 1,
      summary: JSON.stringify({ verdict: "approve", reasons: ["lgtm"], confidence: 0.95 }) };
  },
};

function fakeDeps(over: Partial<SchedulerDeps>, merged: number[], changed: string[] = ["src/example.ts"]): SchedulerDeps {
  return {
    settings: settings(),
    opencodeBaseUrl: "",
    adapterFor: () => approveAdapter,
    worktrees: {
      async create(_p, t) { return { branch: `orc/${t.id}`, path: `/tmp/${t.id}` }; },
      async remove() {},
      async changedFiles() { return changed; },
      async changedFilesInScope() { return true; },
    },
    git: {
      async ensureClone() {}, async commitAll() {}, async push() {},
      async openPr() { return 1; },
      async mergePr(_p, n) { merged.push(n); },
      async revertMerge() {},
      async appendChangelogEntry() {},
      async syncBranchWithMain() { return "clean" as const; },
    },
    gates: { async run() { return GOOD_GATE; } },
    validator: {
      async review(_p, t, g) {
        return { id: "d", taskId: t.id, runId: "", validatorModel: "deepseek-pro",
          verdict: "approve", reasons: ["ok"], confidence: 0.95, gate: g, ts: "" };
      },
    },
    events: {
      onLog() {}, onTaskUpdated() {}, onRunUpdated() {}, onMergeDecision() {},
      async requestApproval() { return "reject"; },
    },
    ...over,
  };
}

test("drives a 2-task DAG to done and merges both, respecting dependency order", async () => {
  const merged: number[] = [];
  const t1 = task("t1");
  const t2 = task("t2", ["t1"], { status: "backlog" });
  await new Orchestrator(fakeDeps({}, merged)).start(PROJECT, [t1, t2]);
  assert.equal(t1.status, "done");
  assert.equal(t2.status, "done");
  assert.equal(merged.length, 2);
});

test("emits a live 'running' run row before the terminal one, sharing the same startedAt", async () => {
  const merged: number[] = [];
  const runs: Run[] = [];
  const deps = fakeDeps(
    {
      events: {
        onLog() {},
        onTaskUpdated() {},
        onRunUpdated(r) {
          runs.push(r);
        },
        onMergeDecision() {},
        async requestApproval() {
          return "reject";
        },
      },
    },
    merged,
  );
  const t1 = task("t1");
  await new Orchestrator(deps).start(PROJECT, [t1]);

  const authorRuns = runs.filter((r) => r.id === "run-t1-1");
  assert.equal(authorRuns.length, 2, "expected a running row then a terminal row");
  assert.equal(authorRuns[0]!.status, "running");
  assert.equal(authorRuns[0]!.endedAt, undefined, "no run row should look instantly finished");
  assert.equal(authorRuns[1]!.status, "passed");
  assert.equal(
    authorRuns[0]!.startedAt,
    authorRuns[1]!.startedAt,
    "the terminal emit must preserve the original startedAt, not a fresh one",
  );
  assert.ok(authorRuns[1]!.endedAt, "the terminal emit sets endedAt");
});

test("a budget cap stops the autonomous loop before dispatching or merging", async () => {
  const merged: number[] = [];
  const logs: { level: string; message: string }[] = [];
  let authorRuns = 0;
  const deps = fakeDeps(
    {
      checkBudget: () => "Project budget $1 exceeded ($2.00 used)",
      adapterFor: () => ({
        runner: "opencode",
        async run() {
          authorRuns++;
          return { ok: true, exitReason: "completed", costUsd: 0.01, tokensIn: 1, tokensOut: 1, summary: "" };
        },
      }),
      events: {
        onLog(e) { logs.push({ level: e.level, message: e.message }); },
        onTaskUpdated() {}, onRunUpdated() {}, onMergeDecision() {},
        async requestApproval() { return "reject"; },
      },
    },
    merged,
  );
  const t1 = task("t1");
  await new Orchestrator(deps).start(PROJECT, [t1]);
  assert.equal(authorRuns, 0, "no model should run while over budget");
  assert.equal(merged.length, 0, "nothing should merge while over budget");
  assert.notEqual(t1.status, "done");
  assert.ok(
    logs.some((l) => l.level === "error" && /Budget cap reached/.test(l.message)),
    "should emit a budget-cap error log",
  );
});

test("stopTask aborts a running author and the task ends blocked without merging", async () => {
  const merged: number[] = [];
  let resolveStarted!: () => void;
  const started = new Promise<void>((r) => {
    resolveStarted = r;
  });
  const adapter: AgentAdapter = {
    runner: "opencode",
    run(opts) {
      resolveStarted();
      return new Promise((_resolve, reject) => {
        opts.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    },
  };
  const deps = fakeDeps({ adapterFor: () => adapter }, merged);
  const orch = new Orchestrator(deps);
  const t1 = task("t1");

  const runPromise = orch.start(PROJECT, [t1]);
  await started;
  const stopped = orch.stopTask(t1.id);
  assert.equal(stopped, true, "stopTask should find the active task");
  await runPromise;

  assert.equal(t1.status, "blocked");
  assert.equal(merged.length, 0, "nothing should merge after a stop");
});

test("stopTask on a manually dispatched task (runTask) also aborts and blocks it", async () => {
  const merged: number[] = [];
  let resolveStarted!: () => void;
  const started = new Promise<void>((r) => {
    resolveStarted = r;
  });
  const adapter: AgentAdapter = {
    runner: "opencode",
    run(opts) {
      resolveStarted();
      return new Promise((_resolve, reject) => {
        opts.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    },
  };
  const deps = fakeDeps({ adapterFor: () => adapter }, merged);
  const orch = new Orchestrator(deps);
  const t1 = task("t1");

  const runPromise = orch.runTask(PROJECT, t1);
  await started;
  const stopped = orch.stopTask(t1.id);
  assert.equal(stopped, true, "stopTask should find a manually-dispatched task too");
  await runPromise;

  assert.equal(t1.status, "blocked");
  assert.equal(merged.length, 0);
});

test("a risky change (new dependency) escalates to a human instead of auto-merging", async () => {
  const merged: number[] = [];
  let asked = false;
  const deps = fakeDeps(
    {
      settings: { ...settings(), riskyChangeRules: { dbSchema: false, newDependencies: true, authOrSecrets: false, outOfScopeEdits: true } },
      events: {
        onLog() {}, onTaskUpdated() {}, onRunUpdated() {}, onMergeDecision() {},
        async requestApproval() { asked = true; return "reject"; },
      },
    },
    merged,
    ["package.json"],
  );
  const t1 = task("t1");
  await new Orchestrator(deps).start(PROJECT, [t1]);
  assert.equal(asked, true);
  assert.equal(merged.length, 0);
  assert.equal(t1.status, "failed");
});

test("sets in_review while gates run and back to in_progress on a gate-failure retry", async () => {
  const merged: number[] = [];
  const statuses: string[] = [];
  let gateCalls = 0;
  const deps = fakeDeps(
    {
      gates: {
        async run() {
          gateCalls++;
          // Fail the first attempt's gate, pass the second's.
          return gateCalls === 1
            ? { ...GOOD_GATE, typecheck: false, details: { typecheck: "boom" } }
            : GOOD_GATE;
        },
      },
      events: {
        onLog() {},
        onTaskUpdated(t) {
          statuses.push(t.status);
        },
        onRunUpdated() {},
        onMergeDecision() {},
        async requestApproval() {
          return "reject";
        },
      },
    },
    merged,
  );
  const t1 = task("t1"); // default maxAttempts: 2
  await new Orchestrator(deps).start(PROJECT, [t1]);

  assert.equal(t1.status, "done");
  const reviewIndices = statuses
    .map((s, i) => (s === "in_review" ? i : -1))
    .filter((i) => i >= 0);
  assert.ok(
    reviewIndices.length >= 2,
    "should enter in_review once per attempt (failed + retried)",
  );
  const between = statuses.slice(reviewIndices[0]! + 1, reviewIndices[1]!);
  assert.ok(
    between.includes("in_progress"),
    "must reset to in_progress before the retry's own in_review, not stay stuck",
  );
});
