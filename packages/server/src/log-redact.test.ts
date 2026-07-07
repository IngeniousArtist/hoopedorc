import assert from "node:assert/strict";
import { test } from "node:test";
import { redactTokenFromUrl } from "./log-redact.js";

test("redactTokenFromUrl: redacts a ?token= query param", () => {
  assert.equal(
    redactTokenFromUrl("/ws?token=super-secret-value"),
    "/ws?token=[redacted]",
  );
});

test("redactTokenFromUrl: redacts a &token= param that isn't first", () => {
  assert.equal(
    redactTokenFromUrl("/ws?foo=bar&token=super-secret-value"),
    "/ws?foo=bar&token=[redacted]",
  );
});

test("redactTokenFromUrl: leaves a URL with no token param untouched", () => {
  assert.equal(redactTokenFromUrl("/api/health"), "/api/health");
  assert.equal(redactTokenFromUrl("/api/projects?foo=bar"), "/api/projects?foo=bar");
});

test("redactTokenFromUrl: never leaks the real token value in its output", () => {
  const secret = "sk-do-not-leak-this-1234567890";
  const result = redactTokenFromUrl(`/ws?token=${secret}`);
  assert.equal(result.includes(secret), false);
});
