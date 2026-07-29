import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
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
const pexecFile = promisify(execFile);
const MATCHING_ORIGIN = "https://github.com/example/project";

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

async function makeRepo(
  parent: string,
  name: string,
  origin = MATCHING_ORIGIN,
): Promise<string> {
  const path = join(parent, name);
  mkdirSync(path);
  await pexecFile("git", ["init", "--quiet"], {
    cwd: path,
    encoding: "utf8",
  });
  await pexecFile("git", ["remote", "add", "origin", origin], {
    cwd: path,
    encoding: "utf8",
  });
  return path;
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

test("O27: injected auth is optional on loopback and enforced when configured", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-auth-routes-"));
  try {
    const openDeps = dependencies(root);
    const openApp = await buildApp(openDeps);
    try {
      assert.equal(
        (await openApp.inject({ method: "GET", url: "/api/projects" }))
          .statusCode,
        200,
      );
    } finally {
      await openApp.close();
      openDeps.db.close();
    }

    const protectedDeps = dependencies(root);
    protectedDeps.env = {
      ...protectedDeps.env,
      apiToken: "route-secret",
    };
    const protectedApp = await buildApp(protectedDeps);
    try {
      assert.equal(
        (await protectedApp.inject({ method: "GET", url: "/api/projects" }))
          .statusCode,
        401,
      );
      assert.equal(
        (
          await protectedApp.inject({
            method: "GET",
            url: "/api/projects",
            headers: { authorization: "Bearer wrong" },
          })
        ).statusCode,
        401,
      );
      assert.equal(
        (
          await protectedApp.inject({
            method: "GET",
            url: "/api/projects",
            headers: { authorization: "Bearer route-secret" },
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (await protectedApp.inject({ method: "GET", url: "/api/health" }))
          .statusCode,
        200,
        "health remains available without a bearer token",
      );
    } finally {
      await protectedApp.close();
      protectedDeps.db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("O27: non-loopback app construction fails closed without explicit auth", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-auth-binding-"));
  try {
    const refused = dependencies(root);
    refused.env = {
      ...refused.env,
      host: "0.0.0.0",
      apiToken: undefined,
      allowUnauthenticated: false,
    };
    await assert.rejects(() => buildApp(refused), /API_TOKEN/);
    refused.db.close();

    const authenticated = dependencies(root);
    authenticated.env = {
      ...authenticated.env,
      host: "0.0.0.0",
      apiToken: "secret",
      allowUnauthenticated: false,
    };
    const app = await buildApp(authenticated);
    await app.close();
    authenticated.db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("O27: project creation route enforces config, Git, and filesystem guards", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-create-routes-"));
  const deps = dependencies(root);
  const app = await buildApp(deps);
  try {
    const request = (payload: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: "/api/projects",
        payload,
      });

    assert.equal((await request({ repoUrl: MATCHING_ORIGIN })).statusCode, 400);
    assert.equal(
      (
        await request({
          name: "Bad URL",
          repoUrl: "--upload-pack=payload",
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await request({
          name: "Bad branch",
          repoUrl: MATCHING_ORIGIN,
          defaultBranch: "-main",
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await request({
          name: "Bad config",
          repoUrl: MATCHING_ORIGIN,
          config: [],
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await request({
          name: "Unsafe path",
          repoUrl: MATCHING_ORIGIN,
          localPath: deps.env.reposDir,
        })
      ).statusCode,
      400,
    );

    const unmanaged = join(root, "unmanaged");
    mkdirSync(unmanaged);
    writeFileSync(join(unmanaged, "operator.txt"), "keep");
    assert.equal(
      (
        await request({
          name: "Occupied path",
          repoUrl: MATCHING_ORIGIN,
          localPath: unmanaged,
        })
      ).statusCode,
      400,
    );

    const created = await request({
      name: "Valid project",
      repoUrl: MATCHING_ORIGIN,
      localPath: join(root, "new-project"),
      config: { maxAttempts: 4 },
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(
      created.json<{ project: { config?: { maxAttempts?: number } } }>()
        .project.config?.maxAttempts,
      4,
    );
  } finally {
    await app.close();
    deps.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("O27: project deletion removes only clean managed clones", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-delete-routes-"));
  const deps = dependencies(root);
  const cases: Array<{
    id: string;
    localPath: string;
    shouldDeleteFiles: boolean;
  }> = [];

  try {
    const clean = await makeRepo(root, "clean");
    cases.push({ id: "delete-clean", localPath: clean, shouldDeleteFiles: true });

    const dirty = await makeRepo(root, "dirty");
    writeFileSync(join(dirty, "operator.txt"), "keep");
    cases.push({ id: "keep-dirty", localPath: dirty, shouldDeleteFiles: false });

    const wrong = await makeRepo(
      root,
      "wrong",
      "https://github.com/example/other",
    );
    cases.push({ id: "keep-wrong", localPath: wrong, shouldDeleteFiles: false });

    const unmanaged = join(root, "unmanaged");
    mkdirSync(unmanaged);
    writeFileSync(join(unmanaged, "operator.txt"), "keep");
    cases.push({
      id: "keep-unmanaged",
      localPath: unmanaged,
      shouldDeleteFiles: false,
    });

    const symlinkTarget = await makeRepo(root, "symlink-target");
    const symlink = join(root, "symlink");
    symlinkSync(symlinkTarget, symlink, "dir");
    cases.push({
      id: "keep-symlink",
      localPath: symlink,
      shouldDeleteFiles: false,
    });

    const parentRepo = await makeRepo(root, "parent");
    const nested = await makeRepo(parentRepo, "nested");
    cases.push({
      id: "keep-nested",
      localPath: nested,
      shouldDeleteFiles: false,
    });

    const primaryWithDirtyWorktree = await makeRepo(root, "with-worktree");
    const dirtyWorktree = await makeRepo(root, "with-worktree-wt-task");
    writeFileSync(join(dirtyWorktree, "operator.txt"), "keep");
    cases.push({
      id: "keep-dirty-worktree",
      localPath: primaryWithDirtyWorktree,
      shouldDeleteFiles: false,
    });

    for (const fixture of cases) {
      repo.createProject(deps.db, {
        id: fixture.id,
        name: fixture.id,
        repoUrl: MATCHING_ORIGIN,
        defaultBranch: "main",
        localPath: fixture.localPath,
        status: "created",
      });
    }

    const app = await buildApp(deps);
    try {
      assert.equal(
        (
          await app.inject({
            method: "DELETE",
            url: "/api/projects/missing",
          })
        ).statusCode,
        404,
      );
      for (const fixture of cases) {
        const response = await app.inject({
          method: "DELETE",
          url: `/api/projects/${fixture.id}`,
        });
        assert.equal(response.statusCode, 204, fixture.id);
        assert.equal(repo.getProject(deps.db, fixture.id), null, fixture.id);
        assert.equal(
          existsSync(fixture.localPath),
          !fixture.shouldDeleteFiles,
          fixture.id,
        );
      }
      assert.equal(
        existsSync(symlinkTarget),
        true,
        "a refused symlink must not delete its target",
      );
      assert.equal(
        existsSync(dirtyWorktree),
        true,
        "one dirty matching worktree must preserve the whole disk cleanup set",
      );
    } finally {
      await app.close();
    }
  } finally {
    deps.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("O27: project deletion refuses an active runtime before disk or DB mutation", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-active-delete-"));
  const deps = dependencies(root);
  deps.engine = {
    hasActivity: () => true,
  } as unknown as EngineRunner;
  const app = await buildApp(deps);
  try {
    const response = await app.inject({
      method: "DELETE",
      url: "/api/projects/project-1",
    });
    assert.equal(response.statusCode, 409);
    assert.notEqual(repo.getProject(deps.db, "project-1"), null);
  } finally {
    await app.close();
    deps.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("O27: the real main entrypoint listens and shuts down cleanly", async () => {
  const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
  const child = spawn(
    process.execPath,
    ["--import", "tsx", entry],
    {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      env: {
        ...process.env,
        ALLOW_UNAUTHENTICATED: "",
        API_TOKEN: "",
        HOST: "127.0.0.1",
        MOCK: "1",
        PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const closed = once(child, "close") as Promise<
    [number | null, NodeJS.Signals | null]
  >;
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

  for (
    let attempt = 0;
    attempt < 300 && !stdout.includes("hoopedorc server up");
    attempt++
  ) {
    await new Promise<void>((resolvePromise) =>
      setTimeout(resolvePromise, 10),
    );
    if (child.exitCode !== null) break;
  }
  assert.match(stdout, /hoopedorc server up/, stderr);
  child.kill("SIGTERM");
  const [code, signal] = await closed;
  assert.equal(signal, null, stderr);
  assert.equal(code, 0, stderr);
  assert.match(stdout, /shutdown complete: SIGTERM \(exit 0/);
});
