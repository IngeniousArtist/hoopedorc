import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ClaudeAdapter,
  classifyFailure,
  CodexAdapter,
  makeAdapter,
  modelEffortArgs,
  OpenCodeAdapter,
} from "./index.js";

test("classifyFailure recognizes rate-limit-shaped failures", () => {
  assert.equal(classifyFailure("Error: rate limit exceeded, try again later"), "rate_limited");
  assert.equal(classifyFailure("rate-limited by upstream"), "rate_limited");
  assert.equal(classifyFailure("HTTP 429 Too Many Requests"), "rate_limited");
  assert.equal(classifyFailure("quota exceeded for this billing period"), "rate_limited");
  assert.equal(classifyFailure("You've hit your usage limit."), "rate_limited");
});

test("classifyFailure treats everything else as a plain error", () => {
  assert.equal(classifyFailure("connection refused"), "error");
  assert.equal(classifyFailure("unexpected token in JSON"), "error");
  assert.equal(classifyFailure(""), "error");
});

test("OpenCode transient retry sleep is cancelled by AbortSignal", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const adapter = new OpenCodeAdapter("", "test/model", undefined, async () => {
    attempts++;
    return {
      ok: false,
      exitReason: "error",
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      summary: "database is locked",
    };
  });
  const started = Date.now();
  const run = adapter.run({
    model: "test" as never,
    prompt: "test",
    cwd: process.cwd(),
    signal: controller.signal,
    onLog: () => {},
  });
  setTimeout(() => controller.abort(), 20);

  const result = await run;
  assert.equal(result.exitReason, "killed");
  assert.equal(attempts, 1);
  assert.ok(Date.now() - started < 500);
});

test("F48: every runner maps default and explicit effort to the exact CLI arguments", () => {
  assert.deepEqual(modelEffortArgs("claude-code"), []);
  assert.deepEqual(modelEffortArgs("claude-code", "high"), ["--effort", "high"]);
  assert.deepEqual(modelEffortArgs("opencode"), []);
  assert.deepEqual(modelEffortArgs("opencode", "provider-max"), [
    "--variant",
    "provider-max",
  ]);
  assert.deepEqual(modelEffortArgs("codex"), []);
  assert.deepEqual(modelEffortArgs("codex", "xhigh"), [
    "-c",
    "model_reasoning_effort=xhigh",
  ]);
});

test("F48: unsupported or unsafe effort fails actionably instead of falling back", () => {
  assert.throws(
    () => modelEffortArgs("claude-code", "ultra"),
    /claude-code effort must be one of/,
  );
  assert.throws(
    () => modelEffortArgs("codex", "minimal"),
    /codex effort must be one of/,
  );
  assert.throws(
    () => modelEffortArgs("opencode", "high;rm -rf"),
    /safe provider variant/,
  );
});

function writeHangingCli(dir: string, name: string, stdout: string): void {
  const script = [
    "#!/bin/sh",
    `exec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(
      `process.stdout.write(${JSON.stringify(stdout)}); setInterval(() => {}, 1000);`,
    )}`,
    "",
  ].join("\n");
  const path = join(dir, name);
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

async function runUntilLoggedThenAbort(
  adapter: { run: OpenCodeAdapter["run"] },
): Promise<Awaited<ReturnType<OpenCodeAdapter["run"]>>> {
  const controller = new AbortController();
  let logged = false;
  const result = adapter.run({
    model: "deepseek-flash",
    prompt: "partial work",
    cwd: process.cwd(),
    signal: controller.signal,
    onLog: () => {
      if (logged) return;
      logged = true;
      queueMicrotask(() => controller.abort());
    },
  });
  return result;
}

test(
  "O8: Claude adapter keeps streamed usage when stuck cancellation aborts the process",
  { skip: process.platform === "win32", timeout: 10_000 },
  async (t) => {
    const bin = mkdtempSync(join(tmpdir(), "orc-claude-o8-"));
    const originalPath = process.env.PATH ?? "";
    t.after(() => {
      process.env.PATH = originalPath;
      rmSync(bin, { recursive: true, force: true });
    });
    writeHangingCli(
      bin,
      "claude",
      `${JSON.stringify({
        type: "result",
        total_cost_usd: 1.25,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
        },
        result: "partial",
      })}\n`,
    );
    process.env.PATH = `${bin}:${originalPath}`;

    const result = await runUntilLoggedThenAbort(new ClaudeAdapter());
    assert.equal(result.exitReason, "killed");
    assert.equal(result.ok, false);
    assert.equal(result.costUsd, 1.25);
    assert.equal(result.tokensIn, 105);
    assert.equal(result.tokensOut, 50);
    assert.equal(result.tokensCached, 10);
  },
);

test(
  "O8: OpenCode adapter keeps streamed usage when stuck cancellation aborts the process",
  { skip: process.platform === "win32", timeout: 10_000 },
  async (t) => {
    const bin = mkdtempSync(join(tmpdir(), "orc-opencode-o8-"));
    const originalPath = process.env.PATH ?? "";
    t.after(() => {
      process.env.PATH = originalPath;
      rmSync(bin, { recursive: true, force: true });
    });
    writeHangingCli(
      bin,
      "opencode",
      `${JSON.stringify({
        part: {
          cost: 0.42,
          tokens: { input: 80, output: 20, cache: { read: 4, write: 2 } },
        },
      })}\n`,
    );
    process.env.PATH = `${bin}:${originalPath}`;

    const result = await runUntilLoggedThenAbort(
      new OpenCodeAdapter("", "test/model"),
    );
    assert.equal(result.exitReason, "killed");
    assert.equal(result.ok, false);
    assert.equal(result.costUsd, 0.42);
    assert.equal(result.tokensIn, 82);
    assert.equal(result.tokensOut, 20);
    assert.equal(result.tokensCached, 4);
  },
);

test(
  "O8: Codex adapter keeps streamed tokens when stuck cancellation aborts the process",
  { skip: process.platform === "win32", timeout: 10_000 },
  async (t) => {
    const bin = mkdtempSync(join(tmpdir(), "orc-codex-o8-"));
    const originalPath = process.env.PATH ?? "";
    t.after(() => {
      process.env.PATH = originalPath;
      rmSync(bin, { recursive: true, force: true });
    });
    writeHangingCli(
      bin,
      "codex",
      `${JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 200,
          cached_input_tokens: 50,
          output_tokens: 30,
        },
      })}\n`,
    );
    process.env.PATH = `${bin}:${originalPath}`;

    const result = await runUntilLoggedThenAbort(new CodexAdapter());
    assert.equal(result.exitReason, "killed");
    assert.equal(result.ok, false);
    assert.equal(result.costUsd, 0, "Codex remains subscription-priced");
    assert.equal(result.tokensIn, 150);
    assert.equal(result.tokensOut, 30);
    assert.equal(result.tokensCached, 50);
  },
);

test("B37: makeAdapter refuses a disabled model before any process starts", () => {
  assert.throws(
    () =>
      makeAdapter(
        {
          id: "disabled",
          displayName: "Disabled",
          runner: "codex",
          roles: [],
          enabled: false,
          maxConcurrent: 1,
        },
        "",
      ),
    /model disabled is disabled/,
  );
});
