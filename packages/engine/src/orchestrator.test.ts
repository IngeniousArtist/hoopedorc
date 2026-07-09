import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentAdapter, AgentRunResult } from "@orc/adapters";
import type { GateResult, MergeDecision, Project, Run, Settings, Task } from "@orc/types";
import { Orchestrator, isAuthOrSecretFile, scopesOverlap } from "./orchestrator.js";
import type { GitService, SchedulerDeps, WorktreeManager } from "./index.js";

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

function fakeDeps(
  over: Partial<Omit<SchedulerDeps, "git" | "worktrees">> & {
    git?: Partial<GitService>;
    worktrees?: Partial<WorktreeManager>;
  },
  merged: number[],
  changed: string[] = ["src/example.ts"],
): SchedulerDeps {
  const { git: gitOver, worktrees: worktreesOver, ...restOver } = over;
  return {
    settings: settings(),
    opencodeBaseUrl: "",
    adapterFor: () => approveAdapter,
    worktrees: {
      async create(_p, t) { return { branch: `orc/${t.id}`, path: `/tmp/${t.id}` }; },
      async remove() {},
      async changedFiles() { return changed; },
      async changedFilesInScope() { return true; },
      async revertOutOfScope() { return []; },
      ...worktreesOver,
    },
    git: {
      async ensureClone() {}, async commitAll() {}, async push() {},
      async openPr() { return 1; },
      async mergePr(_p, n) { merged.push(n); },
      async revertMerge() {},
      async appendChangelogEntry() {},
      async syncBranchWithMain() { return "clean" as const; },
      async waitForChecks() { return "none" as const; },
      ...gitOver,
    },
    gates: { async run() { return GOOD_GATE; } },
    validator: {
      async review(p, t, g) {
        return { id: "d", projectId: p.id, taskId: t.id, runId: "", validatorModel: "deepseek-pro",
          verdict: "approve", reasons: ["ok"], confidence: 0.95, gate: g, ts: "" };
      },
    },
    events: {
      onLog() {}, onTaskUpdated() {}, onRunUpdated() {}, onMergeDecision() {},
      async requestApproval() { return "reject"; },
    },
    ...restOver,
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

test("a cooling-down model is skipped at dispatch instead of burning an attempt", async () => {
  const merged: number[] = [];
  const logs: { level: string; message: string }[] = [];
  let authorRuns = 0;
  const deps = fakeDeps(
    {
      checkModelCooldown: (m) => (m === "deepseek-flash" ? "cooling down for 3m" : null),
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
  const t1 = task("t1"); // default assignedModel: "deepseek-flash"
  await new Orchestrator(deps).start(PROJECT, [t1]);
  assert.equal(authorRuns, 0, "no model should run while its assigned model is cooling down");
  assert.equal(merged.length, 0);
  assert.notEqual(t1.status, "done");
  assert.ok(
    logs.some((l) => l.level === "warn" && /Model cooling down/.test(l.message)),
    "should emit a cooldown warn log",
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

test("pause({ drain: true }) lets the active task finish but stops new dispatch", async () => {
  const merged: number[] = [];
  let resolveStarted!: () => void;
  const started = new Promise<void>((r) => {
    resolveStarted = r;
  });
  let resolveRun!: (v: AgentRunResult) => void;
  const runResult = new Promise<AgentRunResult>((r) => {
    resolveRun = r;
  });
  const adapter: AgentAdapter = {
    runner: "opencode",
    run() {
      resolveStarted();
      return runResult;
    },
  };
  const deps = fakeDeps({ adapterFor: () => adapter }, merged);
  const orch = new Orchestrator(deps);
  const t1 = task("t1");
  // t2 depends on t1, so it only becomes ready once t1 finishes — this is
  // what actually exercises draining (t1 and t2 would otherwise both be
  // ready and get dispatched together in start()'s very first pass, before
  // the test ever gets a chance to call pause()).
  const t2 = task("t2", [t1.id], { status: "backlog" });

  const runPromise = orch.start(PROJECT, [t1, t2]);
  await started;
  assert.equal(t1.status, "in_progress");

  await orch.pause(PROJECT, { drain: true });
  assert.equal(
    t1.status,
    "in_progress",
    "draining must not reset the active task's status the way a hard stop would",
  );

  resolveRun({
    ok: true,
    exitReason: "completed",
    costUsd: 0.01,
    tokensIn: 1,
    tokensOut: 1,
    summary: JSON.stringify({ verdict: "approve", reasons: ["lgtm"], confidence: 0.95 }),
  });
  await runPromise;

  assert.equal(t1.status, "done");
  assert.equal(merged.length, 1, "only t1 should have merged");
  assert.equal(
    t2.status,
    "backlog",
    "t2 became ready only once t1 finished mid-drain, and must still not be dispatched",
  );
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

test("a vacuous gate result (no scripts ran) escalates to a human instead of auto-merging", async () => {
  const merged: number[] = [];
  let asked = false;
  const deps = fakeDeps({
    gates: { async run() { return { ...GOOD_GATE, vacuous: true }; } },
    events: {
      onLog() {}, onTaskUpdated() {}, onRunUpdated() {}, onMergeDecision() {},
      async requestApproval() { asked = true; return "reject"; },
    },
  }, merged);
  const t1 = task("t1");
  await new Orchestrator(deps).start(PROJECT, [t1]);
  assert.equal(asked, true);
  assert.equal(merged.length, 0);
  assert.equal(t1.status, "failed");
});

test("a vacuous gate result auto-merges when settings.allowVacuousGates is on", async () => {
  const merged: number[] = [];
  const deps = fakeDeps({
    settings: { ...settings(), allowVacuousGates: true },
    gates: { async run() { return { ...GOOD_GATE, vacuous: true }; } },
  }, merged);
  const t1 = task("t1");
  await new Orchestrator(deps).start(PROJECT, [t1]);
  assert.equal(merged.length, 1);
  assert.equal(t1.status, "done");
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

test("a task added mid-run (not in the array start() was given) is picked up via getTasks, no restart needed", async () => {
  const merged: number[] = [];
  const t1 = task("t1", [], { scopePaths: ["src/a/**"] });
  const t2 = task("t2", [], { scopePaths: ["src/b/**"] });
  let getTasksCalls = 0;
  const deps = fakeDeps(
    {
      // t2 only "exists in the DB" from the second poll onward — simulates
      // plan/commit writing a new task row while the autonomous loop (which
      // was started with just [t1]) is already running.
      getTasks: () => {
        getTasksCalls++;
        return getTasksCalls <= 1 ? [t1] : [t1, t2];
      },
    },
    merged,
  );
  // t2 is deliberately NOT in the array passed to start().
  await new Orchestrator(deps).start(PROJECT, [t1]);

  assert.ok(getTasksCalls > 1, "sanity: reconcile polled more than once");
  assert.equal(t1.status, "done");
  assert.equal(t2.status, "done");
  assert.equal(merged.length, 2);
});

test("project.config.mergePolicy overrides the global Settings.mergePolicy (F9)", async () => {
  // Global policy is "always_ask" (never auto-merge), but this project opts
  // into "fully_autonomous" — the project-level override must win.
  const merged: number[] = [];
  const deps = fakeDeps({ settings: { ...settings(), mergePolicy: "always_ask" } }, merged);
  const project: Project = { ...PROJECT, config: { mergePolicy: "fully_autonomous" } };
  const t1 = task("t1");
  await new Orchestrator(deps).start(project, [t1]);
  assert.equal(t1.status, "done");
  assert.equal(merged.length, 1, "the project override should have allowed an auto-merge");
});

test("F12: a shared model-concurrency registry enforces maxConcurrent across two separate Orchestrator instances", async () => {
  // Simulates EngineRunner wiring the same counter into every project's
  // Orchestrator via deps.getModelActive/incModelActive/decModelActive.
  // Without sharing, each Orchestrator's own local count starts at 0, so two
  // "projects" could each run maxConcurrent copies of the same model at once.
  const shared = new Map<string, number>();
  const getModelActive = (m: string) => shared.get(m) ?? 0;
  const incModelActive = (m: string) => shared.set(m, (shared.get(m) ?? 0) + 1);
  const decModelActive = (m: string) =>
    shared.set(m, Math.max(0, (shared.get(m) ?? 0) - 1));

  let concurrentAuthors = 0;
  let maxConcurrentAuthors = 0;
  const blockingAdapter: AgentAdapter = {
    runner: "opencode",
    async run(): Promise<AgentRunResult> {
      concurrentAuthors++;
      maxConcurrentAuthors = Math.max(maxConcurrentAuthors, concurrentAuthors);
      await new Promise((r) => setTimeout(r, 30));
      concurrentAuthors--;
      return {
        ok: true, exitReason: "completed", costUsd: 0.01, tokensIn: 1, tokensOut: 1,
        summary: JSON.stringify({ verdict: "approve", reasons: ["lgtm"], confidence: 0.95 }),
      };
    },
  };

  const mergedA: number[] = [];
  const mergedB: number[] = [];
  const depsA = fakeDeps(
    { adapterFor: () => blockingAdapter, getModelActive, incModelActive, decModelActive },
    mergedA,
  );
  const depsB = fakeDeps(
    { adapterFor: () => blockingAdapter, getModelActive, incModelActive, decModelActive },
    mergedB,
  );

  // deepseek-pro has maxConcurrent: 1 in the shared test settings() fixture.
  const t1 = task("proj-a-t1", [], { assignedModel: "deepseek-pro" });
  const t2 = task("proj-b-t1", [], { assignedModel: "deepseek-pro" });

  await Promise.all([
    new Orchestrator(depsA).start(PROJECT, [t1]),
    new Orchestrator(depsB).start(PROJECT, [t2]),
  ]);

  assert.equal(t1.status, "done");
  assert.equal(t2.status, "done");
  assert.equal(
    maxConcurrentAuthors,
    1,
    "the shared registry should serialize two projects dispatching the same maxConcurrent:1 model",
  );
});

test("B18: a capacity-blocked task logs exactly one warn across several polls, then dispatches once capacity frees up", async () => {
  const merged: number[] = [];
  const logs: { level: string; message: string }[] = [];
  // deepseek-pro has maxConcurrent: 1 in the shared test settings() fixture;
  // start the shared registry already "full" so every ready task is
  // capacity-blocked from the first pass.
  let active = 1;
  const deps = fakeDeps(
    {
      getModelActive: () => active,
      incModelActive: () => {
        active++;
      },
      decModelActive: () => {
        active = Math.max(0, active - 1);
      },
      events: {
        onLog(e) {
          logs.push({ level: e.level, message: e.message });
        },
        onTaskUpdated() {}, onRunUpdated() {}, onMergeDecision() {},
        async requestApproval() {
          return "reject";
        },
      },
    },
    merged,
  );
  const t1 = task("t1", [], { assignedModel: "deepseek-pro" });

  // Let the 250ms poll loop run through several capacity-blocked passes
  // before freeing the slot.
  setTimeout(() => {
    active = 0;
  }, 600);

  await new Orchestrator(deps).start(PROJECT, [t1]);

  assert.equal(t1.status, "done", "should dispatch and finish once capacity frees up");
  const capacityWarnings = logs.filter(
    (l) => l.level === "warn" && /at capacity/.test(l.message),
  );
  assert.equal(
    capacityWarnings.length,
    1,
    "should warn exactly once across all the blocked polls, not once per poll",
  );
});

test("B19: a manually-dispatched task (runTask) counts toward the shared model cap, serializing a second Orchestrator's autonomous dispatch behind it", async () => {
  // Simulates EngineRunner wiring the same shared registry into both a
  // manual dispatch's Orchestrator and a different project's autonomous-loop
  // Orchestrator.
  const shared = new Map<string, number>();
  const getModelActive = (m: string) => shared.get(m) ?? 0;
  const incModelActive = (m: string) => shared.set(m, (shared.get(m) ?? 0) + 1);
  const decModelActive = (m: string) =>
    shared.set(m, Math.max(0, (shared.get(m) ?? 0) - 1));

  let concurrentAuthors = 0;
  let maxConcurrentAuthors = 0;
  const blockingAdapter: AgentAdapter = {
    runner: "opencode",
    async run(): Promise<AgentRunResult> {
      concurrentAuthors++;
      maxConcurrentAuthors = Math.max(maxConcurrentAuthors, concurrentAuthors);
      await new Promise((r) => setTimeout(r, 30));
      concurrentAuthors--;
      return {
        ok: true, exitReason: "completed", costUsd: 0.01, tokensIn: 1, tokensOut: 1,
        summary: JSON.stringify({ verdict: "approve", reasons: ["lgtm"], confidence: 0.95 }),
      };
    },
  };

  const merged: number[] = [];
  const depsManual = fakeDeps(
    { adapterFor: () => blockingAdapter, getModelActive, incModelActive, decModelActive },
    merged,
  );
  const depsLoop = fakeDeps(
    { adapterFor: () => blockingAdapter, getModelActive, incModelActive, decModelActive },
    merged,
  );

  // deepseek-pro has maxConcurrent: 1 in the shared test settings() fixture.
  const manualTask = task("manual-t1", [], { assignedModel: "deepseek-pro" });
  const loopTask = task("loop-t1", [], { assignedModel: "deepseek-pro" });

  await Promise.all([
    new Orchestrator(depsManual).runTask(PROJECT, manualTask),
    new Orchestrator(depsLoop).start(PROJECT, [loopTask]),
  ]);

  assert.equal(manualTask.status, "done");
  assert.equal(loopTask.status, "done");
  assert.equal(
    maxConcurrentAuthors,
    1,
    "the manual dispatch's model use must be visible to the autonomous loop's capacity check, serializing them",
  );
});

test("F15: GitHub checks \"passed\" falls through to the normal auto-merge check", async () => {
  const merged: number[] = [];
  const polls: number[] = [];
  const deps = fakeDeps(
    {
      git: {
        async waitForChecks(_p, _n, _t, onPoll) {
          onPoll?.(0);
          polls.push(0);
          return "passed" as const;
        },
      },
    },
    merged,
  );
  const project = { ...PROJECT, config: { requireGithubChecks: true } };
  const t1 = task("t1");
  await new Orchestrator(deps).start(project, [t1]);
  assert.equal(t1.status, "done");
  assert.equal(merged.length, 1);
  assert.equal(polls.length, 1, "waitForChecks should have been called and polled once");
});

test("F15: GitHub checks \"none\" (no checks configured) also falls through to auto-merge", async () => {
  const merged: number[] = [];
  const deps = fakeDeps(
    { git: { async waitForChecks() { return "none" as const; } } },
    merged,
  );
  const project = { ...PROJECT, config: { requireGithubChecks: true } };
  const t1 = task("t1");
  await new Orchestrator(deps).start(project, [t1]);
  assert.equal(t1.status, "done");
  assert.equal(merged.length, 1);
});

test("F15: GitHub checks \"failed\" escalates to approval instead of auto-merging — approved merges anyway", async () => {
  const merged: number[] = [];
  const logs: { level: string; message: string }[] = [];
  const deps = fakeDeps(
    {
      git: { async waitForChecks() { return "failed" as const; } },
      events: {
        onLog(e) { logs.push({ level: e.level, message: e.message }); },
        onTaskUpdated() {}, onRunUpdated() {}, onMergeDecision() {},
        async requestApproval() { return "approve_merge"; },
      },
    },
    merged,
  );
  const project = { ...PROJECT, config: { requireGithubChecks: true } };
  const t1 = task("t1");
  await new Orchestrator(deps).start(project, [t1]);
  assert.equal(t1.status, "done", "a human can approve the merge despite failed checks");
  assert.equal(merged.length, 1);
  assert.ok(
    logs.some((l) => l.level === "warn" && /GitHub checks failed/.test(l.message)),
    "should log why approval was requested",
  );
});

test("F15: GitHub checks \"timeout\" escalates to approval — rejected fails the task without merging", async () => {
  const merged: number[] = [];
  const deps = fakeDeps(
    {
      git: { async waitForChecks() { return "timeout" as const; } },
      events: {
        onLog() {}, onTaskUpdated() {}, onRunUpdated() {}, onMergeDecision() {},
        async requestApproval() { return "reject"; },
      },
    },
    merged,
  );
  const project = { ...PROJECT, config: { requireGithubChecks: true, githubChecksTimeoutMin: 5 } };
  const t1 = task("t1");
  await new Orchestrator(deps).start(project, [t1]);
  assert.equal(t1.status, "failed");
  assert.equal(merged.length, 0, "must not merge after a rejected timeout escalation");
});

test("F15: a Stop requested during the GitHub-checks wait blocks the task without merging", async () => {
  const merged: number[] = [];
  let resolveWaitStarted!: () => void;
  const waitStarted = new Promise<void>((r) => {
    resolveWaitStarted = r;
  });
  let resolveChecks!: (v: "passed") => void;
  const checksPromise = new Promise<"passed">((r) => {
    resolveChecks = r;
  });
  const deps = fakeDeps(
    {
      git: {
        async waitForChecks() {
          resolveWaitStarted();
          return checksPromise;
        },
      },
    },
    merged,
  );
  const project = { ...PROJECT, config: { requireGithubChecks: true } };
  const t1 = task("t1");
  const orch = new Orchestrator(deps);
  const runPromise = orch.runTask(project, t1);
  await waitStarted;
  const stopped = orch.stopTask(t1.id);
  assert.equal(stopped, true);
  resolveChecks("passed"); // simulate checks finishing after the stop was requested
  await runPromise;
  assert.equal(t1.status, "blocked");
  assert.equal(merged.length, 0, "must not merge after a stop, even if checks ultimately passed");
});

test("F16: a model at its subscription quota is skipped at dispatch (warned once, not once per poll)", async () => {
  const merged: number[] = [];
  const logs: { level: string; message: string }[] = [];
  const deps = fakeDeps(
    {
      checkModelQuota: (m) =>
        m === "deepseek-pro"
          ? "Model deepseek-pro quota reached: 5/5 runs in the last 24h"
          : null,
      // A slow-but-unblocked task on a different model keeps the dispatch
      // loop alive across several 250ms polls, so the quota-blocked task
      // (on a non-overlapping scope, so it isn't held back for THAT reason
      // instead) gets re-evaluated more than once — proving the warn is
      // deduped, not just incidentally logged a single time.
      adapterFor: () => ({
        runner: "opencode",
        async run() {
          await new Promise((r) => setTimeout(r, 600));
          return {
            ok: true, exitReason: "completed", costUsd: 0.01, tokensIn: 1, tokensOut: 1,
            summary: JSON.stringify({ verdict: "approve", reasons: ["lgtm"], confidence: 0.95 }),
          };
        },
      }),
      events: {
        onLog(e) {
          logs.push({ level: e.level, message: e.message });
        },
        onTaskUpdated() {}, onRunUpdated() {}, onMergeDecision() {},
        async requestApproval() {
          return "reject";
        },
      },
    },
    merged,
  );
  const slowTask = task("slow", [], {
    assignedModel: "deepseek-flash",
    scopePaths: ["src/a/**"],
  });
  const quotaTask = task("quota-blocked", [], {
    assignedModel: "deepseek-pro",
    scopePaths: ["src/b/**"],
  });
  await new Orchestrator(deps).start(PROJECT, [slowTask, quotaTask]);
  assert.equal(slowTask.status, "done");
  assert.notEqual(quotaTask.status, "done", "the quota-blocked task should never dispatch");
  const quotaWarnings = logs.filter(
    (l) => l.level === "warn" && /Model quota reached/.test(l.message),
  );
  assert.equal(
    quotaWarnings.length,
    1,
    "should warn exactly once across all the blocked polls, not once per poll",
  );
});

test("isAuthOrSecretFile matches path segments, not substrings", () => {
  assert.equal(isAuthOrSecretFile("author.ts"), false, "substring of an unrelated filename");
  assert.equal(isAuthOrSecretFile("auth.ts"), true);
  assert.equal(isAuthOrSecretFile("src/auth/login.ts"), true);
  assert.equal(isAuthOrSecretFile("tokenizer.ts"), false, "substring of an unrelated filename");
  assert.equal(isAuthOrSecretFile(".env.local"), true);
  assert.equal(isAuthOrSecretFile("docs/authors.md"), false, "substring of an unrelated filename");
});

test("scopesOverlap normalizes glob patterns to their static prefix instead of comparing them literally", () => {
  assert.equal(
    scopesOverlap(["**/*"], ["docs/**"]),
    true,
    "an unscoped **/* pattern can't rule out anything",
  );
  assert.equal(
    scopesOverlap(["src/**/*.ts"], ["src/utils/**"]),
    true,
    "src/**/*.ts and src/utils/** share the src prefix",
  );
  assert.equal(
    scopesOverlap(["docs/**"], ["src/**"]),
    false,
    "docs/** and src/** are genuinely disjoint",
  );
});

test("two independent tasks both scoped **/* run serially, not concurrently", async () => {
  const merged: number[] = [];
  let concurrentAuthors = 0;
  let maxConcurrentAuthors = 0;
  const deps = fakeDeps(
    {
      adapterFor: () => ({
        runner: "opencode",
        async run(): Promise<AgentRunResult> {
          concurrentAuthors++;
          maxConcurrentAuthors = Math.max(maxConcurrentAuthors, concurrentAuthors);
          await new Promise((r) => setTimeout(r, 20));
          concurrentAuthors--;
          return {
            ok: true,
            exitReason: "completed",
            costUsd: 0.01,
            tokensIn: 1,
            tokensOut: 1,
            summary: JSON.stringify({ verdict: "approve", reasons: ["lgtm"], confidence: 0.95 }),
          };
        },
      }),
    },
    merged,
  );
  // Same model (maxConcurrent: 2 in the test settings) and no dependsOn
  // between them — only scope-overlap serialization should stop them
  // running at the same time.
  const t1 = task("t1", [], { scopePaths: ["**/*"] });
  const t2 = task("t2", [], { scopePaths: ["**/*"] });
  await new Orchestrator(deps).start(PROJECT, [t1, t2]);

  assert.equal(t1.status, "done");
  assert.equal(t2.status, "done");
  assert.equal(
    maxConcurrentAuthors,
    1,
    "two **/* -scoped tasks must never author concurrently",
  );
});

test("F31: buildAuthorPrompt includes guidelines — ux only for a frontend-role task", async () => {
  const capturedPrompts: string[] = [];
  const capturingAdapter: AgentAdapter = {
    runner: "opencode",
    async run(opts): Promise<AgentRunResult> {
      capturedPrompts.push(opts.prompt);
      return {
        ok: true,
        exitReason: "completed",
        costUsd: 0.01,
        tokensIn: 1,
        tokensOut: 1,
        summary: JSON.stringify({ verdict: "approve", reasons: ["lgtm"], confidence: 0.95 }),
      };
    },
  };
  const s = settings();
  s.guidelines = {
    coding: "Follow existing conventions.",
    ux: "Every action shows a loading state.",
    security: "Never hardcode secrets.",
  };

  const frontendTask = task("frontend-task", [], { role: "frontend" });
  await new Orchestrator(
    fakeDeps({ settings: s, adapterFor: () => capturingAdapter }, []),
  ).start(PROJECT, [frontendTask]);

  const backendTask = task("backend-task", [], { role: undefined });
  await new Orchestrator(
    fakeDeps({ settings: s, adapterFor: () => capturingAdapter }, []),
  ).start(PROJECT, [backendTask]);

  assert.equal(capturedPrompts.length, 2);
  const [frontendPrompt, backendPrompt] = capturedPrompts;

  assert.match(frontendPrompt!, /## Engineering standards/);
  assert.match(frontendPrompt!, /### Coding\nFollow existing conventions\./);
  assert.match(frontendPrompt!, /### UX\nEvery action shows a loading state\./);
  assert.match(frontendPrompt!, /### Security\nNever hardcode secrets\./);

  assert.match(backendPrompt!, /## Engineering standards/);
  assert.match(backendPrompt!, /### Coding/);
  assert.match(backendPrompt!, /### Security/);
  assert.doesNotMatch(backendPrompt!, /### UX/);
});

test("F31: no guidelines configured leaves the author prompt unchanged", async () => {
  const capturedPrompts: string[] = [];
  const capturingAdapter: AgentAdapter = {
    runner: "opencode",
    async run(opts): Promise<AgentRunResult> {
      capturedPrompts.push(opts.prompt);
      return {
        ok: true,
        exitReason: "completed",
        costUsd: 0.01,
        tokensIn: 1,
        tokensOut: 1,
        summary: JSON.stringify({ verdict: "approve", reasons: ["lgtm"], confidence: 0.95 }),
      };
    },
  };
  const s = settings(); // no guidelines set
  const t1 = task("t1", [], { role: "frontend" });
  await new Orchestrator(
    fakeDeps({ settings: s, adapterFor: () => capturingAdapter }, []),
  ).start(PROJECT, [t1]);

  assert.equal(capturedPrompts.length, 1);
  assert.doesNotMatch(capturedPrompts[0]!, /## Engineering standards/);
});

test("F29: a docs-role task's author prompt includes the docs guidelines; a frontend task's doesn't", async () => {
  const capturedPrompts: string[] = [];
  const capturingAdapter: AgentAdapter = {
    runner: "opencode",
    async run(opts): Promise<AgentRunResult> {
      capturedPrompts.push(opts.prompt);
      return {
        ok: true,
        exitReason: "completed",
        costUsd: 0.01,
        tokensIn: 1,
        tokensOut: 1,
        summary: JSON.stringify({ verdict: "approve", reasons: ["lgtm"], confidence: 0.95 }),
      };
    },
  };
  // No Settings.guidelines configured at all — DOCS_GUIDELINES is a fixed
  // engine constant, not operator-editable, so it must still appear.
  const s = settings();

  const docsTask = task("docs-task", [], { role: "docs" });
  await new Orchestrator(
    fakeDeps({ settings: s, adapterFor: () => capturingAdapter }, []),
  ).start(PROJECT, [docsTask]);

  const frontendTask = task("frontend-task", [], { role: "frontend" });
  await new Orchestrator(
    fakeDeps({ settings: s, adapterFor: () => capturingAdapter }, []),
  ).start(PROJECT, [frontendTask]);

  assert.equal(capturedPrompts.length, 2);
  const [docsPrompt, frontendPrompt] = capturedPrompts;

  assert.match(docsPrompt!, /## Engineering standards/);
  assert.match(docsPrompt!, /### Docs/);
  assert.match(docsPrompt!, /Keep a Changelog shape/);

  assert.doesNotMatch(frontendPrompt!, /### Docs/);
});

test("F34: skillHints appear in the author prompt when configured, absent when unset", async () => {
  const capturedPrompts: string[] = [];
  const capturingAdapter: AgentAdapter = {
    runner: "opencode",
    async run(opts): Promise<AgentRunResult> {
      capturedPrompts.push(opts.prompt);
      return {
        ok: true,
        exitReason: "completed",
        costUsd: 0.01,
        tokensIn: 1,
        tokensOut: 1,
        summary: JSON.stringify({ verdict: "approve", reasons: ["lgtm"], confidence: 0.95 }),
      };
    },
  };
  const s = settings();

  const projectWithHints: Project = {
    ...PROJECT,
    config: {
      skillHints: [
        "frontend-design-guidelines — read before building any UI component",
        "security-review — run before touching auth code",
      ],
    },
  };
  await new Orchestrator(
    fakeDeps({ settings: s, adapterFor: () => capturingAdapter }, []),
  ).start(projectWithHints, [task("t1")]);

  await new Orchestrator(
    fakeDeps({ settings: s, adapterFor: () => capturingAdapter }, []),
  ).start(PROJECT, [task("t2")]);

  assert.equal(capturedPrompts.length, 2);
  const [withHints, withoutHints] = capturedPrompts;

  assert.match(withHints!, /## Skills/);
  assert.match(
    withHints!,
    /- frontend-design-guidelines — read before building any UI component/,
  );
  assert.match(withHints!, /- security-review — run before touching auth code/);

  assert.doesNotMatch(withoutHints!, /## Skills/);
});

test("F38: the AGENTS.md nudge appears in the author prompt exactly when the file exists in the real worktree", async () => {
  const capturedPrompts: string[] = [];
  const capturingAdapter: AgentAdapter = {
    runner: "opencode",
    async run(opts): Promise<AgentRunResult> {
      capturedPrompts.push(opts.prompt);
      return {
        ok: true,
        exitReason: "completed",
        costUsd: 0.01,
        tokensIn: 1,
        tokensOut: 1,
        summary: JSON.stringify({ verdict: "approve", reasons: ["lgtm"], confidence: 0.95 }),
      };
    },
  };
  const s = settings();

  // A real temp directory, not the default fake `/tmp/${id}` path — the
  // nudge is a real existsSync check against task.worktreePath, so it needs
  // an actual file on disk to prove out.
  const dirWithAgents = mkdtempSync(join(tmpdir(), "hoopedorc-agentsmd-orch-"));
  const dirWithout = mkdtempSync(join(tmpdir(), "hoopedorc-agentsmd-orch-"));
  writeFileSync(join(dirWithAgents, "AGENTS.md"), "# Project context\n");

  try {
    await new Orchestrator(
      fakeDeps({
        settings: s,
        adapterFor: () => capturingAdapter,
        worktrees: {
          async create(_p, t) {
            return { branch: `orc/${t.id}`, path: dirWithAgents };
          },
        },
      }, []),
    ).start(PROJECT, [task("t1")]);

    await new Orchestrator(
      fakeDeps({
        settings: s,
        adapterFor: () => capturingAdapter,
        worktrees: {
          async create(_p, t) {
            return { branch: `orc/${t.id}`, path: dirWithout };
          },
        },
      }, []),
    ).start(PROJECT, [task("t2")]);

    assert.equal(capturedPrompts.length, 2);
    const [withAgents, withoutAgents] = capturedPrompts;

    assert.match(withAgents!, /## Project context/);
    assert.match(withAgents!, /Read AGENTS\.md at the repo root before starting/);
    assert.doesNotMatch(withoutAgents!, /## Project context/);
  } finally {
    rmSync(dirWithAgents, { recursive: true, force: true });
    rmSync(dirWithout, { recursive: true, force: true });
  }
});

function docsSettings(): Settings {
  const s = settings();
  s.routing.byRole.updates = "deepseek-pro";
  return s;
}

test("F30: docs stage runs after validator approval and before merge; task still ends done", async () => {
  const merged: number[] = [];
  const runs: Run[] = [];
  const commits: { message: string }[] = [];
  const order: string[] = [];

  const deps = fakeDeps(
    {
      settings: docsSettings(),
      adapterFor: (m) =>
        m === "deepseek-pro"
          ? {
              runner: "opencode" as const,
              async run(): Promise<AgentRunResult> {
                order.push("docs-run");
                return { ok: true, exitReason: "completed", costUsd: 0.001, tokensIn: 1, tokensOut: 1, summary: "" };
              },
            }
          : approveAdapter,
      git: {
        async commitAll(_path, message) {
          commits.push({ message });
        },
        async mergePr(_p, n) {
          order.push(`merge:${n}`);
          merged.push(n);
        },
      },
      events: {
        onLog() {},
        onTaskUpdated() {},
        onRunUpdated: (r) => runs.push(r),
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

  assert.equal(t1.status, "done");
  assert.deepEqual(order, ["docs-run", "merge:1"], "the docs stage must run before the merge");

  const docsRuns = runs.filter((r) => r.id === "run-t1-docs");
  assert.equal(docsRuns.length, 2, "expected a running row then a terminal row for the docs stage");
  assert.equal(docsRuns[0]!.status, "running");
  assert.equal(docsRuns[0]!.endedAt, undefined);
  assert.equal(docsRuns[1]!.status, "passed");

  const docsCommits = commits.filter((c) => c.message.startsWith("docs: "));
  assert.equal(docsCommits.length, 1);
  assert.equal(docsCommits[0]!.message, "docs: t1");
});

test("F30: a documenter that throws doesn't block the merge", async () => {
  const merged: number[] = [];
  const logs: { level: string; message: string }[] = [];
  const commits: { message: string }[] = [];

  const deps = fakeDeps(
    {
      settings: docsSettings(),
      adapterFor: (m) =>
        m === "deepseek-pro"
          ? {
              runner: "opencode" as const,
              async run(): Promise<AgentRunResult> {
                throw new Error("boom");
              },
            }
          : approveAdapter,
      git: {
        async commitAll(_path, message) {
          commits.push({ message });
        },
      },
      events: {
        onLog(e) {
          logs.push({ level: e.level, message: e.message });
        },
        onTaskUpdated() {},
        onRunUpdated() {},
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

  assert.equal(t1.status, "done", "a docs-stage error must not fail the task");
  assert.equal(merged.length, 1);
  assert.ok(
    logs.some((l) => l.level === "warn" && /Documentation stage errored/.test(l.message)),
  );
  assert.ok(
    !commits.some((c) => c.message.startsWith("docs: ")),
    "no docs commit should have been made",
  );
});

test("F30: perTaskDocs: false skips the docs stage entirely", async () => {
  const merged: number[] = [];
  let docsRunCount = 0;
  const project = { ...PROJECT, config: { perTaskDocs: false } };

  const deps = fakeDeps(
    {
      settings: docsSettings(),
      adapterFor: (m) =>
        m === "deepseek-pro"
          ? {
              runner: "opencode" as const,
              async run(): Promise<AgentRunResult> {
                docsRunCount++;
                return { ok: true, exitReason: "completed", costUsd: 0, tokensIn: 0, tokensOut: 0, summary: "" };
              },
            }
          : approveAdapter,
    },
    merged,
  );

  const t1 = task("t1");
  await new Orchestrator(deps).start(project, [t1]);

  assert.equal(t1.status, "done");
  assert.equal(merged.length, 1);
  assert.equal(docsRunCount, 0, "the documenter model should never have been invoked");
});

test("F30: out-of-scope documenter edits are reverted before the docs commit", async () => {
  const merged: number[] = [];
  const logs: { level: string; message: string }[] = [];
  const commits: { message: string }[] = [];
  const revertCalls: string[][] = [];

  const deps = fakeDeps(
    {
      settings: docsSettings(),
      adapterFor: (m) =>
        m === "deepseek-pro"
          ? {
              runner: "opencode" as const,
              async run(): Promise<AgentRunResult> {
                return { ok: true, exitReason: "completed", costUsd: 0.001, tokensIn: 1, tokensOut: 1, summary: "" };
              },
            }
          : approveAdapter,
      worktrees: {
        async revertOutOfScope(_task, allowedPatterns) {
          revertCalls.push(allowedPatterns);
          return ["src/oops.ts"];
        },
      },
      git: {
        async commitAll(_path, message) {
          commits.push({ message });
        },
      },
      events: {
        onLog(e) {
          logs.push({ level: e.level, message: e.message });
        },
        onTaskUpdated() {},
        onRunUpdated() {},
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

  assert.equal(t1.status, "done");
  assert.deepEqual(revertCalls[0], ["CHANGELOG.md", "README.md", "AGENTS.md", "docs/**"]);
  assert.ok(
    logs.some(
      (l) => l.level === "warn" && /reverted: src\/oops\.ts/.test(l.message),
    ),
  );
  // The docs commit still lands afterward — the revert happens on disk
  // (mocked here), it doesn't cancel the commit itself.
  assert.ok(commits.some((c) => c.message === "docs: t1"));
});

interface ModelTroubleCall {
  taskId: string;
  taskTitle: string;
  model: string;
  event: "rate_limit_wait" | "fallback" | "exhausted";
  detail: string;
}

test("F32: a rate-limited author run waits and retries the SAME model, without consuming the attempt budget", async () => {
  const merged: number[] = [];
  const trouble: ModelTroubleCall[] = [];
  let authorCalls = 0;
  const modelsUsed: string[] = [];

  const deps = fakeDeps(
    {
      rateLimitWaitMs: 5,
      adapterFor: () => ({
        runner: "opencode" as const,
        async run(opts): Promise<AgentRunResult> {
          authorCalls++;
          modelsUsed.push(opts.model);
          if (authorCalls <= 2) {
            return { ok: false, exitReason: "rate_limited", costUsd: 0, tokensIn: 0, tokensOut: 0, summary: "" };
          }
          return { ok: true, exitReason: "completed", costUsd: 0.01, tokensIn: 1, tokensOut: 1, summary: "" };
        },
      }),
      events: {
        onLog() {},
        onTaskUpdated() {},
        onRunUpdated() {},
        onMergeDecision() {},
        onModelTrouble: (info) => trouble.push(info),
        async requestApproval() {
          return "reject";
        },
      },
    },
    merged,
  );

  const t1 = task("t1", [], { maxAttempts: 2 });
  await new Orchestrator(deps).start(PROJECT, [t1]);

  assert.equal(t1.status, "done");
  assert.equal(authorCalls, 3, "2 rate-limited attempts then a successful 3rd");
  assert.deepEqual(
    modelsUsed,
    ["deepseek-flash", "deepseek-flash", "deepseek-flash"],
    "must retry the SAME model, never switch",
  );
  // Started at attempts=1/maxAttempts=2 (headroom 1); each wait bumps both
  // in lockstep, so the headroom right after the final successful attempt
  // must still be exactly 1 — proof the waits didn't eat into the real
  // attempt budget.
  assert.equal(t1.maxAttempts - t1.attempts, 1);

  assert.equal(trouble.length, 1, "only the FIRST wait should notify, not every wait");
  assert.equal(trouble[0]!.event, "rate_limit_wait");
  assert.equal(trouble[0]!.model, "deepseek-flash");
  assert.equal(trouble[0]!.taskId, "t1");
});

test("F32: rate-limit retries exhausted falls back to the next model", async () => {
  const merged: number[] = [];
  const trouble: ModelTroubleCall[] = [];

  const deps = fakeDeps(
    {
      rateLimitWaitMs: 5,
      adapterFor: (m) =>
        m === "deepseek-flash"
          ? {
              runner: "opencode" as const,
              async run(): Promise<AgentRunResult> {
                return { ok: false, exitReason: "rate_limited", costUsd: 0, tokensIn: 0, tokensOut: 0, summary: "" };
              },
            }
          : approveAdapter,
      events: {
        onLog() {},
        onTaskUpdated() {},
        onRunUpdated() {},
        onMergeDecision() {},
        onModelTrouble: (info) => trouble.push(info),
        async requestApproval() {
          return "reject";
        },
      },
    },
    merged,
  );

  const t1 = task("t1");
  await new Orchestrator(deps).start(PROJECT, [t1]);

  assert.equal(t1.status, "done", "should complete on the fallback model (deepseek-pro)");
  assert.equal(merged.length, 1);

  const events = trouble.map((t) => t.event);
  assert.deepEqual(events, ["rate_limit_wait", "fallback"]);
  assert.equal(trouble[1]!.model, "deepseek-pro");
});

test("F32: a Stop during a rate-limit wait ends the task promptly with nothing merged", async () => {
  const merged: number[] = [];
  let authorCalls = 0;

  const deps = fakeDeps(
    {
      rateLimitWaitMs: 150,
      adapterFor: () => ({
        runner: "opencode" as const,
        async run(): Promise<AgentRunResult> {
          authorCalls++;
          return { ok: false, exitReason: "rate_limited", costUsd: 0, tokensIn: 0, tokensOut: 0, summary: "" };
        },
      }),
    },
    merged,
  );

  const t1 = task("t1");
  const orch = new Orchestrator(deps);
  const runPromise = orch.start(PROJECT, [t1]);
  await new Promise((r) => setTimeout(r, 30)); // let dispatch reach the wait
  const stopped = orch.stopTask(t1.id);
  assert.equal(stopped, true);
  await runPromise;

  assert.equal(t1.status, "blocked");
  assert.equal(merged.length, 0);
  assert.equal(authorCalls, 1, "must not have retried after the stop");
});

test("B28: a task whose assignedModel has no ModelConfig is requeued to backlog with a clear log line, not left stuck in ready", async () => {
  const logs: string[] = [];
  const deps = fakeDeps(
    {
      events: {
        onLog: (e) => logs.push(e.message),
        onTaskUpdated() {},
        onRunUpdated() {},
        onMergeDecision() {},
        async requestApproval() {
          return "reject";
        },
      },
    },
    [],
  );

  const t1 = task("t1", [], { assignedModel: "ghost-model", status: "ready" });
  await new Orchestrator(deps).start(PROJECT, [t1]);

  assert.equal(t1.status, "backlog");
  const matches = logs.filter((m) =>
    m.includes('Assigned model "ghost-model" no longer configured'),
  );
  assert.equal(matches.length, 1);
});

test("B28: the missing-model warning doesn't spam while another task keeps the loop polling", async () => {
  const logs: string[] = [];
  const taskUpdates: string[] = [];
  const slowAdapter: AgentAdapter = {
    runner: "opencode",
    async run(): Promise<AgentRunResult> {
      await new Promise((r) => setTimeout(r, 600));
      return {
        ok: true,
        exitReason: "completed",
        costUsd: 0.01,
        tokensIn: 1,
        tokensOut: 1,
        summary: JSON.stringify({ verdict: "approve", reasons: ["lgtm"], confidence: 0.95 }),
      };
    },
  };
  const deps = fakeDeps(
    {
      adapterFor: () => slowAdapter,
      events: {
        onLog: (e) => logs.push(e.message),
        onTaskUpdated: (t) => taskUpdates.push(t.id),
        onRunUpdated() {},
        onMergeDecision() {},
        async requestApproval() {
          return "reject";
        },
      },
    },
    [],
  );

  const ghost = task("ghost", [], { assignedModel: "ghost-model", status: "ready" });
  const slow = task("slow", [], { assignedModel: "deepseek-flash" });
  await new Orchestrator(deps).start(PROJECT, [ghost, slow]);

  assert.equal(ghost.status, "backlog");
  assert.equal(slow.status, "done");
  const matches = logs.filter((m) =>
    m.includes('Assigned model "ghost-model" no longer configured'),
  );
  assert.equal(matches.length, 1, "must log exactly once despite several polls");
  const ghostUpdates = taskUpdates.filter((id) => id === "ghost").length;
  assert.equal(ghostUpdates, 1, "must broadcast the backlog transition exactly once");
});

test("B28: a manual dispatch (runTask) against a since-removed assignedModel requeues to backlog instead of crashing to Fatal", async () => {
  const logs: string[] = [];
  const deps = fakeDeps(
    {
      events: {
        onLog: (e) => logs.push(e.message),
        onTaskUpdated() {},
        onRunUpdated() {},
        onMergeDecision() {},
        async requestApproval() {
          return "reject";
        },
      },
    },
    [],
  );

  const t1 = task("t1", [], { assignedModel: "ghost-model" });
  await new Orchestrator(deps).runTask(PROJECT, t1);

  assert.equal(t1.status, "backlog");
  assert.equal(
    logs.some((m) => m.includes('Assigned model "ghost-model" no longer configured')),
    true,
  );
  assert.equal(
    logs.some((m) => m.startsWith("Fatal:")),
    false,
    "must not surface as a Fatal crash",
  );
});

test("B30: a task in_review with a persisted 'approve' decision + a risky flag re-requests the merge approval without re-authoring or re-validating", async () => {
  const merged: number[] = [];
  let authorCalled = false;
  let validatorCalled = false;
  let asked = false;
  const decision: MergeDecision = {
    id: "d1",
    projectId: "p1",
    taskId: "t1",
    runId: "run-t1-1",
    validatorModel: "deepseek-pro",
    verdict: "approve",
    reasons: ["lgtm"],
    confidence: 0.95,
    gate: { ...GOOD_GATE, inScope: false },
    ts: "",
  };
  const adapter: AgentAdapter = {
    runner: "opencode",
    async run(): Promise<AgentRunResult> {
      authorCalled = true;
      return { ok: true, exitReason: "completed", costUsd: 0, tokensIn: 0, tokensOut: 0, summary: "" };
    },
  };
  const deps = fakeDeps(
    {
      adapterFor: () => adapter,
      validator: {
        async review() {
          validatorCalled = true;
          return decision;
        },
      },
      getMergeDecisions: () => [decision],
      events: {
        onLog() {}, onTaskUpdated() {}, onRunUpdated() {}, onMergeDecision() {},
        async requestApproval() {
          asked = true;
          return "approve_merge";
        },
      },
    },
    merged,
  );
  const t1 = task("t1", [], {
    status: "in_review",
    attempts: 1,
    prNumber: 7,
    worktreePath: "/tmp/t1",
    branch: "orc/t1",
  });
  await new Orchestrator(deps).start(PROJECT, [t1]);

  assert.equal(authorCalled, false, "must not re-run the author");
  assert.equal(validatorCalled, false, "must not re-run the validator — the verdict is already persisted");
  assert.equal(asked, true);
  assert.deepEqual(merged, [7]);
  assert.equal(t1.status, "done");
});

test("B30: a task in_review with a persisted 'escalate' decision re-requests that escalation, not a fresh author run", async () => {
  const merged: number[] = [];
  let authorCalled = false;
  let approvalTitle = "";
  const decision: MergeDecision = {
    id: "d1",
    projectId: "p1",
    taskId: "t1",
    runId: "run-t1-1",
    validatorModel: "deepseek-pro",
    verdict: "escalate",
    reasons: ["needs a human look"],
    confidence: 0.5,
    gate: GOOD_GATE,
    ts: "",
  };
  const adapter: AgentAdapter = {
    runner: "opencode",
    async run(): Promise<AgentRunResult> {
      authorCalled = true;
      return { ok: true, exitReason: "completed", costUsd: 0, tokensIn: 0, tokensOut: 0, summary: "" };
    },
  };
  const deps = fakeDeps(
    {
      adapterFor: () => adapter,
      getMergeDecisions: () => [decision],
      events: {
        onLog() {}, onTaskUpdated() {}, onRunUpdated() {}, onMergeDecision() {},
        async requestApproval(args) {
          approvalTitle = args.title;
          return "approve";
        },
      },
    },
    merged,
  );
  const t1 = task("t1", [], {
    status: "in_review",
    attempts: 1,
    prNumber: 7,
    worktreePath: "/tmp/t1",
    branch: "orc/t1",
  });
  await new Orchestrator(deps).start(PROJECT, [t1]);

  assert.equal(authorCalled, false);
  assert.match(approvalTitle, /escalated for human review/);
  assert.deepEqual(merged, [7]);
  assert.equal(t1.status, "done");
});

test("B30: a task in_review with no PR requeues to backlog exactly as before (nothing persisted to resume)", async () => {
  const logs: string[] = [];
  const deps = fakeDeps(
    {
      events: {
        onLog: (e) => logs.push(e.message),
        onTaskUpdated() {}, onRunUpdated() {}, onMergeDecision() {},
        async requestApproval() {
          return "reject";
        },
      },
    },
    [],
  );
  const t1 = task("t1", [], { status: "in_review" }); // no prNumber -> nothing to resume
  await new Orchestrator(deps).start(PROJECT, [t1]);

  assert.equal(
    logs.some((m) => m.startsWith("Recovering orphaned task")),
    true,
    "falls back to the pre-B30 orphan-requeue path",
  );
  assert.equal(
    logs.some((m) => m.startsWith("Restart recovery:")),
    false,
  );
  assert.equal(
    t1.status,
    "done",
    "requeued to backlog then ran the normal happy path to completion, same as before B30",
  );
});
