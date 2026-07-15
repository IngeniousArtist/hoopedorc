import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRuntimeHealth } from "./runtime-health.js";

test("B41: optional Docker outage remains healthy and exposes safe detail", () => {
  const health = buildRuntimeHealth({
    lifecycle: { state: "running", errorCount: 0 },
    mock: false,
    version: "0.6.0",
    dockerAvailable: false,
    dockerRequired: false,
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
  });
  assert.equal(stopping.ok, false);
  assert.equal(stopping.state, "shutting_down");
  assert.equal(stopping.shutdownReason, "SIGTERM");
});
