import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ModelInvocation, Project } from "@orc/types";
import { defaultSettings } from "./config.js";
import {
  getModelCatalog,
  getModelRoster,
  projectSetupChecks,
  testModels,
} from "./setup.js";

test("B40: model test emits a health invocation even for subscription-priced calls", async () => {
  const bin = mkdtempSync(join(tmpdir(), "hoopedorc-health-ledger-"));
  const fakeCli = `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    type: "result",
    result: "Hello from Claude",
    total_cost_usd: 0,
    usage: { input_tokens: 8, output_tokens: 3, cache_read_input_tokens: 2 }
  }) + "\\n");
});
`;
  const file = join(bin, "claude");
  writeFileSync(file, fakeCli);
  chmodSync(file, 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath ?? ""}`;
  const settings = defaultSettings();
  settings.models = settings.models.filter((model) => model.id === "claude");
  const events: ModelInvocation[] = [];
  try {
    const result = await testModels(
      settings,
      "",
      (event) => events.push(event),
    );
    assert.equal(result.results[0]?.ok, true);
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  }

  assert.equal(events.length, 2);
  assert.equal(events[0]?.stage, "health");
  assert.equal(events[0]?.outcome, "running");
  assert.equal(events[1]?.id, events[0]?.id);
  assert.equal(events[1]?.outcome, "completed");
  assert.equal(events[1]?.costUsd, 0);
  assert.equal(events[1]?.tokensIn, 8);
  assert.equal(events[1]?.tokensCached, 2);
});

test("B41: shutdown aborts an in-flight model health request", async () => {
  const bin = mkdtempSync(join(tmpdir(), "hoopedorc-health-abort-"));
  const fakeCli = `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => setInterval(() => {}, 1_000));
`;
  const file = join(bin, "claude");
  writeFileSync(file, fakeCli);
  chmodSync(file, 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath ?? ""}`;
  const settings = defaultSettings();
  settings.models = settings.models.filter((model) => model.id === "claude");
  const events: ModelInvocation[] = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    const result = await testModels(
      settings,
      "",
      (event) => events.push(event),
      controller.signal,
    );
    assert.equal(result.results[0]?.ok, false);
  } finally {
    clearTimeout(timer);
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  }

  assert.equal(events.length, 2);
  assert.equal(events[1]?.outcome, "stopped");
  assert.equal(events[1]?.exitReason, "killed");
});

test("B41: shutdown aborts an in-flight setup CLI probe", async () => {
  const bin = mkdtempSync(join(tmpdir(), "hoopedorc-setup-abort-"));
  const fakeCli = `#!/usr/bin/env node
setInterval(() => {}, 1_000);
`;
  const file = join(bin, "opencode");
  writeFileSync(file, fakeCli);
  chmodSync(file, 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath ?? ""}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    await assert.rejects(
      getModelRoster(controller.signal),
      (error: unknown) => (error as Error).name === "AbortError",
    );
  } finally {
    clearTimeout(timer);
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  }
});

test("model catalog reads Codex slugs, documents Claude choices, and filters OpenCode providers", async () => {
  const bin = mkdtempSync(join(tmpdir(), "hoopedorc-model-catalog-"));
  const codex = join(bin, "codex");
  const opencode = join(bin, "opencode");
  writeFileSync(
    codex,
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  models: [
    {
      slug: "gpt-test-codex",
      display_name: "GPT Test Codex",
      description: "test model",
      visibility: "list",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }]
    },
    {
      slug: "hidden-internal",
      display_name: "Hidden",
      visibility: "hide",
      supported_reasoning_levels: []
    }
  ]
}));
`,
  );
  writeFileSync(
    opencode,
    `#!/usr/bin/env node
process.stdout.write([
  "zai/glm-test",
  "xai/grok-test",
  "deepseek/deepseek-test",
  "openrouter/deepseek/deepseek-test",
  "anthropic/claude-test"
].join("\\n"));
`,
  );
  chmodSync(codex, 0o755);
  chmodSync(opencode, 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath ?? ""}`;
  try {
    const result = await getModelCatalog();
    const codexCatalog = result.catalogs.find((catalog) => catalog.runner === "codex");
    const claudeCatalog = result.catalogs.find(
      (catalog) => catalog.runner === "claude-code",
    );
    const openCodeCatalog = result.catalogs.find(
      (catalog) => catalog.runner === "opencode",
    );

    assert.deepEqual(codexCatalog?.models, [
      {
        slug: "gpt-test-codex",
        displayName: "GPT Test Codex",
        description: "test model",
        kind: "model",
        reasoningEfforts: ["low", "high"],
      },
    ]);
    assert.ok(claudeCatalog?.models.some((model) => model.slug === "sonnet"));
    assert.ok(
      claudeCatalog?.models.some((model) => model.slug === "claude-opus-4-8"),
    );
    assert.deepEqual(
      openCodeCatalog?.models.map((model) => model.slug),
      ["deepseek/deepseek-test", "xai/grok-test", "zai/glm-test"],
    );
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  }
});

test("B38: Setup health names each project's selected manager and runtime", async () => {
  const localPath = mkdtempSync(join(tmpdir(), "hoopedorc-setup-health-"));
  writeFileSync(join(localPath, "package.json"), JSON.stringify({ name: "fixture" }));
  writeFileSync(join(localPath, "package-lock.json"), "{}");
  const project: Project = {
    id: "p1",
    name: "Portable fixture",
    repoUrl: "",
    defaultBranch: "main",
    localPath,
    status: "created",
    createdAt: "",
    updatedAt: "",
  };
  const checks = await projectSetupChecks({ sandboxGates: "off" }, [project]);
  assert.equal(checks.length, 1);
  assert.equal(checks[0]?.name, "Project setup — Portable fixture");
  assert.equal(checks[0]?.ok, true, checks[0]?.detail);
  assert.match(checks[0]?.detail ?? "", /npm@.*package-lock\.json.*v\d+.*(?:darwin|linux|win32)\//i);
});
