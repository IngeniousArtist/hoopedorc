import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultSettings, ENV } from "./config.js";
import { initDb } from "./db/index.js";
import * as repo from "./db/repo.js";
import { EngineRunner } from "./engine-runner.js";
import {
  buildApp,
  type BuildAppDependencies,
} from "./index.js";
import { SelfUpdater } from "./self-update.js";
import { WsHub } from "./ws-hub.js";

const PROCESS_EVENTS = [
  "SIGTERM",
  "SIGINT",
  "uncaughtException",
  "unhandledRejection",
] as const;

function listenerCounts(): number[] {
  return PROCESS_EVENTS.map((event) => process.listenerCount(event));
}

function dependencies(
  root: string,
): BuildAppDependencies {
  const db = initDb(":memory:");
  repo.upsertSettings(db, defaultSettings());
  repo.createProject(db, {
    id: "project-1",
    name: "Injected app",
    repoUrl: "https://github.com/example/injected-app",
    defaultBranch: "main",
    localPath: join(root, "project"),
    status: "created",
  });
  const hub = new WsHub();
  return {
    db,
    hub,
    engine: new EngineRunner(db, hub),
    selfUpdater: new SelfUpdater({
      repoRoot: root,
      mock: true,
      statusFile: join(root, "self-update.json"),
    }),
    env: {
      ...ENV,
      host: "127.0.0.1",
      mock: true,
      apiToken: undefined,
      allowUnauthenticated: false,
      dbPath: ":memory:",
      dbBackupDir: join(root, "backups"),
    },
    repoRoot: root,
    version: "test",
    logger: false,
  };
}

test("O27: buildApp injects routes without process handlers or startup services", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-build-app-"));
  const before = listenerCounts();

  try {
    for (let iteration = 0; iteration < 3; iteration++) {
      const deps = dependencies(root);
      const staleApproval = repo.createNotification(deps.db, {
        id: `stale-${iteration}`,
        projectId: "project-1",
        severity: "action_required",
        title: "Stale approval",
        message: "must remain untouched until production startup",
        requiresApproval: true,
        options: ["approve", "reject"],
      });

      const app = await buildApp(deps);
      try {
        const response = await app.inject({
          method: "GET",
          url: "/api/projects",
        });
        assert.equal(response.statusCode, 200);
        assert.deepEqual(
          response.json<{ projects: Array<{ id: string }> }>().projects.map(
            (project) => project.id,
          ),
          ["project-1"],
        );
        assert.equal(
          repo.getNotification(deps.db, staleApproval.id)?.respondedWith,
          undefined,
          "buildApp must not run the boot-time stale-approval sweep",
        );
        assert.deepEqual(listenerCounts(), before);
      } finally {
        await app.close();
        deps.db.close();
      }
      assert.deepEqual(listenerCounts(), before);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
