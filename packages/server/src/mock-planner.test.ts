import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PlanChatMessage, Project, VerifiedFigmaReference } from "@orc/types";
import { FigmaVerificationError, type PlannerModel } from "./planner.js";
import {
  MOCK_FIGMA_FRAME_HEIGHT,
  MOCK_FIGMA_FRAME_WIDTH,
  MOCK_PLANNER_FAILURE_TOKEN,
  MOCK_PLANNER_REPLY_PREFIX,
  MockPlannerUnavailableError,
  mockPlanningService,
} from "./mock-planner.js";
import type { PlanningDeconstructInput } from "./planning-service.js";

const PLANNER: PlannerModel = { id: "claude", runner: "claude-code", model: "sonnet" };
const FIXED_NOW = new Date("2026-09-21T10:00:00.000Z");

function project(localPath = "/nonexistent/mock-planner-project"): Project {
  return {
    id: "proj-mock",
    name: "Mock project",
    repoUrl: "https://github.com/example/mock-project",
    defaultBranch: "main",
    localPath,
    status: "paused",
    createdAt: FIXED_NOW.toISOString(),
    updatedAt: FIXED_NOW.toISOString(),
  };
}

function deconstructInput(
  messages: PlanChatMessage[],
  overrides: Partial<PlanningDeconstructInput> = {},
): PlanningDeconstructInput {
  return {
    project: project(),
    plannerModel: PLANNER,
    messages,
    attachmentNames: [],
    figmaVerification: "live",
    ...overrides,
  };
}

test("VW01: mock chat is deterministic, labeled, free, and ends ready to deconstruct", async () => {
  const service = mockPlanningService({ now: () => FIXED_NOW });
  const input = {
    project: project(),
    plannerModel: PLANNER,
    messages: [{ role: "user" as const, content: "Add a health endpoint\nwith tests" }],
    attachmentNames: ["brief.pdf", "mock.png"],
    priorContext: "### Prior PRD\nexisting",
  };
  const first = await service.chat(input);
  const second = await service.chat(input);
  assert.deepEqual(first, second);
  assert.equal(first.costUsd, 0);
  assert.ok(first.reply.startsWith(MOCK_PLANNER_REPLY_PREFIX));
  assert.match(first.reply, /Brief: Add a health endpoint$/m);
  assert.match(first.reply, /Attached context files: brief\.pdf, mock\.png/);
  assert.match(first.reply, /follow-up iteration/);
  assert.match(first.reply, /\n\[PLAN_COMPLETE\]$/);
  assert.equal(service.kind, "mock");
});

test("VW01: an empty brief asks for one instead of claiming readiness", async () => {
  const service = mockPlanningService();
  const result = await service.chat({
    project: project(),
    plannerModel: PLANNER,
    messages: [{ role: "user", content: "   \n " }],
    attachmentNames: [],
  });
  assert.ok(result.reply.startsWith(MOCK_PLANNER_REPLY_PREFIX));
  assert.doesNotMatch(result.reply, /PLAN_COMPLETE/);
});

test("VW01: the failure token makes every operation fail explicitly", async () => {
  const service = mockPlanningService();
  const messages: PlanChatMessage[] = [
    { role: "user", content: `Break the planner ${MOCK_PLANNER_FAILURE_TOKEN}` },
  ];
  await assert.rejects(
    service.chat({ project: project(), plannerModel: PLANNER, messages, attachmentNames: [] }),
    (err: unknown) =>
      err instanceof MockPlannerUnavailableError &&
      err.operation === "chat" &&
      /no real planner was invoked/.test(err.message),
  );
  await assert.rejects(
    service.deconstruct(deconstructInput(messages)),
    (err: unknown) =>
      err instanceof MockPlannerUnavailableError && err.operation === "deconstruct",
  );
  await assert.rejects(
    service.planGoal({
      project: project(),
      plannerModel: PLANNER,
      goal: `ship it ${MOCK_PLANNER_FAILURE_TOKEN}`,
    }),
    (err: unknown) => err instanceof MockPlannerUnavailableError && err.operation === "plan",
  );
});

