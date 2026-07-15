import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRuntimeHealth } from "./runtime-health.js";

const telegramDisabled = {
  enabled: false,
  running: false,
  state: "disabled" as const,
};

test("B41: optional Docker outage remains healthy and exposes safe detail", () => {
  const health = buildRuntimeHealth({
    lifecycle: { state: "running", errorCount: 0 },
    mock: false,
    version: "0.6.0",
    dockerAvailable: false,
    dockerRequired: false,
    telegram: telegramDisabled,
  });
  assert.equal(health.ok, true);
  assert.equal(health.dependencies.docker.available, false);
  assert.match(health.dependencies.docker.detail, /auto mode uses the host/);
  assert.deepEqual(health.degraded, []);
  assert.doesNotMatch(JSON.stringify(health), /token|secret|credential/i);
});
test("B41: required Docker outage is degraded and shutdown state is unhealthy", () => {
  const degraded = buildRuntimeHealth({
    lifecycle: { state: "running", errorCount: 0 },
    mock: false,
    version: "0.6.0",
    dockerAvailable: false,
    dockerRequired: true,
    telegram: telegramDisabled,
  });
  assert.equal(degraded.ok, false);
  assert.equal(degraded.degraded.length, 1);

  const stopping = buildRuntimeHealth({
    lifecycle: {
      state: "shutting_down",
      reason: "SIGTERM",
      requestedAt: "2026-07-15T00:00:00.000Z",
      errorCount: 0,
    },
    mock: false,
    version: "0.6.0",
    dockerAvailable: true,
    dockerRequired: true,
    telegram: telegramDisabled,
  });
  assert.equal(stopping.ok, false);
  assert.equal(stopping.state, "shutting_down");
  assert.equal(stopping.shutdownReason, "SIGTERM");
});

test("F49: Telegram delivery failure is exposed as credential-free degradation", () => {
  const health = buildRuntimeHealth({
    lifecycle: { state: "running", errorCount: 0 },
    mock: false,
    version: "0.6.0",
    dockerAvailable: true,
    dockerRequired: false,
    telegram: {
      enabled: true,
      running: true,
      state: "degraded",
      lastError: "Too Many Requests",
      lastErrorAt: "2026-07-15T00:00:00.000Z",
    },
  });
  assert.equal(health.ok, false);
  assert.match(health.degraded[0] ?? "", /Telegram delivery.*Too Many Requests/);
  assert.doesNotMatch(JSON.stringify(health), /123456:bot-token/);
});
