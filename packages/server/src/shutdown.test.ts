import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { initDb } from "./db/index.js";
import * as repo from "./db/repo.js";
import { ShutdownCoordinator } from "./shutdown.js";

test("B41: coordinated shutdown is ordered, idempotent, and exits after DB close", async () => {
  const order: string[] = [];
  const exits: number[] = [];
  const coordinator = new ShutdownCoordinator({
    stopAccepting: () => {
      order.push("admission");
    },
    stopEngine: async () => {
      order.push("engine");
      return { settled: true };
    },
    stopTelegram: () => {
      order.push("telegram");
    },
    flushLogs: () => {
      order.push("logs");
    },
    recordAudit: (_reason, result) => {
      assert.equal(result.settled, true);
      order.push("audit");
    },
    closeServer: () => {
      order.push("server");
    },
    checkpointDb: () => {
      order.push("checkpoint");
    },
    closeDb: () => {
      order.push("db");
    },
    log: () => {},
    exit: (code) => {
      exits.push(code);
    },
  });
  coordinator.markRunning();
  assert.equal(coordinator.snapshot.state, "running");

  const first = coordinator.shutdown("SIGTERM", 0);
  const second = coordinator.shutdown("uncaught_exception", 1);
  assert.equal(second, first);
  assert.equal(coordinator.snapshot.state, "shutting_down");
  await first;

  assert.deepEqual(order, [
    "admission",
    "engine",
    "telegram",
    "logs",
    "audit",
    "server",
    "checkpoint",
    "db",
  ]);
  assert.deepEqual(exits, [0]);
  assert.equal(coordinator.snapshot.state, "stopped");
});

test("B41: a cleanup failure still closes the DB and upgrades graceful exit", async () => {
  const order: string[] = [];
  let exitCode = -1;
  const coordinator = new ShutdownCoordinator({
    stopAccepting: () => {},
    stopEngine: async () => ({ settled: true }),
    stopTelegram: () => {
      throw new Error("telegram stuck");
    },
    flushLogs: () => {
      order.push("logs");
    },
    recordAudit: () => {
      order.push("audit");
    },
    closeServer: () => {
      order.push("server");
    },
    checkpointDb: () => {
      order.push("checkpoint");
    },
    closeDb: () => {
      order.push("db");
    },
    log: () => {},
    exit: (code) => {
      exitCode = code;
    },
  });

  await coordinator.shutdown("SIGINT", 0);
  assert.deepEqual(order, ["logs", "audit", "server", "checkpoint", "db"]);
  assert.equal(exitCode, 1);
  assert.equal(coordinator.snapshot.errorCount, 1);
});

async function runFixture(mode: "signal" | "fatal"): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `hoopedorc-shutdown-${mode}-`));
  const dbPath = join(dir, "orc.db");
  const childPidPath = join(dir, "managed-child.pid");
  const fixture = fileURLToPath(new URL("./shutdown-fixture.ts", import.meta.url));
  try {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", fixture, mode, dbPath, childPidPath],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const closed = once(child, "close") as Promise<[number | null, string | null]>;
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    for (let attempt = 0; attempt < 300 && !stdout.includes("READY"); attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      if (child.exitCode !== null) break;
    }
    assert.match(stdout, /READY/, stderr);
    if (mode === "signal") child.kill("SIGTERM");

    const [code, signal] = await closed;
    assert.equal(signal, null);
    assert.equal(code, mode === "signal" ? 0 : 1, stderr);

    const managedPid = Number(readFileSync(childPidPath, "utf8"));
    assert.throws(
      () => process.kill(managedPid, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
      "the managed child process must be gone before the fixture exits",
    );

    const db = initDb(dbPath);
    assert.equal(repo.getProject(db, "fixture-project")?.status, "paused");
    const audit = repo.getAuditLog(db, "fixture-project");
    assert.equal(audit[0]?.kind, "shutdown");
    assert.match(audit[0]?.summary ?? "", mode === "signal" ? /SIGTERM/ : /uncaught_exception/);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("B41: SIGTERM kills managed children, persists audit state, and exits zero", async () => {
  await runFixture("signal");
});

test("B41: uncaught exception uses the same cleanup and exits nonzero", async () => {
  await runFixture("fatal");
});
