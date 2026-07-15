import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { execManagedProcess } from "@orc/adapters";
import { initDb } from "./db/index.js";
import * as repo from "./db/repo.js";
import { installShutdownHandlers, ShutdownCoordinator } from "./shutdown.js";

const [mode, dbPath, childPidPath] = process.argv.slice(2);
if ((mode !== "signal" && mode !== "fatal") || !dbPath || !childPidPath) {
  throw new Error("usage: shutdown-fixture <signal|fatal> <db-path> <child-pid-path>");
}

const db = initDb(dbPath);
repo.createProject(db, {
  id: "fixture-project",
  name: "Fixture",
  repoUrl: "https://github.com/x/y",
  defaultBranch: "main",
  localPath: "/tmp/fixture",
  status: "running",
});

const controller = new AbortController();
const stubbornChild = execManagedProcess(
  process.execPath,
  [
    "-e",
    `require("node:fs").writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`,
  ],
  { signal: controller.signal },
);

for (let attempt = 0; attempt < 200 && !existsSync(childPidPath); attempt++) {
  await delay(5);
}
if (!existsSync(childPidPath)) throw new Error("managed fixture child did not start");

const coordinator = new ShutdownCoordinator({
  stopAccepting: () => {},
  stopEngine: async () => {
    controller.abort();
    await stubbornChild.catch(() => {});
    return { stoppedProjectIds: ["fixture-project"], settled: true };
  },
  stopTelegram: () => {},
  flushLogs: () => {},
  recordAudit: (reason, result) => {
    repo.updateProject(db, "fixture-project", { status: "paused" });
    repo.createAuditEntry(db, {
      projectId: "fixture-project",
      kind: "shutdown",
      actor: "engine",
      summary: `Fixture stopped for ${reason}`,
      detail: result,
    });
  },
  closeServer: () => {},
  checkpointDb: () => {
    db.pragma("wal_checkpoint(TRUNCATE)");
  },
  closeDb: () => {
    db.close();
  },
  log: () => {},
  exit: (code) => process.exit(code),
});
coordinator.markRunning();
installShutdownHandlers(coordinator);

writeFileSync(`${childPidPath}.ready`, "ready");
process.stdout.write("READY\n");
if (mode === "fatal") {
  setTimeout(() => {
    throw new Error("fixture fatal error");
  }, 20);
}
