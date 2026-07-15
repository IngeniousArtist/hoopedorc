import assert from "node:assert/strict";
import { test } from "node:test";
import {
  _resetDockerDetectionForTests,
  _resetSandboxWarningForTests,
  detectDocker,
  isPlausibleImageRef,
  resolveSandboxMode,
  sandboxedExecFile,
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

test("B41: Docker detection recovers unavailable -> available -> unavailable after TTL", async () => {
  _resetDockerDetectionForTests();
  let now = 0;
  let calls = 0;
  const results = [false, true, false];
  const probe = async () => results[calls++]!;
  const options = { now: () => now, ttlMs: 100 };

  assert.equal(await detectDocker(probe, options), false);
  now = 99;
  assert.equal(await detectDocker(probe, options), false);
  assert.equal(calls, 1, "the unavailable result is still cached inside the TTL");

  now = 100;
  assert.equal(await detectDocker(probe, options), true);
  now = 200;
  assert.equal(await detectDocker(probe, options), false);
  assert.equal(calls, 3);
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

test("sandbox forwards safe npm/runtime settings but no CLI or registry credentials", async () => {
  const keys = [
    "npm_config_registry",
    "npm_config_https_proxy",
    "npm_config__authToken",
    "NPM_CONFIG_PASSWORD",
    "NODE_ENV",
    "NODE_EXTRA_CA_CERTS",
    "NODE_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "GH_TOKEN",
    "TELEGRAM_BOT_TOKEN",
  ] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    npm_config_registry: "https://registry.example",
    npm_config_https_proxy: "http://proxy.example",
    npm_config__authToken: "npm-secret",
    NPM_CONFIG_PASSWORD: "npm-password",
    NODE_ENV: "test",
    NODE_EXTRA_CA_CERTS: "/etc/corporate.pem",
    NODE_AUTH_TOKEN: "node-secret",
    ANTHROPIC_API_KEY: "provider-secret",
    GH_TOKEN: "github-secret",
    TELEGRAM_BOT_TOKEN: "telegram-secret",
  });
  let dockerArgs: readonly string[] = [];
  const runner = (async (_command: string, args: readonly string[]) => {
    dockerArgs = args;
    return { stdout: "", stderr: "" };
  }) as Parameters<typeof sandboxedExecFile>[5];

  try {
    await sandboxedExecFile("node:22", "/tmp", "npm", ["test"], {}, runner);
  } finally {
    for (const key of keys) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const forwarded = dockerArgs
    .flatMap((arg, index) => (arg === "-e" ? [dockerArgs[index + 1] ?? ""] : []))
    .map((entry) => entry.slice(0, entry.indexOf("=")))
    .filter(Boolean);
  for (const expected of [
    "HOME",
    "PATH",
    "npm_config_registry",
    "npm_config_https_proxy",
    "NODE_ENV",
    "NODE_EXTRA_CA_CERTS",
  ]) {
    assert.ok(forwarded.includes(expected), expected);
  }
  for (const forbidden of [
    "npm_config__authToken",
    "NPM_CONFIG_PASSWORD",
    "NODE_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "GH_TOKEN",
    "TELEGRAM_BOT_TOKEN",
  ]) {
    assert.equal(forwarded.includes(forbidden), false, forbidden);
  }
});

test("sandbox force-removes its uniquely named container when docker run is aborted", async () => {
  _resetDockerDetectionForTests();
  assert.equal(await detectDocker(async () => true), true);
  const calls: { command: string; args: readonly string[] }[] = [];
  const runner = (async (command: string, args: readonly string[]) => {
    calls.push({ command, args });
    if (args[0] === "run") {
      throw new DOMException("The operation was aborted", "AbortError");
    }
    return { stdout: "", stderr: "" };
  }) as Parameters<typeof sandboxedExecFile>[5];

  await assert.rejects(
    sandboxedExecFile("node:22", "/tmp", "npm", ["test"], {}, runner),
    { name: "AbortError" },
  );
  assert.equal(calls.length, 2);
  const nameIndex = calls[0]!.args.indexOf("--name");
  assert.ok(nameIndex >= 0);
  const containerName = calls[0]!.args[nameIndex + 1]!;
  assert.match(containerName, /^hoopedorc-/);
  assert.deepEqual(calls[1], {
    command: "docker",
    args: ["rm", "-f", containerName],
  });
  let reprobes = 0;
  assert.equal(
    await detectDocker(async () => {
      reprobes++;
      return false;
    }),
    false,
  );
  assert.equal(reprobes, 1, "a failed docker execution invalidates the availability cache");
  _resetDockerDetectionForTests();
});
