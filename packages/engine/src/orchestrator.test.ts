import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentAdapter, AgentRunResult } from "@orc/adapters";
import type { GateResult, MergeDecision, Project, Run, Settings, Task } from "@orc/types";
import {
  Orchestrator,
  buildFallbackChain,
  detectDestructiveChanges,
  isAuthOrSecretFile,
  scopesOverlap,
} from "./orchestrator.js";
import type { GitService, SchedulerDeps, WorktreeManager } from "./index.js";

function acquired<T>(value: T) {
  return { ok: true, value, byteCount: 0, truncated: false };
}

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
      async prepareForGates() {},
      async changedFiles() { return changed; },
      async changedFilesInScope() { return true; },
      async revertOutOfScope() { return []; },
      // S8: defaults to plain modifications (never deletions), so
      // detectDestructiveChanges finds nothing and every pre-existing
      // merge-path test's behavior is unaffected by canAutoMerge now
      // always consulting these two.
      async changedFilesWithStatus() {
        return acquired(changed.map((f) => ({ path: f, status: "M" })));
      },
      async diffText() { return acquired(""); },
      async worktreeChanges() { return acquired([]); },
      async restoreToHead() { return acquired(undefined); },
      // B33: clean by default — most tests aren't exercising the
      // wrote-to-the-wrong-place diagnosis, so the primary clone reads as
      // undirtied unless a test overrides this.
      async primaryDirtyFiles() { return []; },
      ...worktreesOver,
    },
    git: {
      async ensureClone() {}, async commitAll() {}, async push() {},
      async openPr() { return 1; },
      async mergePr(_p, n) { merged.push(n); },
      async resolvePrMergeCommit() { return "0".repeat(40); },
      async prepareRollback() {
        return { sourceCommit: "0".repeat(40), sourceParentCount: 1 };
      },
      async openRollbackPr() { return 2; },
      async closeRollbackPr() {},
      async appendChangelogEntry() {},
      async syncBranchWithMain() { return "clean" as const; },
      async waitForChecks() { return "none" as const; },
      async cleanupTaskBranch() {},
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

test("a cooling-down model with NO dispatchable fallback is skipped instead of burning an attempt", async () => {
  const merged: number[] = [];
  const logs: { level: string; message: string }[] = [];
  let authorRuns = 0;
  const deps = fakeDeps(
    {
      // Block BOTH chain models (t1's fallback chain for medium/deepseek-flash
      // is [deepseek-flash, deepseek-pro] — see settings()) so B32's
      // dispatch-time fallback search has genuinely nowhere to go, exactly
      // like the plan's "every chain model cooldown-blocked" case. This
      // never clears on its own (unlike a real cooldown, which always
      // expires) — B32 correctly keeps the loop polling for as long as
      // that's true, so the test stops the run itself via pause() rather
      // than awaiting start() to completion, which would otherwise hang
      // forever waiting for a block that's never going to lift.
      checkModelCooldown: () => "cooling down for 3m",
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
  const orch = new Orchestrator(deps);
  const t1 = task("t1"); // default assignedModel: "deepseek-flash"
  const runPromise = orch.start(PROJECT, [t1]);

  // Let the loop settle into a few polls, proving it's genuinely holding
  // the task rather than having dispatched it, before stopping the run.
  await new Promise((r) => setTimeout(r, 300));
  await orch.pause(PROJECT);
  await runPromise;

  assert.equal(authorRuns, 0, "no model should run while its whole fallback chain is cooling down");
  assert.equal(merged.length, 0);
  assert.notEqual(t1.status, "done");
  assert.ok(
    logs.some((l) => l.level === "warn" && /Model cooling down/.test(l.message)),
    "should emit a cooldown warn log",
  );
});

test("B32: a cooldown-blocked assigned model dispatches on an available fallback instead of holding the task", async () => {
  const merged: number[] = [];
  const logs: { level: string; message: string }[] = [];
  const modelsUsed: string[] = [];
  const trouble: { model: string; event: string }[] = [];
  const deps = fakeDeps(
    {
      // Only deepseek-flash (t1's assigned model) is cooling down —
      // deepseek-pro (the next model in its fallback chain) is free.
      checkModelCooldown: (m) => (m === "deepseek-flash" ? "cooling down for 3m" : null),
      adapterFor: (m) => ({
        runner: "opencode",
        async run() {
          modelsUsed.push(m);
          return {
            ok: true, exitReason: "completed", costUsd: 0.01, tokensIn: 1, tokensOut: 1,
            summary: JSON.stringify({ verdict: "approve", reasons: ["lgtm"], confidence: 0.95 }),
          };
        },
      }),
      // deepseek-pro is BOTH the fallback candidate AND the medium-tier
      // validator by default (see settings()) — route validation to a
      // model the fallback won't collide with, so this test proves the
      // dispatch-time fallback itself, not an unrelated self-review escalation.
      settings: {
        ...settings(),
        routing: {
          ...settings().routing,
          validatorByDifficulty: { easy: "deepseek-flash", medium: "deepseek-flash", hard: "deepseek-flash" },
        },
      },
      events: {
        onLog(e) { logs.push({ level: e.level, message: e.message }); },
        onTaskUpdated() {}, onRunUpdated() {}, onMergeDecision() {},
        async requestApproval() { return "reject"; },
        onModelTrouble(info) { trouble.push({ model: info.model, event: info.event }); },
      },
    },
    merged,
  );
  const t1 = task("t1"); // default assignedModel: "deepseek-flash", difficulty medium
  await new Orchestrator(deps).start(PROJECT, [t1]);
  assert.deepEqual(modelsUsed, ["deepseek-pro"], "should dispatch straight onto the fallback, never the blocked model");
  assert.equal(t1.status, "done", "the task should complete normally on the fallback model");
  assert.equal(merged.length, 1);
  assert.ok(
    logs.some((l) => l.level === "warn" && /blocked .*dispatching on fallback deepseek-pro/.test(l.message)),
    "should log the dispatch-time fallback switch",
  );
  assert.ok(
    trouble.some((t) => t.model === "deepseek-pro" && t.event === "fallback"),
    "should fire onModelTrouble('fallback') for the dispatch-time switch",
  );
});

test("B32: every fallback-chain model blocked keeps the run alive (polling) instead of ending it, then dispatches once one clears", async () => {
  const merged: number[] = [];
  let blocked = true;
  const troubleEvents: { model: string; event: string }[] = [];
  const deps = fakeDeps(
    {
      // Both chain models (deepseek-flash, deepseek-pro) are quota-blocked
      // until `blocked` flips false mid-run, simulating a window rolling over.
      checkModelQuota: () => (blocked ? "quota reached: 5/5 runs in the last 1h" : null),
      events: {
        onLog() {}, onTaskUpdated() {}, onRunUpdated() {}, onMergeDecision() {},
        async requestApproval() { return "reject"; },
        onModelTrouble(info) { troubleEvents.push({ model: info.model, event: info.event }); },
      },
    },
    merged,
  );
  const t1 = task("t1");
  const runPromise = new Orchestrator(deps).start(PROJECT, [t1]);

  // Give the loop several 250ms polls to prove it's genuinely waiting, not
  // having already exited.
  await new Promise((r) => setTimeout(r, 600));
  assert.notEqual(t1.status, "done", "must still be waiting, not finished or given up");

  blocked = false; // the quota window "rolls over"
  await runPromise;

  assert.equal(t1.status, "done", "should dispatch and complete once the block clears");
  assert.equal(merged.length, 1);
  assert.equal(
    troubleEvents.filter((t) => t.event === "quota_wait").length,
    1,
    "should fire exactly one quota_wait notification for the whole stall, not once per poll",
  );
});

test("B32: pause() exits promptly even while every model is quota/cooldown-blocked (waiting, not winding down)", async () => {
  const merged: number[] = [];
  const deps = fakeDeps(
    {
      checkModelQuota: () => "quota reached: 5/5 runs in the last 1h",
      events: {
        onLog() {}, onTaskUpdated() {}, onRunUpdated() {}, onMergeDecision() {},
        async requestApproval() { return "reject"; },
      },
    },
    merged,
  );
  const orch = new Orchestrator(deps);
  const t1 = task("t1");
  const runPromise = orch.start(PROJECT, [t1]);

  // Let the loop settle into a few 250ms waiting-polls before pausing.
  await new Promise((r) => setTimeout(r, 300));
  const pauseStarted = Date.now();
  await orch.pause(PROJECT);
  await runPromise;

  assert.ok(
    Date.now() - pauseStarted < 1000,
    "pause should resolve quickly, not wait out the whole quota window",
  );
  assert.notEqual(t1.status, "done");
  assert.equal(merged.length, 0);
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
  let authorCalls = 0;
  let gateDirtPresent = false;
  const deps = fakeDeps(
    {
      adapterFor: () => ({
        runner: "opencode",
        async run() {
          authorCalls++;
          if (authorCalls === 2) {
            assert.equal(
              gateDirtPresent,
              false,
              "the failed gate's files must be gone before retry authoring",
            );
          }
          return {
            ok: true,
            exitReason: "completed",
            costUsd: 0,
            tokensIn: 0,
            tokensOut: 0,
            summary: JSON.stringify({ verdict: "approve", reasons: ["ok"], confidence: 1 }),
          };
        },
      }),
      gates: {
        async run() {
          gateCalls++;
          if (gateCalls === 1) gateDirtPresent = true;
          // Fail the first attempt's gate, pass the second's.
          return gateCalls === 1
            ? { ...GOOD_GATE, typecheck: false, details: { typecheck: "boom" } }
            : GOOD_GATE;
        },
      },
      worktrees: {
        async restoreToHead() {
          gateDirtPresent = false;
          return acquired(undefined);
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
  const deps = fakeDeps(
    {
      git: {
        async waitForChecks(_project, _pr, _timeout, _onPoll, signal) {
          resolveWaitStarted();
          assert.ok(signal, "task signal must reach the GitHub checks poll");
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          throw new DOMException("The operation was aborted", "AbortError");
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
  await runPromise;
  assert.equal(t1.status, "blocked");
  assert.equal(merged.length, 0, "must not merge after a stop, even if checks ultimately passed");
});

test("F16: a model whose ENTIRE fallback chain is at quota is skipped at dispatch (warned once, not once per poll)", async () => {
  const merged: number[] = [];
  const logs: { level: string; message: string }[] = [];
  const deps = fakeDeps(
    {
      // B32: block quota for BOTH of quotaTask's fallback-chain models
      // (deepseek-pro + deepseek-flash — see settings()'s 2-model chain) so
      // the dispatch-time fallback search genuinely has nowhere to go. A
      // third, unrelated model (glm) stays free so the run has other work
      // to keep the loop alive across several polls while quotaTask's whole
      // chain stays exhausted.
      settings: {
        ...settings(),
        models: [
          ...settings().models,
          { id: "glm", displayName: "g", runner: "opencode", opencodeModel: "z", roles: ["medium"], enabled: true, maxConcurrent: 2 },
        ],
      },
      checkModelQuota: (m) =>
        m === "deepseek-pro" || m === "deepseek-flash"
          ? `Model ${m} quota reached: 5/5 runs in the last 24h`
          : null,
      // A slow-but-unblocked task on a different (never-quota-checked) model
      // keeps the dispatch loop alive across several 250ms polls, so the
      // quota-blocked task (on a non-overlapping scope, so it isn't held
      // back for THAT reason instead) gets re-evaluated more than once —
      // proving the warn is deduped, not just incidentally logged once.
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
    assignedModel: "glm",
    scopePaths: ["src/a/**"],
  });
  const quotaTask = task("quota-blocked", [], {
    assignedModel: "deepseek-pro",
    scopePaths: ["src/b/**"],
  });
  const orch = new Orchestrator(deps);
  const runPromise = orch.start(PROJECT, [slowTask, quotaTask]);

  // slowTask's author run takes 600ms; give it time to finish and merge.
  // quotaTask's block never clears in this test (unlike a real quota
  // window, which always rolls over) — B32 correctly keeps the loop
  // polling for as long as that's true, so once slowTask is done the test
  // stops the run itself via pause() rather than awaiting start() to
  // completion, which would otherwise hang forever.
  await new Promise((r) => setTimeout(r, 900));
  await orch.pause(PROJECT);
  await runPromise;

  assert.equal(slowTask.status, "done");
  assert.notEqual(
    quotaTask.status,
    "done",
    "the quota-blocked task's whole fallback chain is blocked, so it should never dispatch",
  );
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
    scopesOverlap([], ["src/**"]),
    true,
    "an empty scope is unrestricted and must overlap every scoped task",
  );
  assert.equal(scopesOverlap([], []), true, "two unrestricted tasks overlap");
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

test("two independent tasks with empty scopes run serially, not concurrently", async () => {
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
  const t1 = task("t1", [], { scopePaths: [] });
  const t2 = task("t2", [], { scopePaths: [] });
  await new Orchestrator(deps).start(PROJECT, [t1, t2]);

  assert.equal(t1.status, "done");
  assert.equal(t2.status, "done");
  assert.equal(
    maxConcurrentAuthors,
    1,
    "two unrestricted tasks must never author concurrently",
  );
});

test("manual-only scheduling runs requested work and leaves ordinary ready tasks untouched", async () => {
  const merged: number[] = [];
  const requested = task("requested", [], {
    scopePaths: ["src/requested/**"],
    dispatchRequestedAt: "2026-07-14T00:00:00.000Z",
  });
  const ordinary = task("ordinary", [], { scopePaths: ["src/ordinary/**"] });

  await new Orchestrator(fakeDeps({}, merged)).start(
    PROJECT,
    [requested, ordinary],
    { shouldDispatch: (candidate) => candidate.dispatchRequestedAt !== undefined },
  );

  assert.equal(requested.status, "done");
  assert.equal(requested.dispatchRequestedAt, undefined);
  assert.equal(ordinary.status, "ready");
  assert.equal(merged.length, 1);
});

test("manual-only queued tasks share normal scope serialization and disjoint concurrency", async () => {
  const merged: number[] = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  let concurrentA = 0;
  let maxConcurrentA = 0;
  let firstWaveStarted = 0;
  let resolveFirstWaveStarted!: () => void;
  const firstWaveStartedPromise = new Promise<void>((resolve) => {
    resolveFirstWaveStarted = resolve;
  });
  let releaseFirstWave!: () => void;
  const firstWaveRelease = new Promise<void>((resolve) => {
    releaseFirstWave = resolve;
  });
  const deps = fakeDeps(
    {
      adapterFor: () => ({
        runner: "opencode",
        async run(opts): Promise<AgentRunResult> {
          const id = opts.cwd.split("/").at(-1);
          const isA = opts.cwd.endsWith("a1") || opts.cwd.endsWith("a2");
          concurrent++;
          if (isA) concurrentA++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          maxConcurrentA = Math.max(maxConcurrentA, concurrentA);
          if (id === "a1" || id === "b") {
            firstWaveStarted++;
            if (firstWaveStarted === 2) resolveFirstWaveStarted();
            await firstWaveRelease;
          }
          concurrent--;
          if (isA) concurrentA--;
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
  const requestedAt = "2026-07-14T00:00:00.000Z";
  const a1 = task("a1", [], { scopePaths: ["src/a/**"], dispatchRequestedAt: requestedAt });
  const a2 = task("a2", [], { scopePaths: ["src/a/**"], dispatchRequestedAt: requestedAt });
  const b = task("b", [], { scopePaths: ["src/b/**"], dispatchRequestedAt: requestedAt });

  const run = new Orchestrator(deps).start(PROJECT, [a1, a2, b], {
    shouldDispatch: (candidate) => candidate.dispatchRequestedAt !== undefined,
  });
  await firstWaveStartedPromise;
  assert.equal(concurrent, 2, "the disjoint first wave starts together");
  assert.equal(concurrentA, 1, "the overlapping request is still held");
  releaseFirstWave();
  await run;

  assert.equal(maxConcurrent, 2, "disjoint manual requests may run together");
  assert.equal(maxConcurrentA, 1, "overlapping manual requests must serialize");
  assert.equal(merged.length, 3);
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
  event: "rate_limit_wait" | "fallback" | "exhausted" | "quota_wait";
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

test("F41: holdWhileAwaitingApproval blocks new dispatch while a decision is pending, resumes once it clears", async () => {
  const merged: number[] = [];
  const logs: { level: string; message: string }[] = [];
  let authorRuns = 0;
  // Pending from the very first pass -- both t1 and t2 are ready with no
  // dependency between them, so neither should dispatch until this clears.
  let pending: { title: string } | undefined = { title: "Risky changes in some other task" };
  const deps = fakeDeps(
    {
      settings: { ...settings(), holdWhileAwaitingApproval: true },
      getPendingApproval: () => pending,
      adapterFor: () => ({
        runner: "opencode",
        async run(): Promise<AgentRunResult> {
          authorRuns++;
          return { ok: true, exitReason: "completed", costUsd: 0.01, tokensIn: 1, tokensOut: 1, summary: "" };
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
  const t1 = task("t1");
  const t2 = task("t2");

  // Let the 250ms poll loop run through several held passes before clearing.
  setTimeout(() => {
    pending = undefined;
  }, 600);

  await new Orchestrator(deps).start(PROJECT, [t1, t2]);

  assert.equal(authorRuns, 2, "both tasks ran, but only after the pending approval cleared");
  assert.equal(merged.length, 2);
  assert.equal(t1.status, "done");
  assert.equal(t2.status, "done");
  const holdWarnings = logs.filter(
    (l) => l.level === "warn" && /Holding new dispatch/.test(l.message),
  );
  assert.equal(holdWarnings.length, 1, "should warn exactly once across all the held polls, not once per poll");
});

test("F41: holdWhileAwaitingApproval off (default) leaves dispatch behavior unaffected by a pending approval", async () => {
  const merged: number[] = [];
  const deps = fakeDeps(
    {
      // holdWhileAwaitingApproval unset -- getPendingApproval must never
      // even be consulted, let alone hold anything back.
      getPendingApproval: () => ({ title: "should be ignored entirely" }),
    },
    merged,
  );
  const t1 = task("t1");
  const t2 = task("t2");
  await new Orchestrator(deps).start(PROJECT, [t1, t2]);

  assert.equal(t1.status, "done");
  assert.equal(t2.status, "done");
  assert.equal(merged.length, 2);
});

// ── Docs-runs-last + explicit fallbacks + failed-branch cleanup ──

test("readyTasks: a docs task waits for terminal deps and runs once at least one is done", () => {
  const orch = new Orchestrator(fakeDeps({}, []));
  const scaffold = task("t1", [], { status: "done" });
  const feature = task("t2", [], { status: "failed" });
  const docs = task("docs", ["t1", "t2"], { status: "backlog", role: "docs" });

  // One dep failed, one done — a docs task still runs (documents what got
  // built); a normal task with the same deps stays blocked.
  const normal = task("t3", ["t1", "t2"], { status: "backlog" });
  const ready = orch.readyTasks([scaffold, feature, docs, normal]);
  assert.deepEqual(ready.map((t) => t.id), ["docs"]);
});

test("readyTasks: a docs task stays blocked while a dep is still running, or when every dep failed", () => {
  const orch = new Orchestrator(fakeDeps({}, []));
  const running = task("t1", [], { status: "in_progress" });
  const docs = task("docs", ["t1"], { status: "backlog", role: "docs" });
  assert.equal(orch.readyTasks([running, docs]).length, 0);

  const failed = task("t1", [], { status: "failed" });
  assert.equal(
    orch.readyTasks([failed, docs]).length,
    0,
    "nothing landed — there is nothing for a docs task to document",
  );
});

test("buildFallbackChain: explicit routing.fallbacks wins over difficulty tiers, in order, deduped", () => {
  const routing = {
    ...settings().routing,
    fallbacks: ["deepseek-pro", "deepseek-flash"],
  };
  assert.deepEqual(
    buildFallbackChain("glm", "medium", routing),
    ["glm", "deepseek-pro", "deepseek-flash"],
  );
  // The assigned model never repeats in its own chain.
  assert.deepEqual(
    buildFallbackChain("deepseek-pro", "medium", routing),
    ["deepseek-pro", "deepseek-flash"],
  );
  // Unset/empty falls back to the legacy tier escalation.
  assert.deepEqual(
    buildFallbackChain("deepseek-flash", "medium", settings().routing),
    ["deepseek-flash", "deepseek-pro"],
  );
});

test("detectDestructiveChanges: a clean diff (plain modifications) has no reasons", () => {
  const files = [
    { path: "src/foo.ts", status: "M" },
    { path: "src/bar.ts", status: "A" },
  ];
  const diff = "+const x = 1;\n-const y = 2;\n";
  assert.deepEqual(detectDestructiveChanges(files, diff), []);
});

test("detectDestructiveChanges: more than 10 deletions trips mass-deletion", () => {
  const files = Array.from({ length: 11 }, (_, i) => ({ path: `src/f${i}.ts`, status: "D" }));
  const reasons = detectDestructiveChanges(files, "");
  assert.ok(reasons.some((r) => /mass deletion/.test(r)));
});

test("detectDestructiveChanges: deletions over half of >3 changed files trips, under half does not", () => {
  const riskyFiles = [
    { path: "a.ts", status: "D" },
    { path: "b.ts", status: "D" },
    { path: "c.ts", status: "D" },
    { path: "d.ts", status: "M" },
  ];
  assert.ok(
    detectDestructiveChanges(riskyFiles, "").some((r) => /more than half/.test(r)),
  );

  const safeFiles = [
    { path: "a.ts", status: "D" },
    { path: "b.ts", status: "M" },
    { path: "c.ts", status: "M" },
    { path: "d.ts", status: "M" },
    { path: "e.ts", status: "A" },
  ];
  assert.deepEqual(detectDestructiveChanges(safeFiles, ""), []);
});

test("detectDestructiveChanges: every changed file under a top-level directory deleted trips; a partial wipe does not", () => {
  const wiped = [
    { path: "src/a.ts", status: "D" },
    { path: "src/b.ts", status: "D" },
  ];
  assert.ok(
    detectDestructiveChanges(wiped, "").some((r) => /every changed file under "src\/" was deleted/.test(r)),
  );

  const partial = [
    { path: "src/a.ts", status: "D" },
    { path: "src/b.ts", status: "M" },
  ];
  assert.deepEqual(detectDestructiveChanges(partial, ""), []);
});

test("detectDestructiveChanges: deleting a migration/schema file trips; modifying one does not", () => {
  const deletedMigration = [{ path: "migrations/001_init.sql", status: "D" }];
  assert.ok(
    detectDestructiveChanges(deletedMigration, "").some((r) => /migration\/schema/.test(r)),
  );
  const deletedSchema = [{ path: "prisma/schema.prisma", status: "D" }];
  assert.ok(
    detectDestructiveChanges(deletedSchema, "").some((r) => /migration\/schema/.test(r)),
  );

  const modifiedMigration = [{ path: "migrations/001_init.sql", status: "M" }];
  assert.deepEqual(detectDestructiveChanges(modifiedMigration, ""), []);
});

test("detectDestructiveChanges: deleting .env/CI workflow/lockfile trips; modifying does not", () => {
  const deletedEnv = [{ path: ".env.production", status: "D" }];
  assert.ok(detectDestructiveChanges(deletedEnv, "").some((r) => /sensitive file/.test(r)));

  const deletedCi = [{ path: ".github/workflows/ci.yml", status: "D" }];
  assert.ok(detectDestructiveChanges(deletedCi, "").some((r) => /sensitive file/.test(r)));

  const deletedLock = [{ path: "package-lock.json", status: "D" }];
  assert.ok(detectDestructiveChanges(deletedLock, "").some((r) => /sensitive file/.test(r)));

  const modifiedEnv = [{ path: ".env.production", status: "M" }];
  assert.deepEqual(detectDestructiveChanges(modifiedEnv, ""), []);
});

test("detectDestructiveChanges: added destructive SQL trips; removed destructive SQL does not", () => {
  const dropTable = detectDestructiveChanges([], "+DROP TABLE users;\n");
  assert.ok(dropTable.some((r) => /destructive SQL/.test(r)));

  const dropDb = detectDestructiveChanges([], "+  DROP DATABASE prod;\n");
  assert.ok(dropDb.some((r) => /destructive SQL/.test(r)));

  const truncate = detectDestructiveChanges([], "+TRUNCATE accounts;\n");
  assert.ok(truncate.some((r) => /destructive SQL/.test(r)));

  // A line being REMOVED (a leading '-') is the opposite of risky.
  const removed = detectDestructiveChanges([], "-DROP TABLE users;\n");
  assert.deepEqual(removed, []);
});

test("detectDestructiveChanges: DELETE FROM with no WHERE trips; the same query WITH a WHERE does not", () => {
  const noWhere = detectDestructiveChanges([], "+DELETE FROM users;\n");
  assert.ok(noWhere.some((r) => /DELETE with no WHERE/.test(r)));

  // Exact near-miss from the plan's own acceptance criteria.
  const withWhere = detectDestructiveChanges([], "+DELETE FROM x WHERE id = ?\n");
  assert.deepEqual(withWhere, []);
});

test("detectDestructiveChanges: empty-filter deleteMany() trips; a filtered one does not", () => {
  const empty = detectDestructiveChanges([], "+await db.user.deleteMany();\n");
  assert.ok(empty.some((r) => /empty-filter deleteMany/.test(r)));

  const filtered = detectDestructiveChanges([], "+await db.user.deleteMany({ where: { id } });\n");
  assert.deepEqual(filtered, []);
});

test("detectDestructiveChanges: rm -rf on a non-local/non-tmp path trips; a local relative path does not", () => {
  const home = detectDestructiveChanges([], "+rm -rf /home/user/important\n");
  assert.ok(home.some((r) => /rm -rf/.test(r)));

  const tilde = detectDestructiveChanges([], "+rm -rf ~/data\n");
  assert.ok(tilde.some((r) => /rm -rf/.test(r)));

  const traversal = detectDestructiveChanges([], "+rm -rf ../../../etc\n");
  assert.ok(traversal.some((r) => /rm -rf/.test(r)));

  // Ordinary build-script cleanup — a bare relative path — is normal, not risky.
  const localDist = detectDestructiveChanges([], "+rm -rf dist\n");
  assert.deepEqual(localDist, []);
  const localRelative = detectDestructiveChanges([], "+rm -rf ./node_modules\n");
  assert.deepEqual(localRelative, []);
  const tmp = detectDestructiveChanges([], "+rm -rf /tmp/build-cache\n");
  assert.deepEqual(tmp, []);
});

test("detectDestructiveChanges: split-flag and long-form rm variants trip; recursive-only does not", () => {
  // `rm -r -f` and `rm --recursive --force` are the same command as `rm -rf`
  // — the detector must not be evadable by how the flags are spelled.
  const split = detectDestructiveChanges([], "+rm -r -f /home/user/data\n");
  assert.ok(split.some((r) => /rm -rf/.test(r)));

  const longForm = detectDestructiveChanges([], "+rm --recursive --force /home/user/data\n");
  assert.ok(longForm.some((r) => /rm -rf/.test(r)));

  const mixed = detectDestructiveChanges([], "+rm -r --force /home/user/data\n");
  assert.ok(mixed.some((r) => /rm -rf/.test(r)));

  // Recursive without force (or force without recursive) is not the
  // rm -rf pattern — near-miss negatives.
  const recursiveOnly = detectDestructiveChanges([], "+rm -r /home/user/data\n");
  assert.deepEqual(recursiveOnly, []);
  const forceOnly = detectDestructiveChanges([], "+rm -f /home/user/data\n");
  assert.deepEqual(forceOnly, []);
  // Long-form flags on a repo-local path stay clean, same as -rf on one.
  const localLong = detectDestructiveChanges([], "+rm --recursive --force dist\n");
  assert.deepEqual(localLong, []);
});

test("S8: canAutoMerge holds a destructive change for approval even under fully_autonomous; a clean diff still auto-merges", async () => {
  const merged: number[] = [];
  let asked = false;
  const deps = fakeDeps(
    {
      settings: { ...settings(), mergePolicy: "fully_autonomous" },
      worktrees: {
        async changedFilesWithStatus() {
          return acquired([{ path: "migrations/001_init.sql", status: "D" }]);
        },
        async diffText() {
          return acquired("+DROP TABLE users;\n");
        },
      },
      events: {
        onLog() {}, onTaskUpdated() {}, onRunUpdated() {}, onMergeDecision() {},
        async requestApproval(args) {
          asked = true;
          assert.match(args.message, /Destructive change detected/);
          assert.match(args.message, /migration\/schema/);
          return "reject";
        },
      },
    },
    merged,
  );
  const t1 = task("t1");
  await new Orchestrator(deps).start(PROJECT, [t1]);
  assert.equal(asked, true, "fully_autonomous must NOT skip the destructive-change check");
  assert.equal(merged.length, 0);
  assert.equal(t1.status, "failed");
  assert.ok(t1.statusReason && /destructive change/.test(t1.statusReason));
});

test("S8: canAutoMerge auto-merges a clean change under fully_autonomous exactly as before", async () => {
  const merged: number[] = [];
  const deps = fakeDeps(
    { settings: { ...settings(), mergePolicy: "fully_autonomous" } },
    merged,
  );
  const t1 = task("t1");
  await new Orchestrator(deps).start(PROJECT, [t1]);
  assert.equal(t1.status, "done");
  assert.equal(merged.length, 1);
});

test("S9: incomplete diff inspection requires approval under fully_autonomous", async () => {
  const merged: number[] = [];
  let asked = false;
  const deps = fakeDeps(
    {
      settings: { ...settings(), mergePolicy: "fully_autonomous" },
      worktrees: {
        async diffText() {
          return {
            ok: false,
            value: "+clean prefix\n",
            error: "diff output exceeded safety limit",
            byteCount: 16 * 1024 * 1024,
            truncated: true,
          };
        },
      },
      events: {
        onLog() {}, onTaskUpdated() {}, onRunUpdated() {}, onMergeDecision() {},
        async requestApproval(args) {
          asked = true;
          assert.match(args.message, /Safety inspection could not complete/);
          assert.match(args.message, /could not be fully scanned/);
          return "reject";
        },
      },
    },
    merged,
  );
  const t1 = task("t1");
  await new Orchestrator(deps).start(PROJECT, [t1]);
  assert.equal(asked, true);
  assert.equal(merged.length, 0);
  assert.match(t1.statusReason ?? "", /Safety inspection was incomplete/);
});

test("S9: git acquisition errors require approval instead of reading as clean", async () => {
  const merged: number[] = [];
  let approvalMessage = "";
  const deps = fakeDeps(
    {
      settings: { ...settings(), mergePolicy: "fully_autonomous" },
      worktrees: {
        async changedFilesWithStatus() {
          return {
            ok: false,
            value: [],
            error: "fatal: not a git repository",
            byteCount: 0,
            truncated: false,
          };
        },
      },
      events: {
        onLog() {}, onTaskUpdated() {}, onRunUpdated() {}, onMergeDecision() {},
        async requestApproval(args) {
          approvalMessage = args.message;
          return "reject";
        },
      },
    },
    merged,
  );
  await new Orchestrator(deps).start(PROJECT, [task("t1")]);
  assert.match(approvalMessage, /Could not inspect changed-file statuses/);
  assert.equal(merged.length, 0);
});

test("S8: riskyChangeRules.destructiveChanges: false restores today's fully_autonomous behavior for a destructive diff", async () => {
  const merged: number[] = [];
  const deps = fakeDeps(
    {
      settings: {
        ...settings(),
        mergePolicy: "fully_autonomous",
        riskyChangeRules: { ...settings().riskyChangeRules, destructiveChanges: false },
      },
      worktrees: {
        async changedFilesWithStatus() {
          return acquired([{ path: "migrations/001_init.sql", status: "D" }]);
        },
        async diffText() {
          return acquired("+DROP TABLE users;\n");
        },
      },
    },
    merged,
  );
  const t1 = task("t1");
  await new Orchestrator(deps).start(PROJECT, [t1]);
  assert.equal(t1.status, "done", "disabling the rule restores the pre-S8 auto-merge behavior");
  assert.equal(merged.length, 1);
});

test("S8: the author prompt includes the fixed safety guardrails block", async () => {
  const capturedPrompts: string[] = [];
  const capturingAdapter: AgentAdapter = {
    runner: "opencode",
    async run(opts): Promise<AgentRunResult> {
      capturedPrompts.push(opts.prompt);
      return {
        ok: true, exitReason: "completed", costUsd: 0.01, tokensIn: 1, tokensOut: 1,
        summary: JSON.stringify({ verdict: "approve", reasons: ["lgtm"], confidence: 0.95 }),
      };
    },
  };
  const t1 = task("t1");
  await new Orchestrator(fakeDeps({ adapterFor: () => capturingAdapter }, [])).start(PROJECT, [t1]);
  assert.equal(capturedPrompts.length, 1);
  assert.match(capturedPrompts[0]!, /## Safety/);
  assert.match(capturedPrompts[0]!, /Never delete files or directories unrelated to this task/);
  assert.match(capturedPrompts[0]!, /Never touch credentials, secrets, or auth\/authorization checks/);
});

test("B33: the author prompt includes the working-directory block", async () => {
  const capturedPrompts: string[] = [];
  const capturingAdapter: AgentAdapter = {
    runner: "opencode",
    async run(opts): Promise<AgentRunResult> {
      capturedPrompts.push(opts.prompt);
      return {
        ok: true, exitReason: "completed", costUsd: 0.01, tokensIn: 1, tokensOut: 1,
        summary: JSON.stringify({ verdict: "approve", reasons: ["lgtm"], confidence: 0.95 }),
      };
    },
  };
  const t1 = task("t1");
  await new Orchestrator(fakeDeps({ adapterFor: () => capturingAdapter }, [])).start(PROJECT, [t1]);
  assert.equal(capturedPrompts.length, 1);
  assert.match(capturedPrompts[0]!, /## Working Directory/);
  assert.match(capturedPrompts[0]!, /dedicated git worktree/);
  assert.match(capturedPrompts[0]!, /run `git status`/);
});

test("B33: no-changes diagnosis names the primary clone + offending files when the agent wrote there", async () => {
  const logs: { level: string; message: string }[] = [];
  const deps = fakeDeps(
    {
      worktrees: {
        async primaryDirtyFiles() { return ["src/oops.ts"]; },
      },
      events: {
        onLog(e) { logs.push({ level: e.level, message: e.message }); },
        onTaskUpdated() {}, onRunUpdated() {}, onMergeDecision() {},
        async requestApproval() { return "reject"; },
      },
    },
    [],
    [], // changedFiles() returns [] — no changes in the task's own worktree.
  );
  const t1 = task("t1", [], { maxAttempts: 1 });
  await new Orchestrator(deps).start(PROJECT, [t1]);

  assert.ok(
    logs.some(
      (l) =>
        l.level === "error" &&
        /appears to have written into the primary clone/.test(l.message) &&
        /src\/oops\.ts/.test(l.message),
    ),
    "should name the primary clone and the offending file",
  );
  assert.equal(t1.status, "failed");
  assert.ok(
    t1.statusReason && /wrote to the primary clone/.test(t1.statusReason),
    `got: ${t1.statusReason}`,
  );
});

test("B33: no-changes diagnosis keeps today's generic message when the primary clone is clean", async () => {
  const logs: { level: string; message: string }[] = [];
  const deps = fakeDeps(
    {
      // primaryDirtyFiles defaults to [] (clean) via fakeDeps' own default.
      events: {
        onLog(e) { logs.push({ level: e.level, message: e.message }); },
        onTaskUpdated() {}, onRunUpdated() {}, onMergeDecision() {},
        async requestApproval() { return "reject"; },
      },
    },
    [],
    [], // changedFiles() returns [] — no changes in the task's own worktree.
  );
  const t1 = task("t1", [], { maxAttempts: 1 });
  await new Orchestrator(deps).start(PROJECT, [t1]);

  assert.ok(
    logs.some(
      (l) =>
        l.level === "error" &&
        /Nothing to commit\/PR — check that the agent wrote into the worktree/.test(l.message),
    ),
  );
  assert.equal(t1.status, "failed");
  assert.ok(
    t1.statusReason && /models ran out of steps or wrote outside the worktree/.test(t1.statusReason),
    `got: ${t1.statusReason}`,
  );
});

test("a terminally-failed task gets its remote branch/PR cleaned up; a merged one does not (gh already did it)", async () => {
  const cleaned: string[] = [];
  const merged: number[] = [];
  const rejectGate: GateResult = {
    ...GOOD_GATE, tests: false, details: { tests: "1 failing" },
  };
  const deps = fakeDeps(
    {
      gates: { async run() { return rejectGate; } },
      git: { async cleanupTaskBranch(_p, t) { cleaned.push(t.id); } },
    },
    merged,
  );
  const bad = task("t1", [], { maxAttempts: 1 });
  await new Orchestrator(deps).start(PROJECT, [bad]);
  assert.equal(bad.status, "failed");
  assert.ok(bad.statusReason && /Gates kept failing/.test(bad.statusReason), `got: ${bad.statusReason}`);
  assert.deepEqual(cleaned, ["t1"], "failed task's branch/PR cleaned up");

  const cleaned2: string[] = [];
  const deps2 = fakeDeps(
    { git: { async cleanupTaskBranch(_p, t) { cleaned2.push(t.id); } } },
    merged,
  );
  const good = task("t2");
  await new Orchestrator(deps2).start(PROJECT, [good]);
  assert.equal(good.status, "done");
  assert.ok(good.statusReason && /Merged PR #/.test(good.statusReason), `got: ${good.statusReason}`);
  assert.deepEqual(cleaned2, [], "merged task's branch is gh pr merge --delete-branch's job");
});
