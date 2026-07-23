import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ModelInvocation } from "@orc/types";
import { ENV, defaultSettings } from "./config.js";
import {
  buildDeconstructPrompt,
  buildFigmaVerificationPrompt,
  ensureVerifiedFigmaTaskHandoff,
  extractJsonObject,
  FigmaVerificationError,
  flattenRawTasks,
  parsePlanOutput,
  plannerModelLabel,
  resolvePlannerModel,
  runPlannerChat,
  runPlannerDeconstruct,
} from "./planner.js";

test("F52: verification prompt requires a real MCP open and secret-free metadata", () => {
  const prompt = buildFigmaVerificationPrompt([
    {
      canonicalUrl:
        "https://www.figma.com/design/File123/Login?node-id=10-20",
      fileKey: "File123",
      nodeId: "10:20",
    },
  ]);
  assert.match(prompt, /ACTUALLY OPEN every node/);
  assert.match(prompt, /nodeId=10:20/);
  assert.match(prompt, /real frame\/screen name/);
  assert.match(prompt, /Never include credentials/);
});

test("F52: verified references are never lost from every task handoff", () => {
  const output = ensureVerifiedFigmaTaskHandoff(
    {
      prdMarkdown: "# Plan",
      agentsMd: "# Agents",
      tasks: [
        {
          title: "Build login",
          description: "Implement the login screen.",
          difficulty: "medium",
          role: "frontend",
          acceptanceCriteria: ["Login works."],
          dependsOn: [],
          scopePaths: ["apps/web/**"],
        },
      ],
    },
    [
      {
        canonicalUrl:
          "https://www.figma.com/design/File123/Login?node-id=10-20",
        fileKey: "File123",
        nodeId: "10:20",
        name: "Login desktop",
        width: 1440,
        height: 900,
        verifiedModel: "codex",
        verifiedRunner: "codex",
        verifiedAt: "2026-07-23T12:00:00.000Z",
      },
    ],
  );
  assert.match(output.tasks[0]!.description, /### Relevant references/);
  assert.match(output.tasks[0]!.description, /figma-implement-design/);
  assert.match(output.tasks[0]!.acceptanceCriteria.at(-1)!, /1440×900/);
});

test("F53: deconstruction keeps route/state context in implementation tasks and leaves visual-QA insertion to the server", () => {
  const prompt = buildDeconstructPrompt(
    [
      {
        role: "user",
        content:
          "The login screen is /login in the signed-out state with the invalid-password fixture.",
      },
    ],
    "visual QA",
    undefined,
    undefined,
    [
      {
        canonicalUrl:
          "https://www.figma.com/design/File123/Login?node-id=10-20",
        fileKey: "File123",
        nodeId: "10:20",
        name: "Login desktop",
        width: 1440,
        height: 900,
        verifiedModel: "codex",
        verifiedRunner: "codex",
        verifiedAt: "2026-07-23T12:00:00.000Z",
      },
    ],
  );

  assert.match(
    prompt,
    /route plus auth\/data\/interaction state and fixture/,
  );
  assert.match(prompt, /do not create a separate visual-QA task/);
});

test("F51: deconstruction requests self-contained task references without adding fields", () => {
  const prompt = buildDeconstructPrompt(
    [
      {
        role: "user",
        content:
          "Use docs/specs/auth.md and login-copy.md. Use browser verification for the login flow.",
      },
    ],
    "reference handoff",
    undefined,
    ["login-copy.md"],
  );

  assert.match(prompt, /description: a self-contained implementation handoff/);
  assert.match(prompt, /"### Relevant references"/);
  assert.match(prompt, /docs\/PRD\.md — Authentication \/ Login/);
  assert.match(prompt, /context\/attachments\/login-copy\.md/);
  assert.match(prompt, /"### Required skills\/capabilities"/);
  assert.match(prompt, /never invent a skill name/);
  assert.match(prompt, /never emit\s+fields beyond the ones shown above/i);
});

test("S10: Claude, Codex, and OpenCode planners receive the same credential-free environment", async (t) => {
  const bin = mkdtempSync(join(tmpdir(), "hoopedorc-planner-env-"));
  const fakeCli = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  const name = path.basename(process.argv[1]);
  const snapshot = JSON.stringify(process.env);
  if (name === "claude") {
    process.stdout.write(JSON.stringify({ result: snapshot, total_cost_usd: 0 }));
  } else if (name === "codex") {
    const index = process.argv.indexOf("--output-last-message");
    fs.writeFileSync(process.argv[index + 1], snapshot);
  } else {
    process.stdout.write(JSON.stringify({ part: { text: snapshot, cost: 0 } }) + "\\n");
  }
});
`;
  for (const name of ["claude", "codex", "opencode"]) {
    const file = join(bin, name);
    writeFileSync(file, fakeCli);
    chmodSync(file, 0o755);
  }

  const saved = { ...process.env };
  process.env.PATH = `${bin}:${saved.PATH ?? ""}`;
  process.env.HOME = "/home/planner-test";
  process.env.CODEX_HOME = "/home/planner-test/.codex";
  process.env.npm_config_registry = "https://registry.example";
  process.env.ANTHROPIC_API_KEY = "anthropic-sentinel";
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "claude-oauth-sentinel";
  process.env.CODEX_API_KEY = "codex-sentinel";
  process.env.OPENAI_API_KEY = "openai-sentinel";
  process.env.DEEPSEEK_API_KEY = "deepseek-sentinel";
  process.env.GH_TOKEN = "github-sentinel";
  process.env.TELEGRAM_BOT_TOKEN = "telegram-sentinel";
  process.env.npm_config__authToken = "npm-sentinel";
  process.env.NPM_CONFIG_PASSWORD = "npm-password-sentinel";

  const planners = [
    { runner: "claude-code", model: "sonnet" },
    { runner: "codex", model: "gpt-test" },
    { runner: "opencode", model: "provider/model" },
  ] as const;
  try {
    for (const planner of planners) {
      await t.test(planner.runner, async () => {
        const result = await runPlannerChat(
          [{ role: "user", content: "inspect your environment" }],
          "env test",
          bin,
          planner,
        );
        const childEnv = JSON.parse(result.reply) as Record<string, string>;
        assert.equal(childEnv.HOME, "/home/planner-test");
        assert.equal(childEnv.CODEX_HOME, "/home/planner-test/.codex");
        assert.equal(childEnv.PWD, bin);
        assert.equal(childEnv.npm_config_registry, "https://registry.example");
        for (const key of [
          "ANTHROPIC_API_KEY",
          "CLAUDE_CODE_OAUTH_TOKEN",
          "CODEX_API_KEY",
          "OPENAI_API_KEY",
          "DEEPSEEK_API_KEY",
          "GH_TOKEN",
          "TELEGRAM_BOT_TOKEN",
          "npm_config__authToken",
          "NPM_CONFIG_PASSWORD",
        ]) {
          assert.equal(childEnv[key], undefined, `${planner.runner}: ${key}`);
        }
      });
    }
  } finally {
    process.env = saved;
  }
});

test("F48: Claude, Codex, and OpenCode planner calls receive the routed effort", async () => {
  const bin = mkdtempSync(join(tmpdir(), "hoopedorc-planner-effort-"));
  const fakeCli = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
process.stdin.resume();
process.stdin.on("end", () => {
  const name = path.basename(process.argv[1]);
  const snapshot = JSON.stringify(process.argv.slice(2));
  if (name === "claude") {
    process.stdout.write(JSON.stringify({ result: snapshot, total_cost_usd: 0 }));
  } else if (name === "codex") {
    const index = process.argv.indexOf("--output-last-message");
    fs.writeFileSync(process.argv[index + 1], snapshot);
  } else {
    process.stdout.write(JSON.stringify({ part: { text: snapshot, cost: 0 } }) + "\\n");
  }
});
`;
  for (const name of ["claude", "codex", "opencode"]) {
    const file = join(bin, name);
    writeFileSync(file, fakeCli);
    chmodSync(file, 0o755);
  }

  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath ?? ""}`;
  try {
    const cases = [
      {
        planner: { runner: "claude-code" as const, model: "sonnet", effort: "high" },
        expected: ["--effort", "high"],
      },
      {
        planner: { runner: "codex" as const, model: "gpt-test", effort: "xhigh" },
        expected: ["-c", "model_reasoning_effort=xhigh"],
      },
      {
        planner: { runner: "opencode" as const, model: "provider/model", effort: "provider-max" },
        expected: ["--variant", "provider-max"],
      },
    ];
    for (const { planner, expected } of cases) {
      const result = await runPlannerChat(
        [{ role: "user", content: "show args" }],
        "effort test",
        bin,
        planner,
      );
      const args = JSON.parse(result.reply) as string[];
      const at = args.indexOf(expected[0]!);
      assert.notEqual(at, -1, `${planner.runner} missing ${expected[0]}`);
      assert.equal(args[at + 1], expected[1]);
    }
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  }
});

test("B40: planner emits a pre-spawn and terminal invocation with usage", async () => {
  const bin = mkdtempSync(join(tmpdir(), "hoopedorc-planner-ledger-"));
  const fakeCli = `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    result: "hello",
    total_cost_usd: 0.12,
    usage: {
      input_tokens: 7,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 3,
      output_tokens: 4
    }
  }));
});
`;
  const file = join(bin, "claude");
  writeFileSync(file, fakeCli);
  chmodSync(file, 0o755);

  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath ?? ""}`;
  const events: ModelInvocation[] = [];
  try {
    await runPlannerChat(
      [{ role: "user", content: "hello" }],
      "ledger test",
      bin,
      { id: "claude", runner: "claude-code", model: "sonnet", effort: "high" },
      undefined,
      undefined,
      undefined,
      (event) => events.push(event),
    );
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  }

  assert.equal(events.length, 2);
  assert.equal(events[0]?.outcome, "running");
  assert.equal(events[0]?.stage, "planner");
  assert.equal(events[0]?.model, "claude");
  assert.equal(events[0]?.runner, "claude-code");
  assert.equal(events[1]?.id, events[0]?.id);
  assert.equal(events[1]?.outcome, "completed");
  assert.equal(events[1]?.costUsd, 0.12);
  assert.equal(events[1]?.tokensIn, 9);
  assert.equal(events[1]?.tokensCached, 3);
  assert.equal(events[1]?.tokensOut, 4);
});

