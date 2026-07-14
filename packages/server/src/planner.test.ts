import assert from "node:assert/strict";
import { test } from "node:test";
import { ENV, defaultSettings } from "./config.js";
import {
  extractJsonObject,
  flattenRawTasks,
  parsePlanOutput,
  plannerModelLabel,
  resolvePlannerModel,
} from "./planner.js";

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
    roles: [],
    enabled: true,
    maxConcurrent: 1,
  });
  settings.routing.planner = "codex-model";
  const codex = resolvePlannerModel(settings, "chat");
  assert.deepEqual(codex, { runner: "codex", model: "gpt-5.2-codex" });

  settings.routing.planner = "claude";
  const claude = resolvePlannerModel(settings, "chat");
  assert.equal(claude.runner, "claude-code");
});

test("plannerModelLabel: labels each runner distinctly", () => {
  assert.equal(plannerModelLabel({ runner: "claude-code", model: "sonnet" }), "sonnet");
  assert.equal(plannerModelLabel({ runner: "claude-code" }), "claude");
  assert.equal(plannerModelLabel({ runner: "codex", model: "gpt-5.2-codex" }), "codex:gpt-5.2-codex");
  assert.equal(
    plannerModelLabel({ runner: "opencode", model: "deepseek/deepseek-v4-pro" }),
    "opencode:deepseek/deepseek-v4-pro",
  );
});
