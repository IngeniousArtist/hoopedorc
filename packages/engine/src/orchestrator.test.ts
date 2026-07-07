import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentAdapter, AgentRunResult } from "@orc/adapters";
import type { GateResult, Project, Run, Settings, Task } from "@orc/types";
import { Orchestrator, isAuthOrSecretFile, scopesOverlap } from "./orchestrator.js";
import type { GitService, SchedulerDeps } from "./index.js";

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
  over: Partial<Omit<SchedulerDeps, "git">> & { git?: Partial<GitService> },
  merged: number[],
  changed: string[] = ["src/example.ts"],
): SchedulerDeps {
  const { git: gitOver, ...restOver } = over;
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
