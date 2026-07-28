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

test("abortableDelay rejects promptly and clears its wait", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const wait = abortableDelay(10_000, controller.signal);
  controller.abort();
  await assert.rejects(wait, { name: "AbortError" });
  assert.ok(Date.now() - started < 500);
});
