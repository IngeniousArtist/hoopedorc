import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { PlanOperationResponse, DraftTask, PlanChatResponse, PlanDeconstructResponse, RepositoryInspection, VerifiedFigmaReference } from "@orc/types";
import { defaultSettings, ENV } from "./config.js";
import { initDb } from "./db/index.js";
import * as repo from "./db/repo.js";
import { EngineRunner } from "./engine-runner.js";
import { buildApp, type BuildAppDependencies } from "./index.js";
import {
  MOCK_PLANNER_FAILURE_TOKEN,
  MOCK_PLANNER_REPLY_PREFIX,
  MOCK_REPOSITORY_COMMIT,
} from "./mock-planner.js";
import { SelfUpdater } from "./self-update.js";
import { WsHub } from "./ws-hub.js";

const pexecFile = promisify(execFile);
const PROJECT_ID = "project-1";
const FAKE_REPLY = "FAKE PRODUCTION PLANNER REPLY";

/**
 * A stand-in for every planner CLI. It records that it ran (a file beside
 * itself, since the planner's sanitized env drops custom variables), saves
 * the prompt it received (VW03 asserts on repository-aware prompt text), and
 * answers in the `claude -p --output-format json` envelope — a canned reply
 * for chat prompts, a minimal valid plan for deconstruction prompts.
 */
const FAKE_PLAN = {
  prd: "# Fake PRD",
  agentsMd: "# Fake AGENTS",
  tasks: [
    {
      title: "Fake task",
      description: "From the fake CLI.",
      difficulty: "medium",
      role: null,
      acceptanceCriteria: ["It works"],
      dependsOn: [],
      scopePaths: ["src/**"],
    },
  ],
};
const FAKE_CLI = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const name = path.basename(process.argv[1]);
const dir = path.dirname(process.argv[1]);
fs.writeFileSync(path.join(dir, "invoked-" + name), "1");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const seq = fs.readdirSync(dir).filter((f) => f.startsWith("prompt-")).length + 1;
  fs.writeFileSync(path.join(dir, "prompt-" + String(seq).padStart(3, "0") + ".txt"), input);
  const result = input.includes("Respond with ONLY a JSON object")
    ? JSON.stringify(${JSON.stringify(FAKE_PLAN)})
    : ${JSON.stringify(FAKE_REPLY)};
  process.stdout.write(JSON.stringify({ result, total_cost_usd: 0.01 }));
});
`;

interface Fixture {
  root: string;
  bin: string;
  deps: BuildAppDependencies;
  invokedClis(): string[];
  /** Prompts the fake CLI received, oldest first. */
  prompts(): string[];
  restore(): void;
}

function fixture(options: { mock: boolean; localPath: string; repoUrl?: string }): Fixture {
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
    repoUrl: options.repoUrl ?? "https://github.com/example/planning-routes",
    defaultBranch: "main",
    localPath: options.localPath,
    status: "paused",
    prdPath: "docs/PRD.md",
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
    prompts: () =>
      readdirSync(bin)
        .filter((name) => name.startsWith("prompt-"))
        .sort()
        .map((name) => readFileSync(join(bin, name), "utf8")),
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
      sessionVersion?: number;
      prdMarkdown: string;
      tasks: DraftTask[];
      costUsd: number;
      agentsMd?: string;
      verifiedFigmaReferences?: VerifiedFigmaReference[];
      repository?: RepositoryInspection;
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

    // Deterministic: the same transcript yields the same plan (the mock
    // inspection is identical apart from its timestamp).
    const again = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/plan/deconstruct`,
      payload: { revisionId, messages: transcript },
    });
    const stripInspectedAt = (value: typeof plan & { repository?: RepositoryInspection }) => ({
      ...value,
      sessionVersion: 0, // generation advances the session version even for identical text
      repository: value.repository ? { ...value.repository, inspectedAt: "x" } : undefined,
    });
    assert.equal(again.json<PlanDeconstructResponse>().sessionVersion, plan.sessionVersion! + 1);
    assert.deepEqual(stripInspectedAt(again.json()), stripInspectedAt(plan));
    assert.equal(plan.repository?.commit, MOCK_REPOSITORY_COMMIT);
    assert.equal(repo.getPlanningSession(fx.deps.db, PROJECT_ID).repository?.commit, MOCK_REPOSITORY_COMMIT);

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
    const body = chat.json<{ reply: string; costUsd: number; repository?: RepositoryInspection }>();
    assert.equal(body.reply, FAKE_REPLY);
    assert.equal(body.costUsd, 0.01);
    assert.equal(body.repository?.state, "empty", "an unborn clone is an empty repository");
    assert.equal(body.repository?.commit, undefined);
    assert.doesNotMatch(body.reply, new RegExp(MOCK_PLANNER_REPLY_PREFIX.slice(0, 12)));
    assert.deepEqual(fx.invokedClis(), ["claude"], "real mode must route to the routed planner CLI");
    assert.equal(repo.getPlanningSession(fx.deps.db, PROJECT_ID).messages.length, 2);
  } finally {
    await app.close();
    fx.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

async function gitIn(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await pexecFile(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
    { cwd, encoding: "utf8" },
  );
  return stdout.trim();
}

/** A local clone with an origin remote and one commit of the given files. */
async function committedRepo(path: string, files: Record<string, string>): Promise<string> {
  mkdirSync(path, { recursive: true });
  await gitIn(path, ["init", "--quiet", "-b", "main"]);
  await gitIn(path, ["remote", "add", "origin", "https://github.com/example/planning-routes"]);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(path, file, ".."), { recursive: true });
    writeFileSync(join(path, file), content);
  }
  await gitIn(path, ["add", "-A"]);
  await gitIn(path, ["commit", "--quiet", "-m", "init"]);
  return gitIn(path, ["rev-parse", "HEAD"]);
}

