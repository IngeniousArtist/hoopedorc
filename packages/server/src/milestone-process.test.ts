import { EngineRunner } from "./engine-runner";
import { WsHub } from "./ws-hub";
import type { Project } from "@orc/types";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execManagedProcess } from "@orc/adapters";
import { DEFAULT_MILESTONE_POLICY, type Task } from "@orc/types";
import { GateRunnerImpl, GitServiceImpl, Orchestrator, ValidatorImpl, WorktreeManagerImpl, type SchedulerDeps } from "@orc/engine";
import { defaultSettings } from "./config";
import { initDb } from "./db/index";
import * as repo from "./db/repo";
import { milestoneOutcomes, startMilestoneBudget } from "./milestones";

test("VW15: real Git worktrees and process gates retain two contributions across failed integration, restart, provider cancellation and successful recheck", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hoop-milestone-process-")); const primary = join(dir, "primary"); const remote = join(dir, "remote.git");
  const gitCmd = (args: string[], cwd = dir) => execManagedProcess("git", args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } });
  let db = initDb(join(dir, "state.sqlite"));
  try {
    await gitCmd(["init", "--bare", "--initial-branch=main", remote]); await gitCmd(["clone", remote, primary]);
    writeFileSync(join(primary, "a.txt"), "A"); writeFileSync(join(primary, "verify.cjs"), "const f=require('node:fs');require('node:assert/strict').equal(f.readFileSync('a.txt','utf8')+f.readFileSync('b.txt','utf8'),'AB');console.log('Combined workflow passed');");
    await gitCmd(["add", "."], primary); await gitCmd(["commit", "-m", "feature A and integration check"], primary);
    writeFileSync(join(primary, "b.txt"), "broken"); await gitCmd(["add", "."], primary); await gitCmd(["commit", "-m", "feature B"], primary); await gitCmd(["push", "origin", "main"], primary);
    const settings = defaultSettings(); settings.sandboxGates = "off"; repo.upsertSettings(db, settings);
    const project = repo.createProject(db, { id: "p", name: "Integrated fixture", repoUrl: remote, localPath: primary, defaultBranch: "main", status: "paused", config: { gates: { testCommand: "node verify.cjs" } } });
    const base = { projectId: project.id, description: "Verify both features together", difficulty: "medium" as const, assignedModel: settings.routing.byDifficulty.medium, acceptanceCriteria: ["Both features work together"], scopePaths: ["**/*"], attempts: 1, maxAttempts: 1, dependsOn: [] };
    repo.createTask(db, { ...base, id: "a", title: "Feature A", status: "done" }); repo.createTask(db, { ...base, id: "b", title: "Feature B", status: "done" });
    let check = repo.createTask(db, { ...base, id: "verify", title: "Integration", status: "ready", dependsOn: ["a", "b"], attempts: 0, milestone: { ...DEFAULT_MILESTONE_POLICY } });
    const git = new GitServiceImpl(); const worktrees = new WorktreeManagerImpl(settings); const gates = new GateRunnerImpl(worktrees, settings);
    let mode: "approve" | "cancel" = "approve"; let entered!: () => void; let processSettled = false;
    const adapter = { runner: "opencode" as const, async run(options: { signal?: AbortSignal; cwd: string }) {
      if (mode === "cancel") {
        entered();
        try { await execManagedProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: options.cwd, signal: options.signal }); }
        finally { processSettled = true; }
      }
      return { ok: true, exitReason: "completed" as const, costUsd: 0, tokensIn: 1, tokensOut: 1, summary: JSON.stringify({ verdict: "approve", confidence: 1, reasons: [], criterionEvidence: [{ criterion: "Both features work together", passed: true, evidence: "verify.cjs exercises a.txt plus b.txt; combined output AB" }] }) };
    } };
    const deps: SchedulerDeps = { settings, git, worktrees, gates, validator: new ValidatorImpl(() => adapter, settings), adapterFor() { throw new Error("Verification has no author"); }, opencodeBaseUrl: "", getTasks: () => repo.getTasks(db, "p"), beforeMilestone: (task) => startMilestoneBudget(db, task), events: { onLog() {}, onRunUpdated() {}, onTaskUpdated(task) { repo.updateTask(db, task.id, task); }, onMergeDecision(decision) { repo.createMergeDecision(db, decision); }, requestApproval() { return Promise.reject(new Error("No approval can override failed milestone checks")); } } };
    await new Orchestrator(deps).runTask(project, check);
    assert.equal(repo.getTask(db, check.id)?.status, "failed"); assert.match(repo.getMergeDecisions(db, check.id)[0]?.gate.details.tests ?? "", /AssertionError/);
    db.close(); db = initDb(join(dir, "state.sqlite"));
    assert.equal(repo.getTasks(db, "p").filter((task) => task.status === "done").length, 2);
    writeFileSync(join(primary, "b.txt"), "B"); await gitCmd(["add", "b.txt"], primary); await gitCmd(["commit", "-m", "bounded integration repair"], primary); await gitCmd(["push", "origin", "main"], primary);
    check = repo.resetTaskForRetry(db, check.id, "human") as Task;
    mode = "cancel"; const ready = new Promise<void>((resolve) => { entered = resolve; }); const engine = new Orchestrator(deps); const run = engine.runTask(project, check);
    await ready; assert.equal(engine.stopTask(check.id), true); await run;
    assert.equal(processSettled, true); assert.equal(existsSync(`${primary}-wt-${check.id}`), false);
    assert.equal(repo.getTask(db, "a")?.status, "done"); assert.equal(repo.getTask(db, "b")?.status, "done");
    check = repo.resetTaskForRetry(db, check.id, "human") as Task; mode = "approve";
    await new Orchestrator(deps).runTask(project, check);
    assert.equal(repo.getTask(db, check.id)?.status, "done");
    assert.equal((await milestoneOutcomes(db, project, git)).milestones[0]?.state, "accepted");
    assert.equal((await gitCmd(["status", "--porcelain"], primary)).stdout.trim(), "");
    const owner = new EngineRunner(db, new WsHub()) as unknown as { finishAutonomousRun(project: Project, startedAt: string): Promise<void> };
    await owner.finishAutonomousRun(project, new Date().toISOString());
    assert.equal(repo.getProject(db, project.id)?.status, "completed");
    repo.updateTask(db, check.id, { runGeneration: check.runGeneration + 1 });
    await owner.finishAutonomousRun(project, new Date().toISOString());
    assert.equal(repo.getProject(db, project.id)?.status, "paused", "done task rows without a current receipt cannot complete a project");
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