test("VW01: mock deconstruction yields a valid, deterministic two-task DAG from the first brief", async () => {
  const service = mockPlanningService({ now: () => FIXED_NOW });
  const messages: PlanChatMessage[] = [
    { role: "user", content: "Add an API health endpoint." },
    { role: "assistant", content: "Ready. [PLAN_COMPLETE]" },
    { role: "user", content: "Also keep it small." },
  ];
  const first = await service.deconstruct(deconstructInput(messages));
  const second = await service.deconstruct(deconstructInput(messages));
  assert.deepEqual(first, second);
  assert.equal(first.costUsd, 0);
  assert.equal(first.verifiedFigmaReferences, undefined);
  const { output } = first;
  assert.match(output.prdMarkdown, /^# PRD: Mock project/);
  assert.match(output.prdMarkdown, /Add an API health endpoint\./);
  assert.match(output.agentsMd, /^# AGENTS\.md/);
  assert.equal(output.tasks.length, 2);
  assert.equal(output.tasks[0]?.title, "Implement: Add an API health endpoint.");
  assert.equal(output.tasks[0]?.role, undefined);
  assert.equal(output.tasks[1]?.title, "Add regression coverage: Add an API health endpoint.");
  assert.deepEqual(output.tasks[1]?.dependsOn, [0]);
  for (const [index, task] of output.tasks.entries()) {
    assert.ok(["easy", "medium", "hard"].includes(task.difficulty));
    assert.ok(task.acceptanceCriteria.length > 0);
    assert.ok(task.scopePaths.length > 0);
    assert.ok(task.dependsOn.every((dependency) => dependency < index));
  }
});

test("VW01: mock Figma verification returns the production reference shape and reuses a valid cache", async () => {
  const service = mockPlanningService({ now: () => FIXED_NOW });
  const messages: PlanChatMessage[] = [
    {
      role: "user",
      content:
        "Match https://www.figma.com/design/File123/Login?node-id=10-20 and " +
        "https://www.figma.com/design/File123/Login?node-id=30-40",
    },
  ];
  const saved: VerifiedFigmaReference[][] = [];
  const result = await service.deconstruct(
    deconstructInput(messages, {
      onVerifiedFigmaReferences: (references) => saved.push(references),
    }),
  );
  assert.equal(saved.length, 1);
  assert.deepEqual(result.verifiedFigmaReferences, [
    {
      canonicalUrl: "https://www.figma.com/design/File123/Login?node-id=10-20",
      fileKey: "File123",
      nodeId: "10:20",
      name: "Mock frame 10:20",
      fileName: "Mock file File123",
      width: MOCK_FIGMA_FRAME_WIDTH,
      height: MOCK_FIGMA_FRAME_HEIGHT,
      verifiedModel: "claude",
      verifiedRunner: "claude-code",
      verifiedAt: FIXED_NOW.toISOString(),
    },
    {
      canonicalUrl: "https://www.figma.com/design/File123/Login?node-id=30-40",
      fileKey: "File123",
      nodeId: "30:40",
      name: "Mock frame 30:40",
      fileName: "Mock file File123",
      width: MOCK_FIGMA_FRAME_WIDTH,
      height: MOCK_FIGMA_FRAME_HEIGHT,
      verifiedModel: "claude",
      verifiedRunner: "claude-code",
      verifiedAt: FIXED_NOW.toISOString(),
    },
  ]);
  assert.equal(result.output.tasks[0]?.role, "frontend");
  assert.match(
    result.output.tasks[0]?.description ?? "",
    /### Relevant references[\s\S]*node-id=10-20/,
  );

  const cached = await service.deconstruct(
    deconstructInput(messages, {
      cachedVerifiedFigmaReferences: result.verifiedFigmaReferences,
      onVerifiedFigmaReferences: (references) => saved.push(references),
    }),
  );
  assert.equal(saved.length, 1, "a matching cache must not re-verify");
  assert.deepEqual(cached.verifiedFigmaReferences, result.verifiedFigmaReferences);

  const otherRunner = await service.deconstruct(
    deconstructInput(messages, {
      plannerModel: { id: "codex", runner: "codex", model: "gpt-test" },
      cachedVerifiedFigmaReferences: result.verifiedFigmaReferences,
      onVerifiedFigmaReferences: (references) => saved.push(references),
    }),
  );
  assert.equal(saved.length, 2, "a cache from another runner is re-verified");
  assert.equal(otherRunner.verifiedFigmaReferences?.[0]?.verifiedRunner, "codex");
});

test("VW01: Figma capability failures are typed fixtures and fall back only when asked", async () => {
  const service = mockPlanningService({ now: () => FIXED_NOW });
  const authMessages: PlanChatMessage[] = [
    {
      role: "user",
      content:
        "Match https://www.figma.com/design/MOCKFAIL-figma_auth_required/Login?node-id=10-20",
    },
  ];
  const saved: VerifiedFigmaReference[][] = [];
  await assert.rejects(
    service.deconstruct(
      deconstructInput(authMessages, {
        onVerifiedFigmaReferences: (references) => saved.push(references),
      }),
    ),
    (err: unknown) =>
      err instanceof FigmaVerificationError &&
      err.issue.code === "figma_auth_required" &&
      err.issue.stage === "deconstruction" &&
      err.issue.runner === "claude-code" &&
      err.issue.model === "claude" &&
      err.issue.nodeId === "10:20" &&
      err.issue.canonicalUrl ===
        "https://www.figma.com/design/MOCKFAIL-figma_auth_required/Login?node-id=10-20" &&
      err.issue.actions.length > 0 &&
      err.costUsd === 0,
  );
  assert.equal(saved.length, 0);

  await assert.rejects(
    service.deconstruct(
      deconstructInput([
        {
          role: "user",
          content: "https://www.figma.com/design/MOCKFAIL-not_a_code/Login?node-id=10-20",
        },
      ]),
    ),
    (err: unknown) =>
      err instanceof FigmaVerificationError && err.issue.code === "figma_unavailable",
  );

  await assert.rejects(
    service.deconstruct(
      deconstructInput([
        { role: "user", content: "https://www.figma.com/design/File123/Login?node-id=bad" },
      ]),
    ),
    (err: unknown) =>
      err instanceof FigmaVerificationError && err.issue.code === "figma_invalid_node",
  );

  const fallback = await service.deconstruct(
    deconstructInput(authMessages, {
      figmaVerification: "attachments",
      attachmentNames: ["login.png"],
      onVerifiedFigmaReferences: (references) => saved.push(references),
    }),
  );
  assert.equal(fallback.verifiedFigmaReferences, undefined);
  assert.equal(saved.length, 0);
  assert.doesNotMatch(fallback.output.tasks[0]?.description ?? "", /Relevant references/);
});

test("VW01: the mock planner never spawns a CLI or touches the project path", async () => {
  const bin = mkdtempSync(join(tmpdir(), "hoopedorc-mock-planner-bin-"));
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-mock-planner-root-"));
  const fakeCli = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(path.join(path.dirname(process.argv[1]), "invoked-" + path.basename(process.argv[1])), "1");
process.stdout.write(JSON.stringify({ result: "REAL CLI REACHED", total_cost_usd: 1 }));
`;
  for (const name of ["claude", "codex", "opencode"]) {
    const file = join(bin, name);
    writeFileSync(file, fakeCli);
    chmodSync(file, 0o755);
  }
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath ?? ""}`;
  const localPath = join(root, "never-cloned");
  try {
    const service = mockPlanningService();
    const messages: PlanChatMessage[] = [
      {
        role: "user",
        content: "Build https://www.figma.com/design/File123/Login?node-id=10-20 login",
      },
    ];
    for (const plannerModel of [
      PLANNER,
      { id: "codex", runner: "codex", model: "gpt-test" } as PlannerModel,
      { id: "oc", runner: "opencode", model: "provider/model" } as PlannerModel,
    ]) {
      const chat = await service.chat({
        project: project(localPath),
        plannerModel,
        messages,
        attachmentNames: [],
      });
      assert.doesNotMatch(chat.reply, /REAL CLI REACHED/);
      const deconstructed = await service.deconstruct(
        deconstructInput(messages, { project: project(localPath), plannerModel }),
      );
      assert.equal(deconstructed.costUsd, 0);
      const planned = await service.planGoal({
        project: project(localPath),
        plannerModel,
        goal: "Build login",
      });
      assert.equal(planned.tasks.length, 2);
    }
    assert.deepEqual(
      readdirSync(bin).filter((name) => name.startsWith("invoked-")),
      [],
      "no planner CLI may be spawned in mock mode",
    );
    assert.equal(existsSync(localPath), false, "mock planning must not clone or create the project path");
  } finally {
    process.env.PATH = savedPath;
    rmSync(bin, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