test("VW03: an unreachable repository is a typed 503 that keeps the session and spawns nothing; the retry succeeds once the clone exists", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-planning-unavailable-"));
  const localPath = join(root, "clone");
  const fx = fixture({
    mock: false,
    localPath,
    repoUrl: join(root, "missing-origin.git"),
  });
  const app = await buildApp(fx.deps);
  try {
    const revisionId = await currentRevision(app);
    const messages = [{ role: "user", content: "Add an API health endpoint." }];
    const failed = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/plan/chat`,
      payload: { revisionId, messages },
    });
    assert.equal(failed.statusCode, 503, failed.body);
    const failure = failed.json<{ error: string; code: string }>();
    assert.equal(failure.code, "REPOSITORY_UNAVAILABLE");
    assert.match(failure.error, /could not be reached or read/);
    assert.match(failure.error, /planning did not run/);
    assert.deepEqual(fx.invokedClis(), [], "no planner CLI may run without an inspected clone");
    assert.equal(repo.getPlanningSession(fx.deps.db, PROJECT_ID).messages.length, 0);
    assert.equal(repo.getPlanningSession(fx.deps.db, PROJECT_ID).repository, undefined);

    const deconstructFailed = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/plan/deconstruct`,
      payload: { revisionId, messages },
    });
    assert.equal(deconstructFailed.statusCode, 503);
    assert.equal(deconstructFailed.json<{ code: string }>().code, "REPOSITORY_UNAVAILABLE");

    const head = await committedRepo(localPath, {
      "README.md": "# Seed\n",
      "package.json": JSON.stringify({ name: "seed", private: true, version: "0.0.0" }),
    });
    const retried = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/plan/chat`,
      payload: { revisionId, messages },
    });
    assert.equal(retried.statusCode, 200, retried.body);
    const body = retried.json<{ reply: string; repository?: RepositoryInspection }>();
    assert.equal(body.reply, FAKE_REPLY);
    assert.equal(body.repository?.state, "empty");
    assert.equal(body.repository?.commit, head);
    assert.equal(body.repository?.branch, "main");
    assert.deepEqual(fx.invokedClis(), ["claude"]);
    const session = repo.getPlanningSession(fx.deps.db, PROJECT_ID);
    assert.equal(session.messages.length, 2);
    assert.equal(session.repository?.commit, head);
    assert.equal(session.repository?.state, "empty");
    const sessionResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT_ID}/plan/session`,
    });
    assert.equal(
      sessionResponse.json<{ repository?: RepositoryInspection }>().repository?.commit,
      head,
    );
  } finally {
    await app.close();
    fx.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("VW03: prompts describe an existing non-Node codebase without scaffolding and scaffold only a seed-only repository", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-planning-prompts-"));
  const existingPath = join(root, "existing");
  await committedRepo(existingPath, {
    "README.md": "# App\n",
    "package.json": JSON.stringify({ name: "seed", private: true, version: "0.0.0" }),
    "pyproject.toml": "[project]\nname = 'app'\n",
    "src/app/__init__.py": "VERSION = '1'\n",
    "tests/test_app.py": "def test_ok():\n    assert True\n",
  });
  const fx = fixture({ mock: false, localPath: existingPath });
  const app = await buildApp(fx.deps);
  try {
    const revisionId = await currentRevision(app);
    const messages = [{ role: "user", content: "Add a /health endpoint." }];
    const chat = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/plan/chat`,
      payload: { revisionId, messages },
    });
    assert.equal(chat.statusCode, 200, chat.body);
    const inspection = chat.json<{ repository?: RepositoryInspection }>().repository;
    assert.equal(inspection?.state, "existing");
    assert.deepEqual(inspection?.stack, ["python"]);
    assert.equal(inspection?.trackedFileCount, 3);
    const chatPrompt = fx.prompts().at(-1) ?? "";
    assert.match(chatPrompt, /This is an EXISTING codebase, not a new project/);
    assert.match(chatPrompt, /Detected stack: python/);
    assert.match(chatPrompt, /not a Node project \(python\)/);
    assert.doesNotMatch(chatPrompt, /brand-new project with no existing code/);

    const deconstruct = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/plan/deconstruct`,
      payload: {
        revisionId,
        messages: [...messages, { role: "assistant", content: "Ready. [PLAN_COMPLETE]" }],
      },
    });
    assert.equal(deconstruct.statusCode, 200, deconstruct.body);
    const deconstructPrompt = fx.prompts().at(-1) ?? "";
    assert.match(deconstructPrompt, /This is an EXISTING codebase, not a new project/);
    assert.doesNotMatch(deconstructPrompt, /Make the FIRST task in your task list a\s+scaffold task/);
    assert.doesNotMatch(deconstructPrompt, /npm test runs real tests and passes/);
    const tasks = deconstruct.json<{ tasks: DraftTask[] }>().tasks;
    assert.equal(tasks[0]?.title, "Fake task");
  } finally {
    await app.close();
    fx.restore();
  }

  const seedPath = join(root, "seed-only");
  await committedRepo(seedPath, {
    "README.md": "# Seed\n",
    "package.json": JSON.stringify({ name: "seed", private: true, version: "0.0.0" }),
    "docs/PRD.md": "# PRD\n",
  });
  const seedFx = fixture({ mock: false, localPath: seedPath });
  const seedApp = await buildApp(seedFx.deps);
  try {
    const revisionId = await currentRevision(seedApp);
    const deconstruct = await seedApp.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/plan/deconstruct`,
      payload: {
        revisionId,
        messages: [
          { role: "user", content: "Build a CLI in Go." },
          { role: "assistant", content: "Ready. [PLAN_COMPLETE]" },
        ],
      },
    });
    assert.equal(deconstruct.statusCode, 200, deconstruct.body);
    assert.equal(deconstruct.json<{ repository?: RepositoryInspection }>().repository?.state, "empty");
    const prompt = seedFx.prompts().at(-1) ?? "";
    assert.match(prompt, /The repository has NO application code yet/);
    assert.match(prompt, /Make the FIRST task in your task list a scaffold task/);
    assert.doesNotMatch(prompt, /EXISTING codebase/);
  } finally {
    await seedApp.close();
    seedFx.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("VW03: a plan drafted against an older revision is refused until acknowledged, and replay never re-inspects", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-planning-drift-"));
  const localPath = join(root, "clone");
  const planned = await committedRepo(localPath, {
    "README.md": "# App\n",
    "package.json": JSON.stringify({ name: "app", private: true, scripts: { test: "node --test" } }),
    "src/index.js": "export const ok = true;\n",
  });
  const fx = fixture({ mock: false, localPath });
  let gitCommits = 0;
  fx.deps.planningGitPersistence = {
    commitFiles() {
      gitCommits += 1;
      return Promise.resolve();
    },
  };
  const app = await buildApp(fx.deps);
  try {
    const revisionId = await currentRevision(app);
    const chat = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/plan/chat`,
      payload: { revisionId, messages: [{ role: "user", content: "Add logging." }] },
    });
    assert.equal(chat.statusCode, 200, chat.body);
    assert.equal(repo.getPlanningSession(fx.deps.db, PROJECT_ID).repository?.commit, planned);

    writeFileSync(join(localPath, "src", "other.js"), "export const moved = true;\n");
    await gitIn(localPath, ["add", "-A"]);
    await gitIn(localPath, ["commit", "--quiet", "-m", "someone else merged"]);
    const current = await gitIn(localPath, ["rev-parse", "HEAD"]);
    assert.notEqual(current, planned);

    const payload = {
      revisionId,
      prdMarkdown: "# Drift plan",
      tasks: [
        {
          title: "Add logging",
          description: "Log requests",
          difficulty: "medium",
          acceptanceCriteria: ["Requests are logged"],
          dependsOn: [],
          scopePaths: ["src/**"],
          assignedModel: "deepseek-flash",
        },
      ],
    };
    const refused = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/plan/commit`,
      payload,
    });
    assert.equal(refused.statusCode, 409, refused.body);
    const refusal = refused.json<{ code: string; error: string; details: { plannedCommit: string; currentCommit: string } }>();
    assert.equal(refusal.code, "REPOSITORY_DRIFT");
    assert.deepEqual(refusal.details, { plannedCommit: planned, currentCommit: current });
    assert.match(refusal.error, new RegExp(`moved from ${planned.slice(0, 7)} to ${current.slice(0, 7)}`));
    assert.equal(gitCommits, 0, "nothing was committed");
    assert.equal(repo.getTasks(fx.deps.db, PROJECT_ID).length, 0);
    assert.equal(repo.getProject(fx.deps.db, PROJECT_ID)?.status, "paused");

    const accepted = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/plan/commit`,
      payload: { ...payload, acknowledgeRepositoryDrift: true },
    });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(accepted.json<{ tasks: unknown[] }>().tasks.length, 1);
    assert.equal(gitCommits, 1);
    assert.equal(repo.getPlanningSession(fx.deps.db, PROJECT_ID).repository, undefined, "cleared with the scratch");

    // Replaying the same content without the acknowledgement returns the
    // stored receipt: a successful commit is never re-inspected or re-run.
    const replayed = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/plan/commit`,
      payload,
    });
    assert.equal(replayed.statusCode, 200, replayed.body);
    assert.deepEqual(replayed.json(), accepted.json());
    assert.equal(gitCommits, 1);
  } finally {
    await app.close();
    fx.restore();
    rmSync(root, { recursive: true, force: true });
  }
});


test("VW03 review: further chat cannot rebase the repository observation of an existing draft", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-draft-observation-"));
  const localPath = join(root, "clone");
  const planned = await committedRepo(localPath, { "src/app.py": "print('hello')" });
  const fx = fixture({ mock: false, localPath });
  const app = await buildApp(fx.deps);
  try {
    const revisionId = await currentRevision(app);
    const messages = [{ role: "user", content: "Add logging" }];
    const generated = await app.inject({ method: "POST", url: `/api/projects/${PROJECT_ID}/plan/deconstruct`, payload: { revisionId, messages } });
    assert.equal(generated.statusCode, 200, generated.body);
    writeFileSync(join(localPath, "src/app.py"), "print('changed')");
    await gitIn(localPath, ["add", "src/app.py"]);
    await gitIn(localPath, ["commit", "--quiet", "-m", "external change"]);
    const chat = await app.inject({ method: "POST", url: `/api/projects/${PROJECT_ID}/plan/chat`, payload: { revisionId, messages } });
    assert.equal(chat.statusCode, 200, chat.body);
    assert.notEqual(chat.json<PlanChatResponse>().repository?.commit, planned, "chat inspects the current repository");
    assert.equal(repo.getPlanningSession(fx.deps.db, PROJECT_ID).repository?.commit, planned, "draft stays anchored to its original observation");
    const committed = await app.inject({ method: "POST", url: `/api/projects/${PROJECT_ID}/plan/commit`, payload: { revisionId, ...generated.json<PlanDeconstructResponse>() } });
    assert.equal(committed.statusCode, 409, committed.body);
    assert.equal(committed.json<{ code: string }>().code, "PLANNING_STALE");
    const current = await app.inject({ method: "POST", url: `/api/projects/${PROJECT_ID}/plan/commit`, payload: { revisionId, ...generated.json<PlanDeconstructResponse>(), sessionVersion: repo.getPlanningSession(fx.deps.db, PROJECT_ID).sessionVersion } });
    assert.equal(current.statusCode, 409);
    assert.equal(current.json<{ code: string }>().code, "REPOSITORY_DRIFT");
  } finally {
    await app.close();
    fx.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("VW03 review: retry recovers a pending receipt after its own Git commit advances HEAD", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-pending-drift-"));
  const localPath = join(root, "clone");
  await committedRepo(localPath, { "src/app.py": "print('hello')" });
  const fx = fixture({ mock: false, localPath });
  let attempts = 0;
  let planningHead = "";
  fx.deps.planningGitPersistence = {
    async commitFiles() {
      attempts++;
      if (attempts === 1) {
        await gitIn(localPath, ["add", "-A"]);
        await gitIn(localPath, ["commit", "--quiet", "-m", "durable planning commit"]);
        planningHead = await gitIn(localPath, ["rev-parse", "HEAD"]);
        throw new Error("push temporarily unavailable");
      }
      assert.equal(await gitIn(localPath, ["rev-parse", "HEAD"]), planningHead);
    },
  };
  const app = await buildApp(fx.deps);
  try {
    const revisionId = await currentRevision(app);
    const generated = await app.inject({ method: "POST", url: `/api/projects/${PROJECT_ID}/plan/deconstruct`, payload: { revisionId, messages: [{ role: "user", content: "Add logging" }] } });
    assert.equal(generated.statusCode, 200, generated.body);
    const payload = { revisionId, ...generated.json<PlanDeconstructResponse>() };
    const first = await app.inject({ method: "POST", url: `/api/projects/${PROJECT_ID}/plan/commit`, payload });
    assert.equal(first.statusCode, 502, first.body);
    assert.equal(repo.getPlanningCommitReceipt(fx.deps.db, PROJECT_ID, revisionId)?.state, "pending");
    const changed = await app.inject({ method: "POST", url: `/api/projects/${PROJECT_ID}/plan/commit`, payload: { ...payload, prdMarkdown: "Different content" } });
    assert.equal(changed.statusCode, 409, changed.body);
    assert.equal(attempts, 1);
    const retried = await app.inject({ method: "POST", url: `/api/projects/${PROJECT_ID}/plan/commit`, payload });
    assert.equal(retried.statusCode, 200, retried.body);
    const replayed = await app.inject({ method: "POST", url: `/api/projects/${PROJECT_ID}/plan/commit`, payload });
    assert.equal(replayed.statusCode, 200, replayed.body);
    assert.deepEqual(replayed.json(), retried.json());
    assert.equal(attempts, 2);
    assert.equal(repo.getTasks(fx.deps.db, PROJECT_ID).length, payload.tasks.length);
  } finally {
    await app.close();
    fx.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, `timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function slowCli(fx: Fixture): void {
  const script = FAKE_CLI.replace(
    'process.stdout.write(JSON.stringify({ result, total_cost_usd: 0.01 }));',
    `const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "child-pid"), String(child.pid));
  const timer = setInterval(() => {
    if (!fs.existsSync(path.join(dir, "release"))) return;
    clearInterval(timer);
    child.kill();
    process.stdout.write(JSON.stringify({ result, total_cost_usd: 0 }));
  }, 20);`,
  );
  writeFileSync(join(fx.bin, "claude"), script);
}

