import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { DraftTask, VerifiedFigmaReference } from "@orc/types";
import { defaultSettings, ENV } from "./config.js";
import { initDb } from "./db/index.js";
import * as repo from "./db/repo.js";
import { EngineRunner } from "./engine-runner.js";
import { buildApp, type BuildAppDependencies } from "./index.js";
import {
  MOCK_PLANNER_FAILURE_TOKEN,
  MOCK_PLANNER_REPLY_PREFIX,
} from "./mock-planner.js";
import { SelfUpdater } from "./self-update.js";
import { WsHub } from "./ws-hub.js";

const pexecFile = promisify(execFile);
const PROJECT_ID = "project-1";
const FAKE_REPLY = "FAKE PRODUCTION PLANNER REPLY";

/**
 * A stand-in for every planner CLI. It records that it ran (a file beside
 * itself, since the planner's sanitized env drops custom variables) and
 * answers in the `claude -p --output-format json` envelope.
 */
const FAKE_CLI = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const name = path.basename(process.argv[1]);
fs.writeFileSync(path.join(path.dirname(process.argv[1]), "invoked-" + name), "1");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ result: ${JSON.stringify(FAKE_REPLY)}, total_cost_usd: 0.01 }));
});
`;

interface Fixture {
  root: string;
  bin: string;
  deps: BuildAppDependencies;
  invokedClis(): string[];
  restore(): void;
}

function fixture(options: { mock: boolean; localPath: string }): Fixture {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-planning-routes-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const name of ["claude", "codex", "opencode"]) {
    const file = join(bin, name);
    writeFileSync(file, FAKE_CLI);
    chmodSync(file, 0o755);
  }
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath ?? ""}`;

  const db = initDb(":memory:");
  repo.upsertSettings(db, defaultSettings());
  repo.createProject(db, {
    id: PROJECT_ID,
    name: "Planning routes",
    repoUrl: "https://github.com/example/planning-routes",
    defaultBranch: "main",
    localPath: options.localPath,
    status: "paused",
  });
  const hub = new WsHub();
  const deps: BuildAppDependencies = {
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
      mock: options.mock,
      apiToken: undefined,
      allowUnauthenticated: false,
      dbPath: ":memory:",
      dbBackupDir: join(root, "backups"),
    },
    repoRoot: root,
    version: "test",
    logger: false,
    planningGitPersistence: { commitFiles: () => Promise.resolve() },
  };
  return {
    root,
    bin,
    deps,
    invokedClis: () =>
      readdirSync(bin)
        .filter((name) => name.startsWith("invoked-"))
        .map((name) => name.slice("invoked-".length))
        .sort(),
    restore: () => {
      process.env.PATH = savedPath;
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function currentRevision(
  app: Awaited<ReturnType<typeof buildApp>>,
): Promise<string> {
  const session = await app.inject({
    method: "GET",
    url: `/api/projects/${PROJECT_ID}/plan/session`,
  });
  assert.equal(session.statusCode, 200);
  return session.json<{ revisionId: string }>().revisionId;
}

test("VW01: mock planning chat and deconstruction never reach a CLI, a clone, or the project path", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-planning-mock-root-"));
  const localPath = join(root, "never-cloned");
  const fx = fixture({ mock: true, localPath });
  const app = await buildApp(fx.deps);
  try {
    const revisionId = await currentRevision(app);
    const messages = [{ role: "user", content: "Add an API health endpoint." }];

    const chat = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/plan/chat`,
      payload: { revisionId, messages },
    });
    assert.equal(chat.statusCode, 200, chat.body);
    const chatBody = chat.json<{ reply: string; costUsd: number }>();
    assert.ok(chatBody.reply.startsWith(MOCK_PLANNER_REPLY_PREFIX));
    assert.match(chatBody.reply, /\[PLAN_COMPLETE\]$/);
    assert.equal(chatBody.costUsd, 0);
    assert.equal(repo.getPlanningSession(fx.deps.db, PROJECT_ID).messages.length, 2);

    const transcript = [
      ...messages,
      { role: "assistant", content: chatBody.reply },
    ];
    const deconstruct = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/plan/deconstruct`,
      payload: { revisionId, messages: transcript },
    });
    assert.equal(deconstruct.statusCode, 200, deconstruct.body);
    const plan = deconstruct.json<{
      prdMarkdown: string;
      tasks: DraftTask[];
      costUsd: number;
      agentsMd?: string;
      verifiedFigmaReferences?: VerifiedFigmaReference[];
    }>();
    assert.equal(plan.costUsd, 0);
    assert.match(plan.prdMarkdown, /^# PRD: Planning routes/);
    assert.match(plan.agentsMd ?? "", /^# AGENTS\.md/);
    assert.equal(plan.verifiedFigmaReferences, undefined);
    assert.deepEqual(
      plan.tasks.map((task) => task.title),
      [
        "Implement: Add an API health endpoint.",
        "Add regression coverage: Add an API health endpoint.",
        "Project documentation",
      ],
    );
    assert.deepEqual(plan.tasks[1]?.dependsOn, [0]);
    assert.deepEqual(plan.tasks[2]?.dependsOn, [0, 1]);
    assert.equal(plan.tasks[2]?.role, "docs");
    for (const task of plan.tasks) {
      assert.equal(typeof task.assignedModel, "string");
      assert.ok(task.assignedModel.length > 0);
    }
    const persisted = repo.getPlanningSession(fx.deps.db, PROJECT_ID);
    assert.equal(persisted.draftTasks?.length, 3);
    assert.equal(persisted.prd, plan.prdMarkdown);

    // Deterministic: the same transcript yields the same plan.
    const again = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/plan/deconstruct`,
      payload: { revisionId, messages: transcript },
    });
    assert.deepEqual(again.json(), plan);

    assert.deepEqual(fx.invokedClis(), [], "mock planning must not spawn a planner CLI");
    assert.equal(existsSync(localPath), false, "mock planning must not clone the project");
  } finally {
    await app.close();
    fx.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("VW01: mock routes keep the real revision, lock, and validation guards", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-planning-mock-guards-"));
  const fx = fixture({ mock: true, localPath: join(root, "never-cloned") });
  const app = await buildApp(fx.deps);
  try {
    const revisionId = await currentRevision(app);
    const messages = [{ role: "user", content: "Anything" }];

    const missingRevision = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/plan/chat`,
      payload: { messages },
    });
    assert.equal(missingRevision.statusCode, 400);

    const stale = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/plan/chat`,
      payload: { revisionId: "11111111-1111-4111-8111-111111111111", messages },
    });
    assert.equal(stale.statusCode, 409);
    assert.match(stale.json<{ error: string }>().error, /stale/);

    const staleDeconstruct = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/plan/deconstruct`,
      payload: { revisionId: "11111111-1111-4111-8111-111111111111", messages },
    });
    assert.equal(staleDeconstruct.statusCode, 409);

    const empty = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/plan/chat`,
      payload: { revisionId, messages: [] },
    });
    assert.equal(empty.statusCode, 400);

    const badMode = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/plan/deconstruct`,
      payload: { revisionId, messages, figmaVerification: "sometimes" },
    });
    assert.equal(badMode.statusCode, 400);

    const noAttachments = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/plan/deconstruct`,
      payload: { revisionId, messages, figmaVerification: "attachments" },
    });
    assert.equal(noAttachments.statusCode, 400);

    repo.updateProject(fx.deps.db, PROJECT_ID, { status: "running" });
    const locked = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/plan/chat`,
      payload: { revisionId, messages },
    });
    assert.equal(locked.statusCode, 409);
    assert.match(locked.json<{ error: string }>().error, /running/);

    assert.equal(repo.getPlanningSession(fx.deps.db, PROJECT_ID).messages.length, 0);
    assert.deepEqual(fx.invokedClis(), []);
  } finally {
    await app.close();
    fx.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("VW01: mock failure fixtures surface through the production error envelopes", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-planning-mock-failures-"));
  const fx = fixture({ mock: true, localPath: join(root, "never-cloned") });
  const app = await buildApp(fx.deps);
  try {
    const revisionId = await currentRevision(app);
    const failing = [
      { role: "user", content: `Plan this ${MOCK_PLANNER_FAILURE_TOKEN}` },
    ];

    const chat = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/plan/chat`,
      payload: { revisionId, messages: failing },
    });
    assert.equal(chat.statusCode, 502);
    assert.match(
      chat.json<{ error: string }>().error,
      /^planner chat failed: mock planner chat failure fixture/,
    );
    assert.equal(
      repo.getPlanningSession(fx.deps.db, PROJECT_ID).messages.length,
      0,
      "a failed turn must not be persisted as accepted",
    );

    const deconstruct = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/plan/deconstruct`,
      payload: { revisionId, messages: failing },
    });
    assert.equal(deconstruct.statusCode, 502);
    assert.match(
      deconstruct.json<{ error: string }>().error,
      /^deconstruction failed: mock planner deconstruct failure fixture/,
    );

    const figma = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/plan/deconstruct`,
      payload: {
        revisionId,
        messages: [
          {
            role: "user",
            content:
              "Match https://www.figma.com/design/MOCKFAIL-figma_auth_required/Login?node-id=10-20",
          },
        ],
      },
    });
    assert.equal(figma.statusCode, 409);
    const failure = figma.json<{
      error: string;
      code: string;
      details: { costUsd: number; issue: { code: string; nodeId?: string; actions: string[] } };
    }>();
    assert.equal(failure.code, "FIGMA_VERIFICATION_FAILED");
    assert.equal(failure.details.issue.code, "figma_auth_required");
    assert.equal(failure.details.issue.nodeId, "10:20");
    assert.equal(failure.details.costUsd, 0);
    assert.ok(failure.details.issue.actions.length > 0);
    assert.equal(
      repo.getPlanningSession(fx.deps.db, PROJECT_ID).verifiedFigmaReferences,
      undefined,
    );
    assert.deepEqual(fx.invokedClis(), []);
  } finally {
    await app.close();
    fx.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("VW01: mock Figma verification persists exact references and inserts the generated visual QA task", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-planning-mock-figma-"));
  const fx = fixture({ mock: true, localPath: join(root, "never-cloned") });
  const app = await buildApp(fx.deps);
  try {
    const revisionId = await currentRevision(app);
    const messages = [
      {
        role: "user",
        content: "Match https://www.figma.com/design/File123/Login?node-id=10-20 for login",
      },
    ];
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/plan/deconstruct`,
      payload: { revisionId, messages },
    });
    assert.equal(response.statusCode, 200, response.body);
    const plan = response.json<{
      tasks: DraftTask[];
      verifiedFigmaReferences?: VerifiedFigmaReference[];
    }>();
    assert.equal(plan.verifiedFigmaReferences?.length, 1);
    const reference = plan.verifiedFigmaReferences?.[0];
    assert.equal(reference?.canonicalUrl, "https://www.figma.com/design/File123/Login?node-id=10-20");
    assert.equal(reference?.nodeId, "10:20");
    assert.equal(reference?.verifiedModel, "claude");
    assert.equal(reference?.verifiedRunner, "claude-code");
    assert.ok(Number.isFinite(Date.parse(reference?.verifiedAt ?? "")));

    assert.deepEqual(
      plan.tasks.map((task) => task.title),
      [
        "Implement: Match the referenced design for login",
        "Add regression coverage: Match the referenced design for login",
        "Visual fidelity QA",
        "Project documentation",
      ],
    );
    const visualQa = plan.tasks[2];
    assert.equal(visualQa?.generatedTaskKind, "visual-qa");
    assert.equal(visualQa?.role, "frontend");
    assert.deepEqual(visualQa?.dependsOn, [0, 1]);
    assert.deepEqual(plan.tasks[3]?.dependsOn, [0, 1, 2]);
    assert.equal(plan.tasks[0]?.role, "frontend");
    assert.match(plan.tasks[0]?.description ?? "", /### Relevant references/);
    assert.ok(
      plan.tasks.every((task) => task.generatedTaskKind === undefined || task.title === "Visual fidelity QA"),
    );

    const persisted = repo.getPlanningSession(fx.deps.db, PROJECT_ID);
    assert.deepEqual(persisted.verifiedFigmaReferences, plan.verifiedFigmaReferences);
    assert.equal(persisted.draftTasks?.length, 4);
    assert.deepEqual(fx.invokedClis(), []);
  } finally {
    await app.close();
    fx.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("VW01: the legacy single-shot plan route also stays inside the mock planner", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-planning-mock-legacy-"));
  const localPath = join(root, "never-cloned");
  const fx = fixture({ mock: true, localPath });
  const app = await buildApp(fx.deps);
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/plan`,
      payload: { goal: "Add a health endpoint" },
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json<{ prdMarkdown: string; tasks: Array<{ title: string; status: string }> }>();
    assert.match(body.prdMarkdown, /Mock planner/);
    assert.deepEqual(
      body.tasks.map((task) => task.title),
      [
        "Implement: Add a health endpoint",
        "Add regression coverage: Add a health endpoint",
        "Project documentation",
      ],
    );
    assert.equal(repo.getProject(fx.deps.db, PROJECT_ID)?.status, "planned");
    assert.deepEqual(fx.invokedClis(), []);
    assert.equal(existsSync(localPath), false);
  } finally {
    await app.close();
    fx.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("VW01: real mode selects the production planner and reaches the CLI boundary (fake CLI, no paid call)", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-planning-real-root-"));
  // An existing clone with a remote keeps ensureClone offline: it only runs
  // `git remote get-url origin` and never attempts a network clone.
  const localPath = join(root, "clone");
  mkdirSync(localPath);
  await pexecFile("git", ["init", "--quiet"], { cwd: localPath, encoding: "utf8" });
  await pexecFile(
    "git",
    ["remote", "add", "origin", "https://github.com/example/planning-routes"],
    { cwd: localPath, encoding: "utf8" },
  );
  const fx = fixture({ mock: false, localPath });
  const app = await buildApp(fx.deps);
  try {
    const revisionId = await currentRevision(app);
    const chat = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/plan/chat`,
      payload: {
        revisionId,
        messages: [{ role: "user", content: "Add an API health endpoint." }],
      },
    });
    assert.equal(chat.statusCode, 200, chat.body);
    const body = chat.json<{ reply: string; costUsd: number }>();
    assert.equal(body.reply, FAKE_REPLY);
    assert.equal(body.costUsd, 0.01);
    assert.doesNotMatch(body.reply, new RegExp(MOCK_PLANNER_REPLY_PREFIX.slice(0, 12)));
    assert.deepEqual(fx.invokedClis(), ["claude"], "real mode must route to the routed planner CLI");
    assert.equal(repo.getPlanningSession(fx.deps.db, PROJECT_ID).messages.length, 2);
  } finally {
    await app.close();
    fx.restore();
    rmSync(root, { recursive: true, force: true });
  }
});
