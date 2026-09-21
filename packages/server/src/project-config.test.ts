import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSetupCommand } from "./project-config.js";
import { parseProjectConfig } from "./project-validation.js";

test("VW16: canonical environment and command arrays round-trip without weakening legacy configuration", () => {
  const config = { environment: { runtime: "python3", platform: "any", majorVersion: 3, output: "artifacts", setupInputs: ["bootstrap.py"], setupOutputs: [".hoopedorc-venv/pyvenv.cfg"] }, gates: { testCommand: "legacy test", commands: { tests: { command: "python3", args: ["-c", "print('literal space')", ""] }, build: false } }, preview: { command: "python3", args: ["server.py", "{port}"], readinessPath: "/health", startupTimeoutSeconds: 10 } };
  assert.deepEqual(parseProjectConfig(config), { value: config });
  for (const changes of [{ environment: { ...config.environment, runtime: "guessed-sdk" } }, { environment: { ...config.environment, setupInputs: ["../secret"] } }, { gates: { commands: { tests: { command: "python3", args: "bad" } } } }, { gates: { commands: { unknown: false } } }]) assert.ok("error" in parseProjectConfig({ ...config, ...changes }));
});

test("B38: structured project setup preserves literal argv without shell parsing", () => {
  const parsed = parseSetupCommand({
    command: "  python3  ",
    args: ["-m", "venv", "path with spaces/.venv", "--flag=$HOME;echo nope"],
  });
  assert.deepEqual(parsed, {
    value: {
      command: "python3",
      args: ["-m", "venv", "path with spaces/.venv", "--flag=$HOME;echo nope"],
    },
  });
});

test("B38: malformed setup commands and argument arrays fail at the API boundary", () => {
  const invalid: unknown[] = [
    null,
    { command: "", args: [] },
    { command: "tool", args: "--flag" },
    { command: "tool", args: Array.from({ length: 101 }, () => "arg") },
    { command: "tool\0oops", args: [] },
    { command: "tool", args: ["bad\0arg"] },
  ];
  for (const input of invalid) {
    assert.ok("error" in parseSetupCommand(input));
  }
});
