import assert from "node:assert/strict";
import { test } from "node:test";
import {
  _resetDockerDetectionForTests,
  _resetSandboxWarningForTests,
  detectDocker,
  isPlausibleImageRef,
  resolveSandboxMode,
} from "./sandbox.js";

test("isPlausibleImageRef accepts real-world image refs", () => {
  for (const ref of ["node:22", "node", "python:3.12-slim", "ghcr.io/acme/gate-runner:v1.2.3"]) {
    assert.equal(isPlausibleImageRef(ref), true, ref);
  }
});

test("isPlausibleImageRef rejects garbage / oversized input", () => {
  for (const ref of ["", "node:22; rm -rf /", "node 22", "a".repeat(201)]) {
    assert.equal(isPlausibleImageRef(ref), false, ref);
  }
});

test("detectDocker caches the probe result across calls", async () => {
  _resetDockerDetectionForTests();
  let calls = 0;
  const probe = async () => {
    calls++;
    return true;
  };
  const first = await detectDocker(probe);
  const second = await detectDocker(probe);
  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(calls, 1, "the probe subprocess should only be spawned once, not once per call");
  _resetDockerDetectionForTests();
});

test('resolveSandboxMode("off") never probes for Docker', async () => {
  let probed = false;
  const resolved = await resolveSandboxMode("off", async () => {
    probed = true;
    return true;
  });
  assert.equal(resolved.useSandbox, false);
  assert.equal(probed, false, '"off" is a fully local decision — it must not even check for a daemon');
});

test('resolveSandboxMode("auto") sandboxes when the daemon responds', async () => {
  const resolved = await resolveSandboxMode("auto", async () => true);
  assert.equal(resolved.useSandbox, true);
});

test('resolveSandboxMode("auto") falls back to host when no daemon responds, without throwing', async () => {
  _resetSandboxWarningForTests();
  const resolved = await resolveSandboxMode("auto", async () => false);
  assert.equal(resolved.useSandbox, false);
  _resetSandboxWarningForTests();
});

test('resolveSandboxMode(undefined) behaves like "auto" (the documented default)', async () => {
  const resolvedWithDaemon = await resolveSandboxMode(undefined, async () => true);
  assert.equal(resolvedWithDaemon.useSandbox, true);
  const resolvedWithoutDaemon = await resolveSandboxMode(undefined, async () => false);
  assert.equal(resolvedWithoutDaemon.useSandbox, false);
});

test('resolveSandboxMode("required") sandboxes when the daemon responds', async () => {
  const resolved = await resolveSandboxMode("required", async () => true);
  assert.equal(resolved.useSandbox, true);
});

test('resolveSandboxMode("required") throws instead of silently falling back when no daemon responds', async () => {
  await assert.rejects(() => resolveSandboxMode("required", async () => false), /Docker daemon/);
});
