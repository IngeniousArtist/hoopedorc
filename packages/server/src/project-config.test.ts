import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSetupCommand } from "./project-config.js";

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
