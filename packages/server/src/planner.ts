import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizedEnv } from "@orc/adapters";
import type { Difficulty, PlanChatMessage, Role } from "@orc/types";

// Planning runs headless, through whichever CLI `routing.planner`'s model
// resolves to (F37):
//   - claude-code -> `claude -p`. Chat turns and the final deconstruction
//     (plan -> task DAG) both run on the same planner model (default
//     Sonnet); the tiers can still be split via the PLANNER_CHAT_MODEL /
//     PLANNER_DECONSTRUCT_MODEL envs. (Deconstruct used to default to Opus,
//     which a Pro subscription can't run — see config.ts.)
//   - codex -> `codex exec`, one model for both tiers; deconstruct
//     uses `--output-schema` so the CLI enforces the task-DAG JSON shape
//     natively instead of relying on the lenient markdown-fence extraction
//     the claude path still needs.
// opencode-runner planners are rejected before either path is reached (see
// `resolvePlannerModel` in index.ts) — conversational planning quality is
// the point of the two subscription CLIs, not something to silently degrade.

/** Which CLI + model id to run the planner through (F37). */
export interface PlannerModel {
  runner: "claude-code" | "codex";
  /** `claude --model` alias or `codex exec -m` id; omitted => CLI default. */
  model?: string;
}

export interface PlannedTask {
  title: string;
  description: string;
  difficulty: Difficulty;
  role?: Role;
  acceptanceCriteria: string[];
  /** Indices into the tasks array (must be earlier tasks). */
  dependsOn: number[];
  scopePaths: string[];
}

export interface PlanOutput {
  prdMarkdown: string;
  tasks: PlannedTask[];
  /** F38: generated AGENTS.md content — a project-context file for coding
   *  agents, committed alongside the PRD at /plan/commit. */
  agentsMd: string;
}

const PLAN_TIMEOUT_MS = 5 * 60 * 1000;

const DECONSTRUCT_SHAPE = `Respond with ONLY a JSON object, no markdown fences, in this exact shape:
{
  "prd": "markdown string",
  "agentsMd": "markdown string",
  "tasks": [
    {
      "title": "...",
      "description": "...",
      "difficulty": "medium",
      "role": "frontend",
      "acceptanceCriteria": ["..."],
      "dependsOn": [],
      "scopePaths": ["src/**"]
    }
  ]
}
Rules for each task:
- difficulty: "easy" | "medium" | "hard" — this directly selects which model authors the
  task, so calibrate it honestly rather than defaulting everything to "medium":
  - "easy": small, mechanical, low-risk (config tweaks, simple CRUD, boilerplate, a single
    isolated component with no tricky logic). Routed to a fast/cheap model — use this
    whenever the work genuinely doesn't need a strong model, so the team isn't paying for
    capability it doesn't need.
  - "medium": the default for most real feature work — a solid mid-tier model.
  - "hard": genuinely complex logic, tricky state/algorithms, security-sensitive code, or
    anything where a wrong implementation is costly to unwind. Routed to the strongest (and
    priciest) model — reserve it for tasks that actually need that strength, not every task
    that merely sounds important.
- role (optional): "frontend" | "docs" | "hard" | "medium" | "updates" — overrides the
  difficulty-based model choice. Use "frontend" for UI-heavy work (component layout,
  styling, client-side interaction) regardless of difficulty — it's routed to the model
  that scores best on web-dev coding benchmarks. Don't create a "docs" task yourself: one
  is added automatically for every project to write the README/setup docs in parallel with
  coding — only add your own docs-flavored task if the user asked for something beyond
  standard project documentation (e.g. a specific API reference doc).
- acceptanceCriteria: concrete, checkable statements
- dependsOn: indices of earlier tasks that must finish first
- scopePaths: glob(s) the task is allowed to modify

agentsMd: real AGENTS.md content for the coding agents that will implement these tasks —
committed to the repo root and read natively by Codex/opencode (Claude Code reads it via a
one-line CLAUDE.md import). This file is entirely about the PROJECT being built, never about
Hoopedorc's own worktree/PR/gate machinery. Cap it around 120 lines — a context file, not a
book — and cover, in order:
- One paragraph: what the project is and what it does.
- The stack and target platform (e.g. "Next.js 15 App Router, TypeScript, deployed to Vercel").
- The intended directory structure: a brief tree or bullet list of the main folders/files and
  what lives in each.
- The real dev/test/build/lint commands — these MUST match the scaffold task's actual
  package.json scripts exactly (the ones that task creates), never invented ones.
- Coding conventions and best practices specific to this stack (naming, file organization,
  patterns to prefer or avoid) — tailor these to whatever is actually being built, not generic
  advice.
- Brief "how to work here" notes for an agent making a change (e.g. where tests live, what to
  update alongside a given kind of change).`;

