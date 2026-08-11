import assert from "node:assert/strict";
import { test } from "node:test";
import { abortableDelay, execManagedProcess, spawnManagedProcess } from "./managed-process.js";

test(
  "abort terminates a SIGTERM-resistant parent and its child process",
  { skip: process.platform === "win32", timeout: 10_000 },
  async (t) => {
    // The grandchild holds the managed stdout pipe open. ChildProcess "close"
    // (and therefore managed.settled) cannot fire until that inherited fd is
    // closed, which proves the process group exited without consulting a
    // zombie-sensitive PID table.
    const childProgram =
      'process.on("SIGTERM",()=>{});process.stdout.write("ready\\n");setInterval(()=>{},1000);';
    const parentProgram = [
      'const {spawn}=require("node:child_process");',
      'process.on("SIGTERM",()=>{});',
      `spawn(process.execPath,["-e",${JSON.stringify(childProgram)}],{stdio:["ignore","inherit","ignore"]});`,
      "setInterval(()=>{},1000);",
    ].join("");
    const controller = new AbortController();
    const managed = spawnManagedProcess(process.execPath, ["-e", parentProgram], {
      signal: controller.signal,
      killGraceMs: 100,
    });
    t.after(async () => {
      controller.abort();
      await managed.settled;
    });
    await new Promise<void>((resolve) => {
      let output = "";
      const onData = (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (!output.includes("ready\n")) return;
        managed.child.stdout.off("data", onData);
        resolve();
      };
      managed.child.stdout.on("data", onData);
    });

    controller.abort();
    const result = await managed.settled;
    assert.equal(result.aborted, true);
    assert.equal(result.signal, "SIGKILL");
  },
);

test("output limit terminates a noisy process", async () => {
  await assert.rejects(
    execManagedProcess(process.execPath, ["-e", 'process.stdout.write("x".repeat(10000));setInterval(()=>{},1000)'], {
      maxOutputBytes: 128,
      killGraceMs: 50,
    }),
    (err: unknown) => {
      assert.equal((err as { outputLimitExceeded?: boolean }).outputLimitExceeded, true);
      assert.ok((err as { stdout: string }).stdout.length <= 128);
      return true;
    },
  );
});

test("execManagedProcess captures stdout and stderr by default", async () => {
  const result = await execManagedProcess(process.execPath, [
    "-e",
    'process.stdout.write("stdout-value");process.stderr.write("stderr-value");',
  ]);

  assert.equal(result.stdout, "stdout-value");
  assert.equal(result.stderr, "stderr-value");
});

test("captureOutput false streams stdout and stderr without retaining them", async () => {
  const managed = spawnManagedProcess(
    process.execPath,
    [
      "-e",
      'process.stdout.write("streamed-stdout");process.stderr.write("streamed-stderr");',
    ],
    { captureOutput: false },
  );
  let streamedStdout = "";
  let streamedStderr = "";
  managed.child.stdout.on("data", (chunk: Buffer) => {
    streamedStdout += chunk.toString("utf8");
  });
  managed.child.stderr.on("data", (chunk: Buffer) => {
    streamedStderr += chunk.toString("utf8");
  });

  const result = await managed.settled;

  assert.equal(result.code, 0);
  assert.equal(streamedStdout, "streamed-stdout");
  assert.equal(streamedStderr, "streamed-stderr");
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test(
  "captureOutput false still applies the shared output cap to the process group",
  { skip: process.platform === "win32", timeout: 10_000 },
  async () => {
    const childProgram =
      'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);';
    const parentProgram = [
      'const {spawn}=require("node:child_process");',
      'process.on("SIGTERM",()=>{});',
      `spawn(process.execPath,["-e",${JSON.stringify(childProgram)}],{stdio:["ignore","inherit","inherit"]});`,
      'process.stdout.write("o".repeat(80));',
      'process.stderr.write("e".repeat(80));',
      "setInterval(()=>{},1000);",
    ].join("");
    const managed = spawnManagedProcess(process.execPath, ["-e", parentProgram], {
      captureOutput: false,
      maxOutputBytes: 128,
      killGraceMs: 100,
    });

    const result = await managed.settled;

    assert.equal(result.outputLimitExceeded, true);
    assert.equal(result.signal, "SIGKILL");
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  },
);

test("abortableDelay rejects promptly and clears its wait", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const wait = abortableDelay(10_000, controller.signal);
  controller.abort();
  await assert.rejects(wait, { name: "AbortError" });
  assert.ok(Date.now() - started < 500);
});
