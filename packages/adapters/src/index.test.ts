import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyFailure, OpenCodeAdapter } from "./index.js";

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
  const adapter = new OpenCodeAdapter("", "test/model", async () => {
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