/**
 * The same shape `DECONSTRUCT_SHAPE` describes in prose, as a JSON Schema for
 * Codex's `--output-schema` (F37) — the CLI enforces this natively instead of
 * relying on the lenient prose instruction + `extractJsonObject` fallback the
 * claude path still uses. `role`'s allowed values match the 5 real overrides
 * listed in the prose above (not the full `Role` union — "planner"/
 * "validator" are pipeline-stage roles, never a task-authoring override).
 *
 * Every object needs `additionalProperties: false` and every property
 * (including optional ones) listed in `required` — confirmed live against
 * the real CLI 2026-07-08: omitting either gets a 400 `invalid_json_schema`
 * ("'additionalProperties' is required... to be false") before the model
 * even runs. A genuinely optional field (here: `role`) is modeled as
 * nullable + required, with `null` meaning "not set" — also confirmed live,
 * the model correctly emits `null` for tasks with no role override.
 */
const DECONSTRUCT_JSON_SCHEMA = {
  type: "object",
  properties: {
    prd: { type: "string" },
    agentsMd: { type: "string" },
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          difficulty: { type: "string", enum: ["easy", "medium", "hard"] },
          role: {
            type: ["string", "null"],
            enum: ["frontend", "docs", "hard", "medium", "updates", null],
          },
          acceptanceCriteria: { type: "array", items: { type: "string" } },
          dependsOn: { type: "array", items: { type: "integer" } },
          scopePaths: { type: "array", items: { type: "string" } },
        },
        required: [
          "title",
          "description",
          "difficulty",
          "role",
          "acceptanceCriteria",
          "dependsOn",
          "scopePaths",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["prd", "agentsMd", "tasks"],
  additionalProperties: false,
} as const;

// Auto-merge's objective gates (typecheck/lint/build/test) are just
// `npm run <script> --if-present` — a repo with none of those scripts passes
// every gate vacuously, leaving only the validator model between generated
// code and a merge. Brand-new repos start from a script-less package.json
// (see createGithubRepo), so without this instruction every fresh project's
// first task would ship with zero real gates.
const SCAFFOLD_INSTRUCTION = `
This is a brand-new project with no existing code. Make the FIRST task in your task list a
scaffold task that sets up the project skeleton AND real \`package.json\` scripts — \`test\`,
\`build\`, \`lint\`, \`typecheck\` — appropriate to whatever stack you choose. These scripts are
the objective safety gates every later task's changes are checked against; a scaffold with no
scripts means nothing is ever actually verified before auto-merge. Its acceptanceCriteria must
include a criterion equivalent to "npm test runs real tests and passes".`;

function buildPrompt(goal: string, projectName: string): string {
  return `You are the planning agent for an autonomous multi-model coding team.
Plan the project "${projectName}" for this goal:

${goal}
${SCAFFOLD_INSTRUCTION}

Produce a short PRD and break the work into a dependency-ordered task DAG.
${DECONSTRUCT_SHAPE}`;
}

const CHAT_SYSTEM = `You are the planning collaborator for an autonomous multi-model coding team.
Talk with the user to shape WHAT to build and how to break it into tasks. Be concise and
concrete: propose a small set of dependency-ordered tasks, ask clarifying questions when scope
is ambiguous, and adapt when the user says things like "split that task", "add tests", or
"don't touch the DB". Keep replies short — this is a planning chat, not an essay. Do NOT output
JSON; a separate step turns the agreed plan into a structured task list.

Your working directory is the project's actual cloned repository. If the repo already has code
in it (an existing project getting a new feature or bugfix, not a brand-new empty scaffold),
use your file tools (read/glob/grep) to look at the real file structure, existing conventions,
and relevant source before proposing scope paths or tasks — don't guess at file names or
structure that you could just check. For a genuinely empty/new project, skip exploration and
plan from the stated goal.

When you are satisfied that the plan is complete — you have no more clarifying questions, no
outstanding ambiguities, and the scope/tasks are well-defined — end your reply with exactly
this token on its own line: [PLAN_COMPLETE]
Only emit [PLAN_COMPLETE] once you are genuinely ready; do not emit it mid-conversation.`;

/**
 * Block describing what the project already shipped, injected when planning a
 * follow-up iteration (v2+). Tells the planner to propose only the delta on top
 * of existing, already-built work rather than re-planning from scratch.
 */
function priorContextBlock(priorContext?: string): string {
  if (!priorContext) return "";
  return `

## EXISTING PROJECT — this is a follow-up iteration
This project has already shipped earlier work. Below is its prior PRD, the
tasks already completed, and a recent activity log. Treat all of this as DONE
and present in the codebase. Your job now is to plan ONLY the NEW work the user
is asking for in this conversation — do NOT recreate or re-scaffold existing
functionality. Build on what's there, reuse existing files/conventions, and
only propose tasks for the incremental changes.

${priorContext}
`;
}

/**
 * F27: names of files currently sitting in `context/attachments/` in the
 * project's clone — images, PDFs, reference docs the user uploaded from
 * PlanView. The planner runs with that clone as its cwd (see
 * `resolvePlannerCwd` in index.ts), so pointing it at the paths is enough
 * for it to read them with its own file tools; no base64-into-prompt
 * plumbing needed. Empty/omitted list produces no block at all, so a
 * project with no attachments sees an unchanged prompt.
 */
function attachmentsBlock(attachments?: string[]): string {
  if (!attachments || attachments.length === 0) return "";
  const list = attachments.map((name) => `- context/attachments/${name}`).join("\n");
  return `

## Attached context files
The user has uploaded the following files into \`context/attachments/\` in your working
directory — read them with your file tools (some may be images or PDFs) before answering
or planning, and treat their content as part of the project's requirements:
${list}
`;
}

function buildChatPrompt(
  messages: PlanChatMessage[],
  projectName: string,
  priorContext?: string,
  attachments?: string[],
): string {
  const transcript = messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");
  return `${CHAT_SYSTEM}

Project: "${projectName}"
${priorContextBlock(priorContext)}${attachmentsBlock(attachments)}
Conversation so far:
${transcript}

Reply as the Assistant to the latest User message.`;
}

function buildDeconstructPrompt(
  messages: PlanChatMessage[],
  projectName: string,
  priorContext?: string,
  attachments?: string[],
): string {
  const transcript = messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");
  return `You are the planning agent for an autonomous multi-model coding team.
Below is a planning conversation for the project "${projectName}". Turn the AGREED plan into a
short PRD and a dependency-ordered task DAG. Honor every constraint the user stated.

Your working directory is the project's actual cloned repository. If it already contains code,
use your file tools to check real file paths and existing structure before writing scopePaths —
each task's scopePaths must match files/globs that actually make sense for this repo, not
invented paths. For a brand-new/empty project, plan from the conversation alone.
${priorContext ? "" : SCAFFOLD_INSTRUCTION}
${priorContextBlock(priorContext)}${attachmentsBlock(attachments)}
## Planning conversation
${transcript}

${DECONSTRUCT_SHAPE}

${priorContext
  ? `Because this is a follow-up iteration, the "prd" you return should be the UPDATED full PRD
(prior PRD revised to include the new work), and "tasks" should contain ONLY the new tasks for
this iteration — not the already-completed ones.`
  : ""}`;
}

interface ClaudeJsonResult {
  text: string;
  costUsd: number;
}

/** Run `claude -p --output-format json` and return its text + reported cost. */
function runClaudeJson(
  prompt: string,
  cwd: string,
  model?: string,
): Promise<ClaudeJsonResult> {
  return new Promise((resolve, reject) => {
    // Prompt goes on stdin, not argv: a long planning chat (full transcript +
    // prior-context inlined) can exceed macOS's ~1MB total argv cap and fail
    // with a cryptic spawn error. `claude -p` with no positional prompt reads
    // from stdin (verified against the real CLI).
    const args = ["-p", "--output-format", "json"];
    if (model) args.push("--model", model);
    const proc = spawn("claude", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    proc.stdin?.end(prompt);
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("planner timed out"));
    }, PLAN_TIMEOUT_MS);

    proc.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
    proc.stderr?.on("data", (c: Buffer) => (err += c.toString("utf8")));
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${err.slice(0, 500)}`));
        return;
      }
      // claude --output-format json wraps the answer:
      // { ..., "result": "<text>", "total_cost_usd": <n> }
      try {
        const wrapper = JSON.parse(out) as {
          result?: unknown;
          total_cost_usd?: number;
          cost_usd?: number;
        };
        resolve({
          text: typeof wrapper.result === "string" ? wrapper.result : out,
          costUsd: wrapper.total_cost_usd ?? wrapper.cost_usd ?? 0,
        });
      } catch {
        resolve({ text: out, costUsd: 0 });
      }
    });
  });
}

/**
 * Run `codex exec` and return its final message text (F37's codex-planner
 * twin of `runClaudeJson`). `outputSchema`, when given, is written to a temp
 * file and passed as `--output-schema` so the CLI enforces the shape
 * natively (used for deconstruct; omitted for free-text chat turns).
 * `costUsd` is always 0 — subscription-billed, same honesty rule as F36's
 * `CodexAdapter`.
 */
function runCodexJson(
  prompt: string,
  cwd: string,
  model?: string,
  outputSchema?: object,
): Promise<ClaudeJsonResult> {
  return new Promise((resolve, reject) => {
    const outputFile = join(tmpdir(), `codex-plan-${randomUUID()}.txt`);
    const schemaFile = outputSchema
      ? join(tmpdir(), `codex-plan-schema-${randomUUID()}.json`)
      : undefined;
    if (schemaFile) writeFileSync(schemaFile, JSON.stringify(outputSchema));
    const cleanup = () => {
      if (schemaFile) {
        try {
          unlinkSync(schemaFile);
        } catch {
          /* best effort */
        }
      }
      try {
        unlinkSync(outputFile);
      } catch {
        /* best effort — may never have been created */
      }
    };

    // Prompt on stdin (same argv-cap reasoning as runClaudeJson/CodexAdapter).
    // --skip-git-repo-check: the planner's cwd is always the project's real
    // clone (a git repo), so this is normally a no-op, but matches F36's
    // CodexAdapter for the same reason (defense against any cwd that isn't
    // one). --sandbox danger-full-access: parity with runClaudeJson, which
    // also runs unsandboxed — the planner only reads/greps, never commits,
    // but matching the coding adapters' sandbox keeps behavior uniform.
    const args = [
      "exec",
      "-",
      "--json",
      "--output-last-message",
      outputFile,
      "-C",
      cwd,
      "--sandbox",
      "danger-full-access",
      "--skip-git-repo-check",
    ];
    if (model) args.push("-m", model);
    if (schemaFile) args.push("--output-schema", schemaFile);

    const proc = spawn("codex", args, {
      cwd,
      env: sanitizedEnv({ PWD: cwd }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    proc.stdin?.end(prompt);

    let lastError = "";
    let lineBuf = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      cleanup();
      reject(new Error("planner timed out"));
    }, PLAN_TIMEOUT_MS);

    const handleEvent = (obj: Record<string, unknown>) => {
      if (obj.type === "turn.failed") {
        const err = obj.error as { message?: string } | undefined;
        if (err?.message) lastError = err.message;
      } else if (obj.type === "error" && typeof obj.message === "string") {
        lastError = obj.message;
      }
    };

    proc.stdout?.on("data", (c: Buffer) => {
      lineBuf += c.toString("utf8");
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop() ?? "";
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try {
          handleEvent(JSON.parse(t));
        } catch {
          /* non-JSON log line */
        }
      }
    });
    proc.stderr?.on("data", () => {});

    proc.on("error", (e) => {
      clearTimeout(timer);
      cleanup();
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      // --output-last-message is only written on a successful turn (verified
      // live, F36) — an empty/missing file alongside a nonzero exit means the
      // turn failed before producing a message.
      let text = "";
      try {
        text = readFileSync(outputFile, "utf8");
      } catch {
        /* not written — turn failed before completing */
      }
      cleanup();
      if (code !== 0 || !text.trim()) {
        reject(new Error(`codex exited ${code}: ${(lastError || "no output").slice(0, 500)}`));
        return;
      }
      resolve({ text: text.trim(), costUsd: 0 });
    });
  });
}

/** Dispatch to the right CLI for whichever model `routing.planner` resolves to. */
function runPlannerJson(
  prompt: string,
  cwd: string,
  plannerModel: PlannerModel,
  outputSchema?: object,
): Promise<ClaudeJsonResult> {
  return plannerModel.runner === "codex"
    ? runCodexJson(prompt, cwd, plannerModel.model, outputSchema)
    : runClaudeJson(prompt, cwd, plannerModel.model);
}

function extractJsonObject(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced && fenced[1]) return fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) return text.slice(start, end + 1);
  return text;
}

const DIFFICULTIES = new Set<Difficulty>(["easy", "medium", "hard"]);

/** Parse a raw planner JSON string into a normalized PlanOutput. */
function parsePlanOutput(text: string, projectName: string, goal = ""): PlanOutput {
  const parsed = JSON.parse(extractJsonObject(text)) as {
    prd?: string;
    agentsMd?: string;
    tasks?: unknown[];
  };

  if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
    throw new Error("planner returned no tasks");
  }

  const tasks: PlannedTask[] = parsed.tasks.map((raw, i) => {
    const t = raw as Record<string, unknown>;
    const difficulty = DIFFICULTIES.has(t.difficulty as Difficulty)
      ? (t.difficulty as Difficulty)
      : "medium";
    return {
      title: String(t.title ?? `Task ${i + 1}`),
      description: String(t.description ?? ""),
      difficulty,
      role: typeof t.role === "string" ? (t.role as Role) : undefined,
      acceptanceCriteria: Array.isArray(t.acceptanceCriteria)
        ? t.acceptanceCriteria.map(String)
        : [],
      dependsOn: Array.isArray(t.dependsOn)
        ? t.dependsOn.map(Number).filter((n) => Number.isInteger(n) && n < i)
        : [],
      scopePaths: Array.isArray(t.scopePaths) ? t.scopePaths.map(String) : ["**/*"],
    };
  });

  return {
    prdMarkdown: String(parsed.prd ?? `# ${projectName}\n\n${goal}`),
    agentsMd: String(parsed.agentsMd ?? ""),
    tasks,
  };
}

