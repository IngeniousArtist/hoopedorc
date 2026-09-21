import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ModelInvocation } from "@orc/types";
import { defaultSettings, normalizeSettings } from "./config";
import { initDb } from "./db/index";
import * as repo from "./db/repo";
import { persistInvocationEvent } from "./invocation-ledger";
import { runPlannerChat, resolvePlannerModel } from "./planner";
import { testModels } from "./setup";
import { ResourceManager } from "./resources";

test("VW17: Gemini planning/health preserve failure usage, exactly-once billing and restart identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "vw17-ledger-")); const prior = process.env.PATH;
  const dbPath = join(root, "state.sqlite"); let db = initDb(dbPath);
  const settings = defaultSettings(); settings.models.push({ id: "gemini-profile", displayName: "Gemini", runner: "gemini", geminiModel: "account-model", roles: ["planner"], enabled: true, maxConcurrent: 1, accountPoolId: "google" });
  settings.accountPools = [{ id: "google", name: "Google subscription", billing: "subscription", maxConcurrent: 1, reviewSlots: 0 }];
  settings.routing.planner = "gemini-profile";
  repo.upsertSettings(db, normalizeSettings(settings));
  function cli(success: boolean) {
    writeFileSync(join(root, "gemini"), `#!${process.execPath}\nif(process.argv.includes('--version')){console.log('0.60.0');process.exit();} process.stdin.resume(); process.stdin.on('end',()=>{console.log(JSON.stringify({type:'message',role:'assistant',content:'A usable plan'})); console.log(JSON.stringify({type:'result',status:'${success ? "success" : "error"}',stats:{input_tokens:10,cached:3,output_tokens:4},error:${success ? "undefined" : "{message:'provider unavailable'}"}}));process.exitCode=${success ? 0 : 1};});`); chmodSync(join(root, "gemini"), 0o755);
  }
  process.env.PATH = `${root}:${prior ?? ""}`;
  const events: ModelInvocation[] = [];
  const sink = (event: ModelInvocation) => { events.push(event); persistInvocationEvent(db, event); };
  try {
    cli(true); const model = resolvePlannerModel(settings, "chat");
    model.prepareActivation = async (id, stage) => { const resources = new ResourceManager(db); const guard = await resources.guard({ id, model: model.id!, stage }); return { instructions: "", accounting: guard.accounting, close: () => { guard.release(); return Promise.resolve(); } }; };
    const result = await runPlannerChat([], "demo", root, model, undefined, undefined, undefined, sink); assert.equal(result.reply, "A usable plan");
    assert.equal(events.length, 2); assert.equal(events[1]!.tokensIn, 7); assert.equal(events[1]!.tokensCached, 3);
    const id = events[1]!.id; persistInvocationEvent(db, { ...events[1]!, tokensIn: 999 });
    db.close(); db = initDb(dbPath); assert.equal(repo.getInvocation(db, id)!.runner, "gemini"); assert.equal(repo.getInvocation(db, id)!.tokensIn, 7); assert.equal(repo.getInvocation(db, id)!.costUsd, 0);
    cli(false); await assert.rejects(runPlannerChat([], "demo", root, model, undefined, undefined, undefined, sink), /provider unavailable/);
    const failed = events.at(-1)!; assert.equal(failed.outcome, "failed"); assert.equal(failed.tokensOut, 4); assert.notEqual(failed.id, id);
    cli(true); const health = await testModels({ ...settings, models: settings.models.filter((model) => model.runner === "gemini") }, "", sink, undefined, (cfg, invocationId, signal) => new ResourceManager(db).guard({ id: invocationId, model: cfg.id, stage: "health" }, signal));
    assert.equal(health.results[0]!.ok, true); assert.equal(events.at(-1)!.stage, "health"); assert.equal(new ResourceManager(db).response().pools[0]!.observedCalls, 3);
  } finally { db.close(); if (prior === undefined) delete process.env.PATH; else process.env.PATH = prior; rmSync(root, { recursive: true, force: true }); }
});
