import assert from "node:assert/strict";
import { test } from "node:test";
import { abortableDelay, execManagedProcess, spawnManagedProcess } from "./managed-process.js";

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (processExists(pid) && Date.now() < deadline) {
    await abortableDelay(20);
  }
}

test(
  "abort terminates a SIGTERM-resistant parent and its child process",
  { skip: process.platform === "win32" },
  async () => {
    const childProgram =
      'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);';
    const parentProgram = [
      'const {spawn}=require("node:child_process");',
      `const child=spawn(process.execPath,["-e",${JSON.stringify(childProgram)}],{stdio:"ignore"});`,
      "console.log(child.pid);",
      'process.on("SIGTERM",()=>{});',
      "setInterval(()=>{},1000);",
    ].join("");
    const controller = new AbortController();
    const managed = spawnManagedProcess(process.execPath, ["-e", parentProgram], {
      signal: controller.signal,
      killGraceMs: 100,
    });
    const parentPid = managed.child.pid!;
    const childPid = await new Promise<number>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("child pid was not reported")), 2_000);
      managed.child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        const pid = Number.parseInt(output, 10);
        if (Number.isFinite(pid)) {
          clearTimeout(timer);
          resolve(pid);
        }
      });
    });

    controller.abort();
    const result = await managed.settled;
    assert.equal(result.aborted, true);
    await Promise.all([waitForExit(parentPid), waitForExit(childPid)]);
    assert.equal(processExists(parentPid), false);
    assert.equal(processExists(childPid), false);
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