// Cross the real HTTP/socket + managed fake-CLI boundary; no authenticated model.
test("VW06: disconnect does not cancel planning; replay, mutation guards, and cancellation retain one owner", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-vw06-http-"));
  const localPath = join(root, "clone");
  await committedRepo(localPath, { "src/app.ts": "export const app = true;" });
  const fx = fixture({ mock: false, localPath });
  slowCli(fx);
  const app = await buildApp(fx.deps);
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const revisionId = await currentRevision(app);
    const operationId = "66666666-6666-4666-8666-666666666666";
    const payload = { revisionId, operationId, sessionVersion: 0, messages: [{ role: "user", content: "Continue after disconnect" }] };
    const controller = new AbortController();
    const request = fetch(`${address}/api/projects/${PROJECT_ID}/plan/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: controller.signal }).catch(() => null);
    await until(() => existsSync(join(fx.bin, "child-pid")), "fake CLI started");
    controller.abort();
    await request;
    const status = () => app.inject({ method: "GET", url: `/api/projects/${PROJECT_ID}/plan/operations/${operationId}` });
    assert.equal((await status()).json<PlanOperationResponse>().operation.state, "running");
    assert.equal((await app.inject({ method: "GET", url: `/api/projects/wrong/plan/operations/${operationId}` })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: `/api/projects/${PROJECT_ID}/plan/save-draft`, payload: { revisionId, prdMarkdown: "Overwrite", tasks: [] } })).statusCode, 409);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/projects/${PROJECT_ID}` })).statusCode, 409);
    await assert.rejects(fx.deps.engine.start(repo.getProject(fx.deps.db, PROJECT_ID)!), /planning is active/);
    writeFileSync(join(fx.bin, "release"), "1");
    await until(async () => (await status()).json<PlanOperationResponse>().operation.state === "succeeded", "disconnected work completed");
    const replay = await app.inject({ method: "POST", url: `/api/projects/${PROJECT_ID}/plan/chat`, payload: { ...payload, background: true } });
    assert.equal(replay.statusCode, 202);
    assert.equal(replay.json<PlanOperationResponse>().operation.state, "succeeded");
    assert.equal(fx.prompts().length, 1);
    assert.equal(repo.getPlanningSession(fx.deps.db, PROJECT_ID).messages.length, 2);
    assert.equal(repo.getInvocations(fx.deps.db, { projectId: PROJECT_ID }).length, 1);
    assert.equal(replay.json<PlanOperationResponse>().operation.invocationIds.length, 1);

    rmSync(join(fx.bin, "release"));
    rmSync(join(fx.bin, "child-pid"));
    const next = await app.inject({ method: "POST", url: `/api/projects/${PROJECT_ID}/plan/chat`, payload: { ...payload, operationId: "77777777-7777-4777-8777-777777777777", sessionVersion: 1, background: true } });
    const nextId = next.json<PlanOperationResponse>().operation.id;
    await until(() => existsSync(join(fx.bin, "child-pid")), "second fake CLI started");
    const childPid = Number(readFileSync(join(fx.bin, "child-pid"), "utf8"));
    await app.inject({ method: "POST", url: `/api/projects/${PROJECT_ID}/plan/operations/${nextId}/cancel` });
    await until(async () => (await app.inject({ method: "GET", url: `/api/projects/${PROJECT_ID}/plan/operations/${nextId}` })).json<PlanOperationResponse>().operation.state === "cancelled", "cancel settled");
    await until(() => { try { process.kill(childPid, 0); return false; } catch { return true; } }, "child group stopped");
    assert.equal(repo.getPlanningSession(fx.deps.db, PROJECT_ID).sessionVersion, 1);
  } finally { await app.close(); fx.restore(); rmSync(root, { recursive: true, force: true }); }
});