test("B40: deconstructor repair retry records two separate invocations", async () => {
  const bin = mkdtempSync(join(tmpdir(), "hoopedorc-deconstruct-ledger-"));
  const counter = join(bin, "count");
  const valid = JSON.stringify({
    prd: "# Plan",
    agentsMd: "# Agents",
    tasks: [{
      title: "Build",
      description: "Build it",
      difficulty: "medium",
      acceptanceCriteria: ["works"],
      dependsOn: [],
      scopePaths: ["src/**"],
    }],
  });
  const fakeCli = `#!/usr/bin/env node
const fs = require("node:fs");
const counter = ${JSON.stringify(counter)};
process.stdin.resume();
process.stdin.on("end", () => {
  const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
  fs.writeFileSync(counter, String(count + 1));
  process.stdout.write(JSON.stringify({
    result: count === 0 ? "not json" : ${JSON.stringify(valid)},
    total_cost_usd: 0
  }));
});
`;
  const file = join(bin, "claude");
  writeFileSync(file, fakeCli);
  chmodSync(file, 0o755);

  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath ?? ""}`;
  const events: ModelInvocation[] = [];
  try {
    const result = await runPlannerDeconstruct(
      [{ role: "user", content: "build it" }],
      "retry test",
      bin,
      { id: "claude", runner: "claude-code", model: "sonnet" },
      undefined,
      undefined,
      () => {},
      undefined,
      (event) => events.push(event),
    );
    assert.equal(result.output.tasks.length, 1);
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  }

  assert.equal(events.length, 4);
  assert.ok(events.every((event) => event.stage === "deconstructor"));
  assert.notEqual(events[0]?.id, events[2]?.id);
  assert.deepEqual(events.map((event) => event.outcome), [
    "running",
    "completed",
    "running",
    "completed",
  ]);
});

test("F52: Figma-backed deconstruction probes the actual runner once and returns real metadata", async () => {
  const bin = mkdtempSync(join(tmpdir(), "hoopedorc-figma-verified-"));
  const verification = JSON.stringify({
    status: "verified",
    references: [
      {
        index: 0,
        nodeId: "10:20",
        name: "Login desktop",
        fileName: "Product",
        width: 1440,
        height: 900,
      },
    ],
    issue: { code: "none", message: "", referenceIndex: null },
  });
  const plan = JSON.stringify({
    prd: "# Plan",
    agentsMd: "# Agents",
    tasks: [
      {
        title: "Build login",
        description: "Implement login.",
        difficulty: "medium",
        role: "frontend",
        acceptanceCriteria: ["works"],
        dependsOn: [],
        scopePaths: ["apps/web/**"],
      },
    ],
  });
  const fakeCli = `#!/usr/bin/env node
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  const result = input.includes("Verify exact Figma selections")
    ? ${JSON.stringify(verification)}
    : ${JSON.stringify(plan)};
  process.stdout.write(JSON.stringify({ result, total_cost_usd: 0.04 }));
});
`;
  const file = join(bin, "claude");
  writeFileSync(file, fakeCli);
  chmodSync(file, 0o755);

  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath ?? ""}`;
  const events: ModelInvocation[] = [];
  try {
    const messages = [
      {
        role: "user" as const,
        content:
          "Match https://www.figma.com/design/File123/Login?node-id=10-20",
      },
    ];
    const result = await runPlannerDeconstruct(
      messages,
      "Figma plan",
      bin,
      { id: "claude", runner: "claude-code", model: "sonnet" },
      undefined,
      undefined,
      () => {},
      undefined,
      (event) => events.push(event),
    );
    assert.equal(result.costUsd, 0.08);
    assert.equal(result.verifiedFigmaReferences?.[0]?.name, "Login desktop");
    assert.match(result.output.tasks[0]!.description, /node-id=10-20/);

    const cachedEvents: ModelInvocation[] = [];
    await runPlannerDeconstruct(
      messages,
      "Figma plan",
      bin,
      { id: "claude", runner: "claude-code", model: "sonnet" },
      undefined,
      undefined,
      () => {},
      undefined,
      (event) => cachedEvents.push(event),
      result.verifiedFigmaReferences,
    );
    assert.ok(cachedEvents.every((event) => event.stage === "deconstructor"));

    const reroutedEvents: ModelInvocation[] = [];
    await runPlannerDeconstruct(
      messages,
      "Figma plan",
      bin,
      { id: "claude-rerouted", runner: "claude-code", model: "sonnet" },
      undefined,
      undefined,
      () => {},
      undefined,
      (event) => reroutedEvents.push(event),
      result.verifiedFigmaReferences,
    );
    assert.deepEqual(
      reroutedEvents
        .filter((event) => event.outcome === "running")
        .map((event) => event.stage),
      ["health", "deconstructor"],
    );

    const restartedEvents: ModelInvocation[] = [];
    await runPlannerDeconstruct(
      messages,
      "Figma plan",
      bin,
      { id: "claude", runner: "claude-code", model: "sonnet" },
      undefined,
      undefined,
      () => {},
      undefined,
      (event) => restartedEvents.push(event),
      result.verifiedFigmaReferences?.map((reference) => ({
        ...reference,
        verifiedAt: "2000-01-01T00:00:00.000Z",
      })),
    );
    assert.deepEqual(
      restartedEvents
        .filter((event) => event.outcome === "running")
        .map((event) => event.stage),
      ["health", "deconstructor"],
    );
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  }
  assert.deepEqual(
    events.filter((event) => event.outcome === "running").map((event) => event.stage),
    ["health", "deconstructor"],
  );
});

