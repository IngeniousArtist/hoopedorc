import assert from "node:assert/strict";
import { test } from "node:test";
import type { Settings } from "@orc/types";
import {
  SettingsValidationError,
  defaultSettings,
  mergeSettingsUpdate,
  normalizeSettings,
} from "./config.js";
import { initDb } from "./db/index.js";
import * as repo from "./db/repo.js";

function expectField(value: unknown, field: RegExp): void {
  assert.throws(
    () => normalizeSettings(value),
    (error: unknown) =>
      error instanceof SettingsValidationError && field.test(error.message),
  );
}

test("B43: the default GLM uses the dedicated Z.AI Coding Plan provider", () => {
  const glm = defaultSettings().models.find((model) => model.id === "glm");
  assert.ok(glm);
  assert.equal(glm.displayName, "GLM 5.2");
  assert.equal(glm.runner, "opencode");
  assert.equal(glm.opencodeModel, "zai-coding-plan/glm-5.2");
});

test("B37: historical settings are deep-normalized without sharing mutable defaults", () => {
  const base = defaultSettings();
  const legacy = {
    models: base.models.map(({ enabled: _enabled, maxConcurrent: _max, ...model }) => model),
    routing: base.routing,
    mergePolicy: base.mergePolicy,
    riskyChangeRules: {
      dbSchema: true,
      newDependencies: true,
      authOrSecrets: true,
      outOfScopeEdits: true,
    },
    confidenceThreshold: 0.7,
  };

  const normalized = normalizeSettings(legacy);
  assert.ok(normalized.models.every((model) => model.enabled && model.maxConcurrent === 1));
  assert.equal(normalized.riskyChangeRules.destructiveChanges, true);
  assert.equal(normalized.sandboxGates, "auto");
  assert.equal(normalized.holdWhileAwaitingApproval, false);
  assert.ok(normalized.guidelines?.coding);

  normalized.models[0]!.displayName = "mutated";
  assert.notEqual(defaultSettings().models[0]!.displayName, "mutated");
});

test("B37/F48: the settings contract rejects invalid persisted/API policy with field paths", () => {
  const cases: Array<[string, (settings: Settings) => void]> = [
    ["models\\[0\\]\\.runner", (s) => ((s.models[0] as { runner: string }).runner = "shell")],
    ["models\\[0\\]\\.enabled", (s) => ((s.models[0] as { enabled: unknown }).enabled = "yes")],
    ["models\\[0\\]\\.maxConcurrent", (s) => (s.models[0]!.maxConcurrent = Number.NaN)],
    ["models\\[0\\]\\.monthlyBudgetUsd", (s) => (s.models[0]!.monthlyBudgetUsd = 0)],
    ["models\\[0\\]\\.quota\\.maxRuns", (s) => (s.models[0]!.quota = { windowHours: 5, maxRuns: 1.5 })],
    ["models\\[0\\]\\.effort", (s) => (s.models[0]!.effort = "ultra")],
    ["mergePolicy", (s) => ((s as { mergePolicy: string }).mergePolicy = "sometimes")],
    ["confidenceThreshold", (s) => (s.confidenceThreshold = 1.1)],
    ["globalMonthlyBudgetUsd", (s) => (s.globalMonthlyBudgetUsd = Infinity)],
    ["allowVacuousGates", (s) => ((s as { allowVacuousGates: unknown }).allowVacuousGates = 1)],
    ["sandboxGates", (s) => ((s as { sandboxGates: string }).sandboxGates = "maybe")],
    ["holdWhileAwaitingApproval", (s) => ((s as { holdWhileAwaitingApproval: unknown }).holdWhileAwaitingApproval = "true")],
  ];

  for (const [field, mutate] of cases) {
    const settings = defaultSettings();
    mutate(settings);
    expectField(settings, new RegExp(field));
  }
});

test("B37: every routing target must exist and be enabled", () => {
  const missing = defaultSettings();
  missing.routing.planner = "missing";
  expectField(missing, /routing\.planner references missing model/);

  const disabled = defaultSettings();
  disabled.models.find((model) => model.id === disabled.routing.planner)!.enabled = false;
  expectField(disabled, /routing\.planner references disabled model/);

  const fallback = defaultSettings();
  const fallbackId = "fallback-only";
  fallback.models.push({
    ...fallback.models[0]!,
    id: fallbackId,
    displayName: "Fallback only",
    enabled: false,
  });
  fallback.routing.fallbacks = [fallbackId];
  expectField(fallback, /routing\.fallbacks\[0\] references disabled model/);
});

test("B37: a model can be disabled in one atomic update when routing is moved away", () => {
  const current = defaultSettings();
  const updated = mergeSettingsUpdate(current, {
    models: current.models.map((model) =>
      model.id === "grok" ? { ...model, enabled: false } : model,
    ),
    routing: {
      byRole: { ...current.routing.byRole, docs: "nex", updates: "nex" },
    },
  });
  assert.equal(updated.models.find((model) => model.id === "grok")!.enabled, false);
  assert.equal(updated.routing.byRole.docs, "nex");
  assert.equal(updated.routing.byRole.updates, "nex");
});

test("B37: repository writes and reads use the same validator as web-style merges", () => {
  const db = initDb(":memory:");
  const current = repo.upsertSettings(db, defaultSettings());
  const webUpdated = mergeSettingsUpdate(current, {
    mergePolicy: "always_ask",
    models: current.models.map((model) =>
      model.id === "claude" ? { ...model, effort: "high" } : model,
    ),
  });
  repo.upsertSettings(db, webUpdated);
  assert.equal(repo.getSettings(db)!.mergePolicy, "always_ask");
  assert.equal(
    repo.getSettings(db)!.models.find((model) => model.id === "claude")!.effort,
    "high",
  );

  const corrupt = { ...defaultSettings(), confidenceThreshold: -1 };
  assert.throws(() => repo.upsertSettings(db, corrupt), /confidenceThreshold/);

  db.prepare("UPDATE settings SET json = ? WHERE id = 1").run(JSON.stringify(corrupt));
  assert.throws(() => repo.getSettings(db), /confidenceThreshold/);
});