test("VW06: shutdown settles a real process; reopening and explicit retry count both attempts once", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-vw06-restart-"));
  const localPath = join(root, "clone");
  await committedRepo(localPath, { "src/app.ts": "export const app = true;" });
  const fx = fixture({ mock: false, localPath });
  slowCli(fx);
  let app = await buildApp(fx.deps);
  try {
    const revisionId = await currentRevision(app);
    const accepted = await app.inject({ method: "POST", url: `/api/projects/${PROJECT_ID}/plan/chat`, payload: { revisionId, messages: [{ role: "user", content: "Recover me" }], background: true } });
    const id = accepted.json<PlanOperationResponse>().operation.id;
    await until(() => existsSync(join(fx.bin, "child-pid")), "CLI started before shutdown");
    await app.close();
    app = await buildApp(fx.deps);
    const restored = await app.inject({ method: "GET", url: `/api/projects/${PROJECT_ID}/plan/session` });
    assert.equal(restored.json<PlanOperationResponse>().operation.state, "interrupted");
    assert.equal(restored.json<PlanOperationResponse>().operation.input.messages[0]?.content, "Recover me");
    assert.equal(fx.prompts().length, 1, "reopening does not automatically call a model");
    const retryUrl = `/api/projects/${PROJECT_ID}/plan/operations/${id}/retry`;
    const retry = await app.inject({ method: "POST", url: retryUrl });
    const retryId = retry.json<PlanOperationResponse>().operation.id;
    assert.notEqual(retryId, id);
    assert.equal((await app.inject({ method: "POST", url: retryUrl })).json<PlanOperationResponse>().operation.id, retryId);
    writeFileSync(join(fx.bin, "release"), "1");
    await until(async () => (await app.inject({ method: "GET", url: `/api/projects/${PROJECT_ID}/plan/operations/${retryId}` })).json<PlanOperationResponse>().operation.state === "succeeded", "retry completed");
    const invocations = repo.getInvocations(fx.deps.db, { projectId: PROJECT_ID });
    assert.equal(invocations.length, 2);
    assert.ok(invocations.every((invocation) => invocation.outcome !== "running"));
    assert.equal(invocations.reduce((sum, invocation) => sum + invocation.costUsd, 0), 0, "zero-cost calls are still individually counted");
    assert.equal(repo.getPlanningSession(fx.deps.db, PROJECT_ID).messages.length, 2);
    assert.equal((await app.inject({ method: "POST", url: retryUrl })).json<PlanOperationResponse>().operation.id, retryId);
    assert.equal(repo.getInvocations(fx.deps.db, { projectId: PROJECT_ID }).length, 2);
  } finally { await app.close(); fx.restore(); rmSync(root, { recursive: true, force: true }); }
});