test("F52: an unavailable Figma MCP is actionable and does not run deconstruction", async () => {
  const bin = mkdtempSync(join(tmpdir(), "hoopedorc-figma-missing-"));
  const unavailable = JSON.stringify({
    status: "unavailable",
    references: [],
    issue: {
      code: "mcp_missing",
      message: "raw runner detail must not be exposed",
      referenceIndex: 0,
    },
  });
  const fakeCli = `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    result: ${JSON.stringify(unavailable)},
    total_cost_usd: 0.03
  }));
});
`;
  const file = join(bin, "claude");
  writeFileSync(file, fakeCli);
  chmodSync(file, 0o755);

  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath ?? ""}`;
  const events: ModelInvocation[] = [];
  try {
    await assert.rejects(
      runPlannerDeconstruct(
        [
          {
            role: "user",
            content:
              "Match https://www.figma.com/design/File123/Login?node-id=10-20",
          },
        ],
        "Figma plan",
        bin,
        { id: "claude", runner: "claude-code", model: "sonnet" },
        undefined,
        undefined,
        () => {},
        undefined,
        (event) => events.push(event),
      ),
      (err: unknown) =>
        err instanceof FigmaVerificationError &&
        err.issue.code === "figma_mcp_missing" &&
        err.issue.nodeId === "10:20" &&
        err.costUsd === 0.03 &&
        !err.message.includes("raw runner detail"),
    );
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  }
  assert.equal(events.length, 2);
  assert.ok(events.every((event) => event.stage === "health"));
});

test("F52: auth, access, node, timeout, and malformed probe results fail closed", async () => {
  const bin = mkdtempSync(join(tmpdir(), "hoopedorc-figma-failures-"));
  const responseFile = join(bin, "response.json");
  const fakeCli = `#!/usr/bin/env node
const fs = require("node:fs");
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    result: fs.readFileSync(${JSON.stringify(responseFile)}, "utf8"),
    total_cost_usd: 0
  }));
});
`;
  const file = join(bin, "claude");
  writeFileSync(file, fakeCli);
  chmodSync(file, 0o755);

  const cases = [
    ["auth_required", "figma_auth_required"],
    ["access_denied", "figma_access_denied"],
    ["node_not_found", "figma_node_not_found"],
    ["timeout", "figma_timeout"],
  ] as const;
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath ?? ""}`;
  try {
    for (const [rawCode, expectedCode] of cases) {
      writeFileSync(
        responseFile,
        JSON.stringify({
          status: "unavailable",
          references: [],
          issue: { code: rawCode, message: "detail", referenceIndex: 0 },
        }),
      );
      await assert.rejects(
        runPlannerDeconstruct(
          [
            {
              role: "user",
              content:
                "Match https://www.figma.com/design/File123/Login?node-id=10-20",
            },
          ],
          "Figma plan",
          bin,
          { id: "claude", runner: "claude-code", model: "sonnet" },
        ),
        (err: unknown) =>
          err instanceof FigmaVerificationError &&
          err.issue.code === expectedCode,
      );
    }

    writeFileSync(responseFile, "not JSON");
    await assert.rejects(
      runPlannerDeconstruct(
        [
          {
            role: "user",
            content:
              "Match https://www.figma.com/design/File123/Login?node-id=10-20",
          },
        ],
        "Figma plan",
        bin,
        { id: "claude", runner: "claude-code", model: "sonnet" },
      ),
      (err: unknown) =>
        err instanceof FigmaVerificationError &&
        err.issue.code === "figma_malformed_response",
    );

    writeFileSync(
      responseFile,
      JSON.stringify({
        status: "verified",
        references: [
          {
            index: 0,
            nodeId: "10:20",
            name: "Login desktop",
            fileName: "Product",
            width: 1440,
            height: 900,
          },
        ],
        issue: {
          code: "figma_node_missing",
          message: "contradicts verified status",
          referenceIndex: 0,
        },
      }),
    );
    await assert.rejects(
      runPlannerDeconstruct(
        [
          {
            role: "user",
            content:
              "Match https://www.figma.com/design/File123/Login?node-id=10-20",
          },
        ],
        "Figma plan",
        bin,
        { id: "claude", runner: "claude-code", model: "sonnet" },
      ),
      (err: unknown) =>
        err instanceof FigmaVerificationError &&
        err.issue.code === "figma_malformed_response",
    );
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  }
});

