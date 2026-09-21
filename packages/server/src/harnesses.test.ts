import assert from "node:assert/strict";
import { test } from "node:test";
import { harnessCompatibility } from "./harnesses";
import { defaultSettings, normalizeSettings } from "./config";
import { resolvePlannerModel } from "./planner";

test("VW17: discovery distinguishes version, capability and provider access; mock starts no tools", async () => {
  const probe = (command: string) => Promise.resolve(({ claude: "2.1.278 (Claude Code)", codex: "codex-cli 0.154.0", opencode: "1.18.30", gemini: "0.60.0" })[command]!);
  const result = await harnessCompatibility(false, undefined, probe);
  assert.equal(result.harnesses.length, 4); assert.equal(result.harnesses[0]!.selective, true); assert.equal(result.harnesses[1]!.isolated, true);
  const gemini = result.harnesses[3]!; assert.equal(gemini.native, true); assert.equal(gemini.selective, false); assert.equal(gemini.isolated, false); assert.equal(gemini.providerAcceptance, "operator-check-required");
  assert.ok((await harnessCompatibility(true, undefined, () => Promise.reject(new Error("must never call")))).harnesses.every((entry) => entry.probe === "mock"));
  assert.equal((await harnessCompatibility(false, undefined, () => Promise.resolve("0.61.0"))).harnesses[3]!.native, false);
  assert.ok((await harnessCompatibility(false, undefined, () => Promise.reject(new Error("secret must not leak")))).harnesses.every((entry) => entry.probe === "unavailable" && !entry.detail.includes("secret")));
});

test("VW17: Gemini settings require deliberate model/billing and reject unsupported controls", () => {
  const settings = defaultSettings(); const gemini = { id: "gemini-profile", displayName: "Gemini", runner: "gemini" as const, geminiModel: "account-model", roles: [] as never[], enabled: true, maxConcurrent: 1 };
  settings.models.push(gemini);
  assert.throws(() => normalizeSettings(settings), /subscription account pool/);
  Object.assign(gemini, { costPerMInputUsd: 2, costPerMCachedInputUsd: 0.2, costPerMOutputUsd: 8 });
  assert.equal(normalizeSettings(settings).models.at(-1)!.geminiModel, "account-model");
  settings.routing.planner = gemini.id; assert.equal(resolvePlannerModel(settings, "chat").runner, "gemini");
  assert.throws(() => normalizeSettings({ ...settings, models: [...settings.models.slice(0, -1), { ...gemini, effort: "high" }] }), /not verified/);
  assert.throws(() => normalizeSettings({ ...settings, models: [...settings.models.slice(0, -1), { ...gemini, geminiModel: "-x" }] }), /explicit safe/);
  assert.throws(() => normalizeSettings({ ...settings, models: [...settings.models.slice(0, -1), { ...gemini, executionProfileId: "missing" }] }), /same harness/);
});