/** Single-shot planner: goal -> PRD + DAG. Used by the legacy /plan endpoint. */
export async function runPlanner(
  goal: string,
  projectName: string,
  cwd: string,
  plannerModel: PlannerModel,
): Promise<PlanOutput> {
  const schema = plannerModel.runner === "codex" ? DECONSTRUCT_JSON_SCHEMA : undefined;
  const { text } = await runPlannerJson(buildPrompt(goal, projectName), cwd, plannerModel, schema);
  return parsePlanOutput(text, projectName, goal);
}

/** One conversational planning turn (the planner model, claude or codex). Returns reply text + cost. */
export async function runPlannerChat(
  messages: PlanChatMessage[],
  projectName: string,
  cwd: string,
  plannerModel: PlannerModel,
  priorContext?: string,
  attachments?: string[],
): Promise<{ reply: string; costUsd: number }> {
  const { text, costUsd } = await runPlannerJson(
    buildChatPrompt(messages, projectName, priorContext, attachments),
    cwd,
    plannerModel,
  );
  return { reply: text.trim(), costUsd };
}

/** Deconstruct an agreed conversation into a strict task DAG (same planner model as chat). */
export async function runPlannerDeconstruct(
  messages: PlanChatMessage[],
  projectName: string,
  cwd: string,
  plannerModel: PlannerModel,
  priorContext?: string,
  attachments?: string[],
): Promise<{ output: PlanOutput; costUsd: number }> {
  const schema = plannerModel.runner === "codex" ? DECONSTRUCT_JSON_SCHEMA : undefined;
  const { text, costUsd } = await runPlannerJson(
    buildDeconstructPrompt(messages, projectName, priorContext, attachments),
    cwd,
    plannerModel,
    schema,
  );
  return { output: parsePlanOutput(text, projectName), costUsd };
}