test("VW07: proposal planning runs beside execution; review refuses active/stale apply and replays safely", async () => {
  const fx = fixture({ mock: true, localPath: "/unused" });
  const app = await buildApp(fx.deps);
  const db = fx.deps.db;
  try {
    const revisionId = (await app.inject({ method: "GET", url: `/api/projects/${PROJECT_ID}/plan/session` })).json<{ revisionId: string }>().revisionId;
    repo.updateProject(db, PROJECT_ID, { status: "running" });
    const chat = await app.inject({ method: "POST", url: `/api/projects/${PROJECT_ID}/plan/chat`, payload: { revisionId, proposal: true, messages: [{ role: "user", content: "Add a health check" }] } });
    assert.equal(chat.statusCode, 200, chat.body);
    assert.equal(repo.getProject(db, PROJECT_ID)?.status, "running");
    const generated = await app.inject({ method: "POST", url: `/api/projects/${PROJECT_ID}/plan/deconstruct`, payload: { revisionId, proposal: true, sessionVersion: chat.json<PlanChatResponse>().sessionVersion, messages: [{ role: "user", content: "Add a health check" }] } });
    assert.equal(generated.statusCode, 200, generated.body);
    const draft = generated.json<PlanDeconstructResponse>();
    const context = (await app.inject({ method: "GET", url: `/api/projects/${PROJECT_ID}/plan/changes` })).json<import("@orc/types").PlanChangeContextResponse>();
    const reviewed = await app.inject({ method: "POST", url: `/api/projects/${PROJECT_ID}/plan/changes/review`, payload: {
      ...draft, revisionId, taskGeneration: context.taskGeneration, tasks: draft.tasks.map((t) => ({ ...t, existingDependsOn: [] })),
    } });
    assert.equal(reviewed.statusCode, 200, reviewed.body);
    const review = reviewed.json<import("@orc/types").PlanChangeReviewResponse>().review;
    const apply = () => app.inject({ method: "POST", url: `/api/projects/${PROJECT_ID}/plan/changes/apply`, payload: { reviewId: review.id } });
    const busy = await apply(); assert.equal(busy.statusCode, 409, busy.body);
    assert.equal(busy.json<{ code: string }>().code, "EXECUTION_ACTIVE");
    repo.updateProject(db, PROJECT_ID, { status: "paused" });
    const applied = await apply(); assert.equal(applied.statusCode, 200, applied.body);
    assert.equal(repo.getProject(db, PROJECT_ID)?.status, "paused");
    assert.equal(repo.getTasks(db, PROJECT_ID).length, draft.tasks.length);
    assert.deepEqual((await apply()).json(), applied.json());
    assert.equal(repo.getTasks(db, PROJECT_ID).length, draft.tasks.length);
  } finally { await app.close(); fx.restore(); }
});