test("F52: an invalid node id is rejected before any model invocation", async () => {
  const events: ModelInvocation[] = [];
  await assert.rejects(
    runPlannerDeconstruct(
      [
        {
          role: "user",
          content:
            "Match https://www.figma.com/design/File123/Login?node-id=invalid",
        },
      ],
      "Figma plan",
      tmpdir(),
      { id: "codex", runner: "codex", model: "gpt-test" },
      undefined,
      undefined,
      () => {},
      undefined,
      (event) => events.push(event),
    ),
    (err: unknown) =>
      err instanceof FigmaVerificationError &&
      err.issue.code === "figma_invalid_node",
  );
  assert.deepEqual(events, []);
});

test("F52: explicit attachment fallback makes no probe and strips unverified node claims", async () => {
  const bin = mkdtempSync(join(tmpdir(), "hoopedorc-figma-fallback-"));
  const url = "https://www.figma.com/design/File123/Login?node-id=10-20";
  const plan = JSON.stringify({
    prd: "# Screenshot-backed plan",
    agentsMd: "# Agents",
    tasks: [
      {
        title: "Build login",
        description: `Implement login.\n\n### Relevant references\n- ${url}`,
        difficulty: "medium",
        role: "frontend",
        acceptanceCriteria: [`Closely matches ${url}.`],
        dependsOn: [],
        scopePaths: ["apps/web/**"],
      },
    ],
  });
  const fakeCli = `#!/usr/bin/env node
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  if (input.includes("Verify exact Figma selections")) process.exit(9);
  process.stdout.write(JSON.stringify({ result: ${JSON.stringify(plan)}, total_cost_usd: 0 }));
});
`;
  const file = join(bin, "claude");
  writeFileSync(file, fakeCli);
  chmodSync(file, 0o755);

  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath ?? ""}`;
  const events: ModelInvocation[] = [];
  try {
    const result = await runPlannerDeconstruct(
      [{ role: "user", content: `Use ${url}` }],
      "Fallback plan",
      bin,
      { id: "claude", runner: "claude-code", model: "sonnet" },
      undefined,
      ["login.png"],
      () => {},
      undefined,
      (event) => events.push(event),
      undefined,
      undefined,
      "attachments",
    );
    assert.equal(result.verifiedFigmaReferences, undefined);
    assert.doesNotMatch(result.output.tasks[0]!.description, /figma\.com/);
    assert.doesNotMatch(
      result.output.tasks[0]!.acceptanceCriteria.join("\n"),
      /figma\.com/,
    );
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  }
  assert.ok(events.every((event) => event.stage === "deconstructor"));
});

// B31: the owner's exact failure shape — pure JSON whose "prd" string
// contains a fenced snippet mentioning a file path. The old unanchored,
// non-greedy fence regex matched the INNER fence and extracted garbage
// starting "\nprisma/..." instead of the real JSON, producing exactly the
// reported "Unexpected token '\'" error.
test("extractJsonObject: pure JSON with an inner code fence in a string value", () => {
  const text = JSON.stringify({
    prd: "Set up the schema:\n```\nprisma/schema.prisma\n```\nThen run migrations.",
    agentsMd: "# Agents",
    tasks: [{ title: "Scaffold", description: "x" }],
  });
  const extracted = extractJsonObject(text);
  const parsed = JSON.parse(extracted) as { prd: string };
  assert.match(parsed.prd, /prisma\/schema\.prisma/);
});

test("extractJsonObject: whole-response fence-wrapped JSON still parses", () => {
  const inner = JSON.stringify({ prd: "p", agentsMd: "a", tasks: [{ title: "T" }] });
  const text = "```json\n" + inner + "\n```";
  const extracted = extractJsonObject(text);
  const parsed = JSON.parse(extracted) as { prd: string };
  assert.equal(parsed.prd, "p");
});

test("extractJsonObject: leaves clean bare JSON untouched", () => {
  const text = '{"a":1,"b":2}';
  assert.equal(extractJsonObject(text), text);
});

// B31 layer 2: a raw (unescaped) newline inside a JSON string value is
// invalid JSON on its own — the repair pass inside parsePlanOutput must fix
// it via parseJsonWithRepair before this ever reaches JSON.parse cleanly.
test("parsePlanOutput repairs a literal newline inside a JSON string", () => {
  const broken =
    '{"prd":"line one\nline two","agentsMd":"","tasks":[{"title":"T","description":"d"}]}';
  const out = parsePlanOutput(broken, "proj");
  assert.equal(out.prdMarkdown, "line one\nline two");
  assert.equal(out.tasks.length, 1);
});

test("parsePlanOutput: well-formed output parses to the expected shape", () => {
  const text = JSON.stringify({
    prd: "# PRD",
    agentsMd: "# Agents",
    tasks: [
      {
        title: "Scaffold",
        description: "Set up the project",
        difficulty: "easy",
        acceptanceCriteria: ["npm test passes"],
        dependsOn: [],
        scopePaths: ["**/*"],
      },
      {
        title: "Build feature",
        description: "Implement the feature",
        difficulty: "medium",
        dependsOn: [0],
        scopePaths: ["src/**"],
      },
    ],
  });
  const out = parsePlanOutput(text, "proj");
  assert.equal(out.tasks.length, 2);
  assert.equal(out.tasks[0]!.title, "Scaffold");
  assert.deepEqual(out.tasks[1]!.dependsOn, [0]);
});

// F46: a model that nests subtasks instead of emitting a flat list must not
// break the task generator — flatten one level, point children at the
// parent's (possibly shifted) index.
test("flattenRawTasks: nested subtasks are flattened with correct dependsOn", () => {
  const raw = [
    { title: "A", description: "a" },
    {
      title: "B",
      description: "b",
      subtasks: [
        { title: "B1", description: "b1" },
        { title: "B2", description: "b2" },
      ],
    },
    { title: "C", description: "c", dependsOn: [0] }, // depends on A, originally index 0
  ];
  const flat = flattenRawTasks(raw);
  assert.equal(flat.length, 5);
  assert.deepEqual(
    flat.map((t) => t.title),
    ["A", "B", "B1", "B2", "C"],
  );
  // B1/B2 point at B's flattened index (1).
  assert.deepEqual(flat[2]!.dependsOn, [1]);
  assert.deepEqual(flat[3]!.dependsOn, [1]);
  // C's own dependsOn (originally [0], referencing A) is unaffected since
  // nothing was spliced in before A.
  assert.deepEqual(flat[4]!.dependsOn, [0]);
});

test("flattenRawTasks: remaps a later top-level task's dependsOn across an earlier splice", () => {
  const raw = [
    { title: "A", description: "a", subtasks: [{ title: "A1", description: "a1" }] },
    { title: "B", description: "b" }, // originally top-level index 1
    { title: "C", description: "c", dependsOn: [1] }, // depends on B (original index 1)
  ];
  const flat = flattenRawTasks(raw);
  // A's injected child shifts B from original index 1 to flattened index 2 —
  // C's dependsOn must follow that shift and land on B, not on A1 (which now
  // occupies the OLD index 1).
  assert.deepEqual(
    flat.map((t) => t.title),
    ["A", "A1", "B", "C"],
  );
  assert.equal(flat[2]!.title, "B");
  assert.deepEqual(flat[3]!.dependsOn, [2]);
});

test("flattenRawTasks: drops non-object entries", () => {
  const raw = [{ title: "A", description: "a" }, "garbage", null, 42];
  const flat = flattenRawTasks(raw);
  assert.equal(flat.length, 1);
});

test("flattenRawTasks: remaps dependsOn across a dropped non-object entry", () => {
  const raw = [
    { title: "A", description: "a" },
    "garbage", // original index 1 — dropped
    { title: "C", description: "c" }, // original index 2
    { title: "D", description: "d", dependsOn: [2, 1] }, // depends on C; the garbage ref is dropped
  ];
  const flat = flattenRawTasks(raw);
  assert.deepEqual(
    flat.map((t) => t.title),
    ["A", "C", "D"],
  );
  // D's [2] must follow C to its post-drop index (1), not land on D itself
  // (which now occupies the OLD index 2); the reference to the dropped
  // garbage entry disappears entirely.
  assert.deepEqual(flat[2]!.dependsOn, [1]);
});

// F46: garbage entries (no title AND no description) are dropped rather
// than materializing as a blank task on the Board.
test("parsePlanOutput drops tasks with no title or description", () => {
  const text = JSON.stringify({
    prd: "p",
    agentsMd: "",
    tasks: [
      { title: "Real task", description: "does something" },
      { title: "", description: "" },
      { description: "   " },
    ],
  });
  const out = parsePlanOutput(text, "proj");
  assert.equal(out.tasks.length, 1);
  assert.equal(out.tasks[0]!.title, "Real task");
});

test("parsePlanOutput remaps dependsOn across a dropped empty task", () => {
  const text = JSON.stringify({
    prd: "p",
    agentsMd: "",
    tasks: [
      { title: "A", description: "a" },
      { title: "", description: "" }, // index 1 — dropped
      { title: "C", description: "c" }, // index 2 -> 1 after the drop
      { title: "D", description: "d" },
      { title: "E", description: "e", dependsOn: [2, 1] }, // depends on C; the empty ref is dropped
    ],
  });
  const out = parsePlanOutput(text, "proj");
  assert.deepEqual(
    out.tasks.map((t) => t.title),
    ["A", "C", "D", "E"],
  );
  // E's [2] must follow C to its post-drop index (1) instead of silently
  // landing on D (which slid into the old index 2); the reference to the
  // dropped empty task disappears entirely.
  assert.deepEqual(out.tasks[3]!.dependsOn, [1]);
});

test("parsePlanOutput throws when every task is empty (routes to B31's retry)", () => {
  const text = JSON.stringify({
    prd: "p",
    agentsMd: "",
    tasks: [{ title: "", description: "" }],
  });
  assert.throws(() => parsePlanOutput(text, "proj"), /no valid tasks/);
});

// F46: cap at 30 tasks — a runaway plan must not overwhelm the task
// generator, but every KEPT task's dependsOn must still resolve correctly
// (dependsOn only ever points backward, so truncating the tail is safe).
test("parsePlanOutput caps an oversized task list at 30", () => {
  const tasks = Array.from({ length: 40 }, (_, i) => ({
    title: `Task ${i}`,
    description: `d${i}`,
  }));
  const text = JSON.stringify({ prd: "p", agentsMd: "", tasks });
  const out = parsePlanOutput(text, "proj");
  assert.equal(out.tasks.length, 30);
  assert.equal(out.tasks[0]!.title, "Task 0");
  assert.equal(out.tasks[29]!.title, "Task 29");
});

test("parsePlanOutput dedupes duplicate titles", () => {
  const text = JSON.stringify({
    prd: "p",
    agentsMd: "",
    tasks: [
      { title: "Setup", description: "d1" },
      { title: "Setup", description: "d2" },
      { title: "Other", description: "d3" },
      { title: "Setup", description: "d4" },
    ],
  });
  const out = parsePlanOutput(text, "proj");
  assert.deepEqual(
    out.tasks.map((t) => t.title),
    ["Setup", "Setup (2)", "Other", "Setup (3)"],
  );
});

test("parsePlanOutput defaults empty acceptanceCriteria from the description", () => {
  const text = JSON.stringify({
    prd: "p",
    agentsMd: "",
    tasks: [{ title: "T", description: "Do the thing.\nMore detail." }],
  });
  const out = parsePlanOutput(text, "proj");
  assert.deepEqual(out.tasks[0]!.acceptanceCriteria, ["Do the thing."]);
});

test("F51: parsePlanOutput preserves reference sections and ordinary descriptions verbatim", () => {
  const referencedDescription = [
    "Implement login.",
    "",
    "### Relevant references",
    "- docs/PRD.md — Authentication / Login",
    "- context/attachments/login-copy.md",
    "",
    "### Required skills/capabilities",
    "- browser verification — exercise the real login flow",
  ].join("\n");
  const ordinaryDescription = "Implement logout without changing the session schema.";
  const text = JSON.stringify({
    prd: "p",
    agentsMd: "",
    tasks: [
      { title: "Login", description: referencedDescription },
      { title: "Logout", description: ordinaryDescription },
    ],
  });
  const out = parsePlanOutput(text, "proj");

  assert.equal(out.tasks[0]!.description, referencedDescription);
  assert.equal(out.tasks[1]!.description, ordinaryDescription);
  assert.deepEqual(Object.keys(out.tasks[0]!).sort(), [
    "acceptanceCriteria",
    "dependsOn",
    "description",
    "difficulty",
    "role",
    "scopePaths",
    "title",
  ]);
});

test("parsePlanOutput surfaces warnings via the onWarn callback", () => {
  const warnings: string[] = [];
  const text = JSON.stringify({
    prd: "p",
    agentsMd: "",
    tasks: [
      { title: "Real", description: "d" },
      { title: "", description: "" },
    ],
  });
  parsePlanOutput(text, "proj", "", (msg) => warnings.push(msg));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /dropped 1 task/);
});

// F45: opencode-runner models are now fully supported for planning, not
// just claude-code/codex — resolvePlannerModel used to throw outright for
// any opencode-runner routing target.
test("resolvePlannerModel: an opencode-runner model resolves for both the chat and deconstruct tiers", () => {
  const settings = defaultSettings();
  // deepseek-pro ships as an opencode-runner model with opencodeModel set.
  settings.routing.planner = "deepseek-pro";
  delete settings.routing.deconstructor; // falls back to the planner

  const chat = resolvePlannerModel(settings, "chat");
  assert.equal(chat.runner, "opencode");
  assert.equal(chat.model, "deepseek/deepseek-v4-pro");
  assert.equal(chat.opencodeBaseUrl, ENV.opencodeBaseUrl);

  const deconstruct = resolvePlannerModel(settings, "deconstruct");
  assert.equal(deconstruct.runner, "opencode");
  assert.equal(deconstruct.model, "deepseek/deepseek-v4-pro");
});

test("resolvePlannerModel: deconstructor can independently route to a different opencode model than the planner", () => {
  const settings = defaultSettings();
  settings.routing.planner = "claude";
  settings.routing.deconstructor = "deepseek-pro";

  const chat = resolvePlannerModel(settings, "chat");
  assert.equal(chat.runner, "claude-code");

  const deconstruct = resolvePlannerModel(settings, "deconstruct");
  assert.equal(deconstruct.runner, "opencode");
  assert.equal(deconstruct.model, "deepseek/deepseek-v4-pro");
});

test("resolvePlannerModel: an opencode-runner model with no opencodeModel configured still throws (400)", () => {
  const settings = defaultSettings();
  settings.models.push({
    id: "broken-opencode",
    displayName: "Broken",
    runner: "opencode",
    // opencodeModel deliberately omitted.
    roles: [],
    enabled: true,
    maxConcurrent: 1,
  });
  settings.routing.planner = "broken-opencode";

  assert.throws(() => resolvePlannerModel(settings, "chat"), /has no opencodeModel configured/);
  assert.throws(() => resolvePlannerModel(settings, "deconstruct"), /has no opencodeModel configured/);
});

test("resolvePlannerModel: codex and claude-code routing are unaffected by the opencode support", () => {
  const settings = defaultSettings();
  settings.models.push({
    id: "codex-model",
    displayName: "Codex",
    runner: "codex",
    codexModel: "gpt-5.2-codex",
    effort: "xhigh",
    roles: [],
    enabled: true,
    maxConcurrent: 1,
  });
  settings.routing.planner = "codex-model";
  const codex = resolvePlannerModel(settings, "chat");
  assert.deepEqual(codex, {
    id: "codex-model",
    runner: "codex",
    model: "gpt-5.2-codex",
    effort: "xhigh",
  });

  settings.routing.planner = "claude";
  const claude = resolvePlannerModel(settings, "chat");
  assert.equal(claude.runner, "claude-code");
});

test("B37/F48: planner rejects disabled routing and resolves effort for every tier", () => {
  const settings = defaultSettings();
  const claude = settings.models.find((model) => model.id === "claude")!;
  claude.effort = "high";
  assert.equal(resolvePlannerModel(settings, "chat").effort, "high");

  claude.enabled = false;
  assert.throws(() => resolvePlannerModel(settings, "chat"), /is disabled/);
});

test("plannerModelLabel: labels each runner distinctly", () => {
  assert.equal(
    plannerModelLabel({ runner: "claude-code", model: "sonnet", effort: "high" }),
    "sonnet [effort: high]",
  );
  assert.equal(
    plannerModelLabel({ runner: "claude-code" }),
    "claude [effort: CLI default]",
  );
  assert.equal(
    plannerModelLabel({ runner: "codex", model: "gpt-5.2-codex" }),
    "codex:gpt-5.2-codex [effort: CLI default]",
  );
  assert.equal(
    plannerModelLabel({ runner: "opencode", model: "deepseek/deepseek-v4-pro" }),
    "opencode:deepseek/deepseek-v4-pro [effort: CLI default]",
  );
});
