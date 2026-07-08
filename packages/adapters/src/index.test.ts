import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyFailure } from "./index.js";

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
