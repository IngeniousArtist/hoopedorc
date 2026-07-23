import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execManagedProcess, modelEffortArgs, sanitizedEnv } from "@orc/adapters";
import type {
  Difficulty,
  FigmaCapabilityIssue,
  FigmaCapabilityIssueCode,
  ModelId,
  ModelInvocation,
  PlanChatMessage,
  Role,
  Settings,
  VerifiedFigmaReference,
} from "@orc/types";
import { ENV } from "./config.js";
import {
  extractFigmaReferences,
  MAX_FIGMA_REFERENCES,
  normalizeVerifiedFigmaReferences,
  type FigmaNodeReferenceInput,
} from "./figma-references.js";

// Planning runs headless, through whichever CLI `routing.planner`'s model
// resolves to (F37, extended by F45):
//   - claude-code -> `claude -p`. Chat turns and the final deconstruction
//     (plan -> task DAG) both run on the routed planner ModelConfig's
//     claudeModel (default "sonnet") — the dashboard's model settings are
//     the single source of truth for which model plans.
//   - codex -> `codex exec`, same single-model rule; deconstruct
//     uses `--output-schema` so the CLI enforces the task-DAG JSON shape
//     natively instead of relying on the lenient markdown-fence extraction
//     the claude/opencode paths still need.
//   - opencode -> `opencode run`, same single-model rule (F45). No
//     `--output-schema` equivalent exists for this CLI, so deconstruction
//     leans entirely on B31's hardened extraction/repair/one-retry — B31
//     landed first in this same wave specifically so this path is safe to
//     open up. Originally rejected outright (see git history) back when
//     conversational-planning quality was the deciding factor; now that
//     per-tier model routing exists, routing planning to a specific model
//     is the operator's call to make, same as any other role.

/** Which CLI + model id to run the planner through (F37/F45). */
export interface PlannerModel {
  /** Logical Hoopedorc model id used for quotas/accounting. Older embedders
   * may omit it; resolved production routing always supplies it. */
  id?: ModelId;
  runner: "claude-code" | "codex" | "opencode";
  /** `claude --model` alias, `codex exec -m` id, or opencode `provider/model`
   *  id; omitted => CLI default (claude-code/codex only — opencode always
   *  requires an explicit model, enforced where this is constructed). */
  model?: string;
  /** Attempt-stable effort/variant resolved from the routed ModelConfig. */
  effort?: string;
  /** F45: shared `opencode serve` URL (ENV.opencodeBaseUrl) — only
   *  meaningful when runner === "opencode". Empty/unset runs opencode
   *  locally instead of attaching to a shared server. */
  opencodeBaseUrl?: string;
}

/**
 * F37: resolve a planning tier to a `PlannerModel` — which CLI + model id
 * the run* functions below should actually shell out to, instead of
 * hardcoding `claude`. Everything comes from the dashboard's routing:
 * `chat` turns use Settings → Routing → Planner; the one high-leverage
 * `deconstruct` call uses Settings → Routing → Deconstructor, which falls
 * back to the planner when unset (the default — one model does both). The
 * resolved config's `claudeModel`/`codexModel`/`opencodeModel` field is the
 * model id, with `ENV.plannerModel` only as a fallback when `claudeModel`
 * is unset. F45: opencode-runner planners are fully supported now that
 * per-tier model routing exists — only a missing `opencodeModel` on an
 * opencode-runner config still throws (callers turn this into an explicit
 * 400), mirroring `makeAdapter`'s own guard for author/validator runs.
 * Exported for unit tests — moved here from index.ts (F45) since index.ts
 * boots a real server as a side effect of being imported, same reasoning
 * `commands.ts` was split out for (F40).
 */
export function resolvePlannerModel(
  settings: Settings,
  tier: "chat" | "deconstruct",
): PlannerModel {
  const routedId =
    tier === "deconstruct"
      ? (settings.routing.deconstructor ?? settings.routing.planner)
      : settings.routing.planner;
  const cfg = settings.models.find((m) => m.id === routedId);
  if (!cfg) throw new Error(`planner routing references missing model "${routedId}"`);
  if (!cfg.enabled) throw new Error(`planner model "${cfg.displayName}" is disabled`);
  if (cfg.runner === "codex") {
    return { id: cfg.id, runner: "codex", model: cfg.codexModel, effort: cfg.effort };
  }
  if (cfg?.runner === "opencode") {
    if (!cfg.opencodeModel) {
      const field = tier === "deconstruct" && settings.routing.deconstructor
        ? "Deconstructor"
        : "Planner";
      throw new Error(
        `planner model "${cfg.displayName}" is runner=opencode but has no opencodeModel ` +
          `configured — set one in Settings → Models, or route Settings → Routing → ${field} ` +
          `to a different model`,
      );
    }
    return {
      id: cfg.id,
      runner: "opencode",
      model: cfg.opencodeModel,
      effort: cfg.effort,
      opencodeBaseUrl: ENV.opencodeBaseUrl,
    };
  }
  return {
    id: cfg.id,
    runner: "claude-code",
    model: cfg.claudeModel ?? ENV.plannerModel,
    effort: cfg.effort,
  };
}

/** Display label for the plan-session markdown's "Planner model:" line —
 *  unchanged from before F37 for the claude-code path (just `pm.model`, the
 *  existing alias string), qualified with "codex:"/"opencode:" (F45) so a
 *  non-claude-code-routed planner doesn't render as a bare, ambiguous
 *  model id. */
export function plannerModelLabel(pm: PlannerModel): string {
  const effort = pm.effort ? ` [effort: ${pm.effort}]` : " [effort: CLI default]";
  if (pm.runner === "codex") return `codex:${pm.model ?? "default"}${effort}`;
  if (pm.runner === "opencode") return `opencode:${pm.model ?? "default"}${effort}`;
  return `${pm.model ?? "claude"}${effort}`;
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
const FIGMA_PROBE_TIMEOUT_MS = 90 * 1_000;
const FIGMA_PROBE_MAX_OUTPUT_BYTES = 1 * 1024 * 1024;
const PLANNER_PROCESS_STARTED_AT_MS = Date.now();

const FIGMA_VERIFICATION_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["verified", "unavailable"] },
    references: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          nodeId: { type: "string" },
          name: { type: "string" },
          fileName: { type: ["string", "null"] },
          width: { type: ["number", "null"] },
          height: { type: ["number", "null"] },
        },
        required: ["index", "nodeId", "name", "fileName", "width", "height"],
        additionalProperties: false,
      },
    },
    issue: {
      type: "object",
      properties: {
        code: {
          type: "string",
          enum: [
            "none",
            "mcp_missing",
            "auth_required",
            "access_denied",
            "node_not_found",
            "timeout",
            "unavailable",
          ],
        },
        message: { type: "string" },
        referenceIndex: { type: ["integer", "null"] },
      },
      required: ["code", "message", "referenceIndex"],
      additionalProperties: false,
    },
  },
  required: ["status", "references", "issue"],
  additionalProperties: false,
} as const;

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
The task list is FLAT — never nest a "subtasks" or "children" array inside a task, and never emit
fields beyond the ones shown above. Aim for 3-12 tasks; each one should be an independently
mergeable, PR-sized unit of work. If a piece of work is too big for one task, split it into
multiple sequential tasks connected via dependsOn rather than nesting.

Rules for each task:
- description: a self-contained implementation handoff. State the intended behavior, important
  constraints/edge cases, and relevant existing code paths so the author does not need the planning
  transcript to understand the work. When applicable, end the description with these exact Markdown
  subsections (omit either entire subsection when it has no entries):
  - "### Relevant references": only the exact sources this task must inspect — for example
    "docs/PRD.md — Authentication / Login", "docs/specs/auth.md — Session rotation", or
    "context/attachments/login-copy.md". Preserve exact paths, PRD headings, attachment names, and
    external design links from the conversation/prior context/repository; do not invent pointers or
    copy large source contents into the task.
  - "### Required skills/capabilities": only skills the user explicitly named for the project, or
    fixed capabilities explicitly required by the agreed workflow (for example browser verification).
    Use "skill/capability — why it is needed"; never invent a skill name or assume that installing a
    skill configures an MCP/tool.
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
  is added automatically for every project to write the README/setup docs, and it runs
  LAST (after every other task) so it documents the finished project — only add your own
  docs-flavored task if the user asked for something beyond standard project
  documentation (e.g. a specific API reference doc).
- acceptanceCriteria: concrete, checkable statements
- dependsOn: indices of earlier tasks that must finish first
- scopePaths: glob(s) the task is allowed to modify. Cover EVERY file the task may plausibly
  touch, including shared wiring — package.json (and its lockfile) whenever the task adds a
  dependency or script, the entry-point file (index.html, src/main.tsx, the app router) whenever
  the task wires in a new module or page, and relevant tool config files when the task configures
  tooling. Prefer directory-level globs (e.g. "src/components/**") over lists of individual
  files. When in doubt, widen the scope — an over-narrow scope makes ordinary work look like a
  scope violation and forces a needless human review.

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

function figmaChatBlock(messages: PlanChatMessage[]): string {
  const intake = extractFigmaReferences(messages);
  if (
    intake.nodes.length === 0 &&
    intake.files.length === 0 &&
    intake.invalidNodeCount === 0 &&
    !intake.overLimit
  ) {
    return "";
  }

  const selected = intake.nodes
    .map((reference) => `- ${reference.canonicalUrl}`)
    .join("\n");
  const discovery = intake.files.map((url) => `- ${url}`).join("\n");
  return `

## Figma context
${selected
  ? `The user supplied these exact Figma selections:
${selected}

Use your configured Figma MCP/tool to open the selected nodes during this planning turn. Do not
claim a frame was inspected from the URL text alone. Ask about routes, data/auth state, responsive
variants, and interactions needed to reproduce each designed screen.`
  : ""}
${discovery
  ? `The user also supplied whole-file/page links without a selected node:
${discovery}

Treat these as discovery context only. Ask the user for one exact selection/node link per
canonical screen or state before promising close design fidelity.`
  : ""}
${intake.invalidNodeCount > 0
  ? "At least one Figma link has an invalid node-id. Ask for a fresh selection link from Figma."
  : ""}
${intake.overLimit
  ? `The conversation exceeds the ${MAX_FIGMA_REFERENCES}-link verification limit. Ask the user to keep only the canonical screens/states.`
  : ""}
`;
}

function verifiedFigmaBlock(references?: VerifiedFigmaReference[]): string {
  if (!references || references.length === 0) return "";
  const list = references
    .map((reference) => {
      const viewport =
        reference.width && reference.height
          ? ` (${reference.width}×${reference.height})`
          : "";
      return `- ${reference.name}${viewport} — ${reference.canonicalUrl}`;
    })
    .join("\n");
  return `

## Verified Figma screens
The routed deconstructor already opened these exact nodes through its configured Figma tool:
${list}

Map each screen only to tasks that implement or verify it. Put its canonical URL in that task's
\`### Relevant references\` section, require the author and validator to inspect it in
\`### Required skills/capabilities\`, and add a concrete acceptance criterion for close visual
fidelity at the verified viewport when dimensions are available. Make the implementation handoff
self-contained about the route plus auth/data/interaction state and fixture needed to reproduce
the screen; if the conversation/repository does not establish one of those facts, require the
author to derive and record it instead of inventing it. Do not attach a screen to an unrelated
backend/docs task, and do not create a separate visual-QA task — Hoopedorc inserts one
deterministically after deconstruction so the owner can review or remove it.
`;
}

function figmaDiscoveryDeconstructBlock(messages: PlanChatMessage[]): string {
  const intake = extractFigmaReferences(messages);
  if (intake.files.length === 0) return "";
  const list = intake.files.map((url) => `- ${url}`).join("\n");
  return `

## Unselected Figma discovery links
${list}

These links have no selected node. They may remain ordinary context, but they are NOT verified
fidelity references. Do not claim a screen matches them and do not add Figma-fidelity acceptance
criteria for them. The user can paste exact selection links in a later planning turn.
`;
}

function figmaAttachmentFallbackBlock(
  messages: PlanChatMessage[],
  attachments?: string[],
  enabled = false,
): string {
  if (!enabled) return "";
  const intake = extractFigmaReferences(messages);
  const selected = intake.nodes
    .map((reference) => `- ${reference.canonicalUrl}`)
    .join("\n");
  const files = (attachments ?? [])
    .map((name) => `- context/attachments/${name}`)
    .join("\n");
  return `

## Explicit screenshot fallback
Live-node verification was explicitly skipped after a capability failure. These exact Figma URLs
remain in the transcript for history but are NOT verified and must not appear in task descriptions
or acceptance criteria:
${selected || "- One or more invalid exact-node links (not retained)."}

Use only the uploaded attachment references below as visual sources. Label them as attachments,
not verified Figma nodes, and do not claim live-node fidelity:
${files || "- No attachment is available; do not add visual fidelity acceptance."}
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
${priorContextBlock(priorContext)}${attachmentsBlock(attachments)}${figmaChatBlock(messages)}
Conversation so far:
${transcript}

Reply as the Assistant to the latest User message.`;
}

export function buildDeconstructPrompt(
  messages: PlanChatMessage[],
  projectName: string,
  priorContext?: string,
  attachments?: string[],
  verifiedFigmaReferences?: VerifiedFigmaReference[],
  useFigmaAttachmentFallback = false,
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
${priorContextBlock(priorContext)}${attachmentsBlock(attachments)}${figmaDiscoveryDeconstructBlock(messages)}${figmaAttachmentFallbackBlock(messages, attachments, useFigmaAttachmentFallback)}${verifiedFigmaBlock(verifiedFigmaReferences)}
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
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
}

export type PlannerInvocationSink = (event: ModelInvocation) => void;

/** Run `claude -p --output-format json` and return its text + reported cost. */
async function runClaudeJson(
  prompt: string,
  cwd: string,
  model?: string,
  effort?: string,
  signal?: AbortSignal,
  timeoutMs = PLAN_TIMEOUT_MS,
  maxOutputBytes?: number,
): Promise<ClaudeJsonResult> {
  // Prompt goes on stdin, not argv: a long planning chat (full transcript +
  // prior-context inlined) can exceed macOS's ~1MB total argv cap and fail
  // with a cryptic spawn error. `claude -p` with no positional prompt reads
  // from stdin (verified against the real CLI).
  const args = ["-p", "--output-format", "json"];
  if (model) args.push("--model", model);
  args.push(...modelEffortArgs("claude-code", effort));
  const { stdout: out } = await execManagedProcess("claude", args, {
    cwd,
    env: sanitizedEnv({ PWD: cwd }),
    input: prompt,
    signal,
    timeoutMs,
    maxOutputBytes,
  });
  // claude --output-format json wraps the answer:
  // { ..., "result": "<text>", "total_cost_usd": <n> }
  try {
    const wrapper = JSON.parse(out) as {
      result?: unknown;
      total_cost_usd?: number;
      cost_usd?: number;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
    };
    const usage = wrapper.usage;
    return {
      text: typeof wrapper.result === "string" ? wrapper.result : out,
      costUsd: wrapper.total_cost_usd ?? wrapper.cost_usd ?? 0,
      tokensIn:
        (usage?.input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0),
      tokensOut: usage?.output_tokens ?? 0,
      tokensCached: usage?.cache_read_input_tokens ?? 0,
    };
  } catch {
    return { text: out, costUsd: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0 };
  }
}

/**
 * Run `codex exec` and return its final message text (F37's codex-planner
 * twin of `runClaudeJson`). `outputSchema`, when given, is written to a temp
 * file and passed as `--output-schema` so the CLI enforces the shape
 * natively (used for deconstruct; omitted for free-text chat turns).
 * `costUsd` is always 0 — subscription-billed, same honesty rule as F36's
 * `CodexAdapter`.
 */
async function runCodexJson(
  prompt: string,
  cwd: string,
  model?: string,
  effort?: string,
  outputSchema?: object,
  signal?: AbortSignal,
  timeoutMs = PLAN_TIMEOUT_MS,
  maxOutputBytes?: number,
): Promise<ClaudeJsonResult> {
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
    args.push(...modelEffortArgs("codex", effort));
    if (schemaFile) args.push("--output-schema", schemaFile);

    try {
      const { stdout } = await execManagedProcess("codex", args, {
        cwd,
        env: sanitizedEnv({ PWD: cwd }),
        input: prompt,
        signal,
        timeoutMs,
        maxOutputBytes,
      });
      // --output-last-message is only written on a successful turn (verified
      // live, F36) — an empty/missing file alongside a nonzero exit means the
      // turn failed before producing a message.
      let text = "";
      try {
        text = readFileSync(outputFile, "utf8");
      } catch {
        /* not written — turn failed before completing */
      }
      if (
        maxOutputBytes !== undefined &&
        Buffer.byteLength(text, "utf8") > maxOutputBytes
      ) {
        throw new Error("codex planner exceeded its output limit");
      }
      if (!text.trim()) {
        throw new Error("codex planner completed without a final message");
      }
      let tokensIn = 0;
      let tokensOut = 0;
      let tokensCached = 0;
      for (const line of stdout.split("\n")) {
        try {
          const event = JSON.parse(line) as {
            type?: string;
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              cached_input_tokens?: number;
            };
          };
          if (event.type !== "turn.completed" || !event.usage) continue;
          tokensCached = event.usage.cached_input_tokens ?? tokensCached;
          tokensIn = Math.max(
            0,
            (event.usage.input_tokens ?? 0) - tokensCached,
          );
          tokensOut = event.usage.output_tokens ?? tokensOut;
        } catch {
          /* non-JSON CLI log line */
        }
      }
      return { text: text.trim(), costUsd: 0, tokensIn, tokensOut, tokensCached };
    } finally {
      cleanup();
    }
}

/**
 * F45: run `opencode run -m <model> --format json` and return its
 * accumulated text + reported cost — the opencode-runner twin of
 * runClaudeJson/runCodexJson. Mirrors OpenCodeAdapter.runOnce's event-
 * parsing conventions (text/cost live under each JSON line's `part`) and,
 * critically, its B33 fix: `--dir <cwd>` is passed EXPLICITLY, not left to
 * the `PWD` env var alone — `PWD` only controls the working directory for
 * a LOCAL run; attaching to a shared server (`--attach`, when
 * `opencodeBaseUrl` is set) runs tool calls on the SERVER's own process,
 * which never inherits this client's env vars at all (live-verified
 * against the real CLI in B33). Getting this wrong here would mean the
 * planner reads/writes the wrong repo whenever a shared opencode server is
 * configured — the same class of bug B33 fixed for authoring.
 */
async function runOpencodeJson(
  prompt: string,
  cwd: string,
  model: string,
  effort: string | undefined,
  opencodeBaseUrl: string,
  signal?: AbortSignal,
  timeoutMs = PLAN_TIMEOUT_MS,
  maxOutputBytes?: number,
): Promise<ClaudeJsonResult> {
    // Prompt on stdin, not argv — same argv-cap reasoning as every other
    // planner/adapter spawn in this codebase.
    const args = ["run", "-m", model, "--format", "json", "--dir", cwd];
    args.push(...modelEffortArgs("opencode", effort));
    if (opencodeBaseUrl) args.push("--attach", opencodeBaseUrl);

    const { stdout } = await execManagedProcess("opencode", args, {
      cwd,
      env: sanitizedEnv({ PWD: cwd }),
      input: prompt,
      signal,
      timeoutMs,
      maxOutputBytes,
    });
    let costUsd = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let tokensCached = 0;
    let text = "";

    const handleEvent = (obj: Record<string, unknown>) => {
      const part = obj.part as
        | {
            text?: string;
            cost?: number;
            tokens?: {
              input?: number;
              output?: number;
              cache?: { read?: number; write?: number };
            };
          }
        | undefined;
      if (typeof part?.text === "string") text += part.text;
      if (typeof part?.cost === "number") costUsd += part.cost;
      if (part?.tokens) {
        tokensIn += (part.tokens.input ?? 0) + (part.tokens.cache?.write ?? 0);
        tokensOut += part.tokens.output ?? 0;
        tokensCached += part.tokens.cache?.read ?? 0;
      }
    };

    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        handleEvent(JSON.parse(trimmed));
      } catch {
        /* non-JSON log line */
      }
    }
    return { text, costUsd, tokensIn, tokensOut, tokensCached };
}

/** Dispatch to the right CLI for whichever model `routing.planner` resolves to. */
async function runPlannerJson(
  prompt: string,
  cwd: string,
  plannerModel: PlannerModel,
  outputSchema?: object,
  signal?: AbortSignal,
  stage: ModelInvocation["stage"] = "planner",
  onInvocation?: PlannerInvocationSink,
  limits?: { timeoutMs?: number; maxOutputBytes?: number },
): Promise<ClaudeJsonResult> {
  const startedAt = new Date().toISOString();
  const base = {
    id: `${stage}-${randomUUID()}`,
    stage,
    model: plannerModel.id ?? plannerModel.model ?? "unknown",
    runner: plannerModel.runner,
    effort: plannerModel.effort ?? "default",
    startedAt,
  } satisfies Pick<
    ModelInvocation,
    "id" | "stage" | "model" | "runner" | "effort" | "startedAt"
  >;
  onInvocation?.({
    ...base,
    outcome: "running",
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    tokensCached: 0,
  });
  try {
    let result: ClaudeJsonResult;
    if (plannerModel.runner === "codex") {
      result = await runCodexJson(
        prompt,
        cwd,
        plannerModel.model,
        plannerModel.effort,
        outputSchema,
        signal,
        limits?.timeoutMs,
        limits?.maxOutputBytes,
      );
    } else if (plannerModel.runner === "opencode") {
      if (!plannerModel.model) {
        throw new Error("opencode planner model has no model id configured");
      }
      result = await runOpencodeJson(
        prompt,
        cwd,
        plannerModel.model,
        plannerModel.effort,
        plannerModel.opencodeBaseUrl ?? "",
        signal,
        limits?.timeoutMs,
        limits?.maxOutputBytes,
      );
    } else {
      result = await runClaudeJson(
        prompt,
        cwd,
        plannerModel.model,
        plannerModel.effort,
        signal,
        limits?.timeoutMs,
        limits?.maxOutputBytes,
      );
    }
    onInvocation?.({
      ...base,
      endedAt: new Date().toISOString(),
      outcome: "completed",
      exitReason: "completed",
      costUsd: result.costUsd,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      tokensCached: result.tokensCached,
    });
    return result;
  } catch (err) {
    onInvocation?.({
      ...base,
      endedAt: new Date().toISOString(),
      outcome: signal?.aborted ? "stopped" : "failed",
      exitReason: signal?.aborted ? "killed" : "error",
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      tokensCached: 0,
    });
    throw err;
  }
}

/**
 * B31: extract the JSON object from a planner response. The claude path has
 * no `--output-schema` enforcement, so the model's response is either pure
 * JSON or JSON wrapped in a single outer markdown fence — but a real plan's
 * "prd"/"agentsMd"/description STRINGS routinely contain their own code
 * fences (a fenced file tree, an install command, `prisma/schema.prisma`
 * mentioned in a snippet). The previous regex
 * (`/\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/`) was unanchored and non-greedy, so
 * on a pure-JSON response it latched onto the FIRST pair of fences it found
 * — which live inside a string value, not around the whole response — and
 * "extracted" the garbage between them (a fenced snippet fragment), which
 * then failed `JSON.parse` with a confusing "Unexpected token" error. Fixed
 * by only treating fences as a whole-response wrapper (anchored at both
 * ends) and preferring brace-slicing whenever the response already looks
 * like bare JSON.
 */
export function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  // Already looks like bare JSON — never consult the fence regex, since any
  // fence living inside a string value would otherwise be mismatched as a
  // wrapper (the original bug).
  if (trimmed.startsWith("{")) {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    return start !== -1 && end > start ? trimmed.slice(start, end + 1) : trimmed;
  }
  // Only matches a fence that wraps the ENTIRE response (anchored + greedy),
  // so an inner fence inside a string value can never match here either.
  const wrapped = trimmed.match(/^```(?:json)?\s*([\s\S]*)```\s*$/);
  if (wrapped && wrapped[1]) return wrapped[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

/**
 * B31 layer 2: models routinely emit raw newlines/tabs inside JSON string
 * values (a multi-line "prd"/"description" field) — invalid JSON, since a
 * literal control character inside a string must be escaped. Walks the text
 * tracking in-string state (respecting `\"` escapes) and escapes any raw
 * \n/\r/\t found INSIDE a string literal only; everything outside strings
 * (including already-valid escapes) passes through unchanged.
 */
function repairJsonControlChars(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = false;
      out += ch;
      continue;
    }
    if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else out += ch;
  }
  return out;
}

/** B31: parse the planner's JSON, retrying once with control-char repair
 *  before giving up — the single most common way a model produces
 *  otherwise-well-formed-looking JSON that still fails to parse. On total
 *  failure, throws the ORIGINAL error (more useful for diagnosis than the
 *  repair pass's own, usually-confusing, secondary failure). */
function parseJsonWithRepair(text: string): unknown {
  const extracted = extractJsonObject(text);
  try {
    return JSON.parse(extracted);
  } catch (err) {
    try {
      return JSON.parse(repairJsonControlChars(extracted));
    } catch {
      throw err;
    }
  }
}

export class FigmaVerificationError extends Error {
  override name = "FigmaVerificationError";

  constructor(
    readonly issue: FigmaCapabilityIssue,
    readonly costUsd = 0,
  ) {
    super(issue.message);
  }
}

const FIGMA_ACTIONS = [
  "Fix or re-authenticate Figma MCP for this runner, then retry.",
  "Select another Figma-capable planner/deconstructor model in Settings.",
  "Attach screenshots, then continue with attachment-only visual context.",
];

export const FIGMA_AUTHOR_ACTIONS = [
  "Fix or re-authenticate Figma MCP for this runner, then Retry the task.",
  "Reassign the task to another Figma-capable model, then Retry it.",
];

export interface FigmaVerificationIssueContext {
  stage?: FigmaCapabilityIssue["stage"];
  actions?: readonly string[];
}

function issueMessage(code: FigmaCapabilityIssueCode): string {
  switch (code) {
    case "figma_invalid_node":
      return "A Figma link contains an invalid node-id; paste a fresh selection link from Figma.";
    case "figma_reference_limit":
      return `This plan contains more than ${MAX_FIGMA_REFERENCES} Figma links; keep only canonical screens and states.`;
    case "figma_mcp_missing":
      return "The selected runner does not have an available Figma MCP/tool.";
    case "figma_auth_required":
      return "The selected runner's Figma MCP needs authentication.";
    case "figma_access_denied":
      return "The selected runner cannot access the referenced Figma file.";
    case "figma_node_not_found":
      return "The referenced Figma node could not be found or opened.";
    case "figma_timeout":
      return "Figma verification timed out before the selected runner opened the node.";
    case "figma_malformed_response":
      return "The selected runner did not return verifiable Figma frame metadata.";
    default:
      return "The selected runner could not verify the referenced Figma node.";
  }
}

function makeFigmaIssue(
  code: FigmaCapabilityIssueCode,
  plannerModel: PlannerModel,
  reference?: FigmaNodeReferenceInput,
  context: FigmaVerificationIssueContext = {},
): FigmaCapabilityIssue {
  return {
    stage: context.stage ?? "deconstruction",
    code,
    model: plannerModel.id ?? plannerModel.model ?? "unknown",
    runner: plannerModel.runner,
    message: issueMessage(code),
    actions: [...(context.actions ?? FIGMA_ACTIONS)],
    canonicalUrl: reference?.canonicalUrl,
    nodeId: reference?.nodeId,
  };
}

function classifyFigmaFailure(err: unknown): FigmaCapabilityIssueCode {
  const message = err instanceof Error ? err.message : String(err);
  if (/timed?\s*out|timeout/iu.test(message)) return "figma_timeout";
  if (/unauthori[sz]ed|auth(?:entication)?|log ?in|sign ?in|401|token/iu.test(message)) {
    return "figma_auth_required";
  }
  if (/access denied|permission|forbidden|403|inaccessible/iu.test(message)) {
    return "figma_access_denied";
  }
  if (/node.{0,30}(?:not found|missing|invalid)|\b404\b/iu.test(message)) {
    return "figma_node_not_found";
  }
  if (/mcp.{0,40}(?:missing|not found|unavailable|not configured)|no such tool/iu.test(message)) {
    return "figma_mcp_missing";
  }
  return "figma_unavailable";
}

export function buildFigmaVerificationPrompt(
  references: FigmaNodeReferenceInput[],
): string {
  const list = references
    .map(
      (reference, index) =>
        `${index}. nodeId=${reference.nodeId} url=${reference.canonicalUrl}`,
    )
    .join("\n");
  return `Verify exact Figma selections for a coding plan.

Use the Figma MCP/tool configured in this runner to ACTUALLY OPEN every node below. Do not infer
metadata from URL text and do not use web search. Return only the JSON object described below.

${list}

On success return:
{"status":"verified","references":[{"index":0,"nodeId":"1:2","name":"real frame name","fileName":"real file name or null","width":1440,"height":900}],"issue":{"code":"none","message":"","referenceIndex":null}}

There must be exactly one reference result per requested index. Use the exact addressed node id,
the real frame/screen name, and viewport dimensions when the tool provides them (otherwise null).

If any node cannot be opened, fail closed and return no references:
{"status":"unavailable","references":[],"issue":{"code":"mcp_missing|auth_required|access_denied|node_not_found|timeout|unavailable","message":"short secret-free explanation","referenceIndex":0}}

Never include credentials, MCP headers, environment values, unrelated query parameters, raw Figma
payloads, or commentary.`;
}

function rawIssueCode(value: unknown): FigmaCapabilityIssueCode {
  switch (value) {
    case "mcp_missing":
      return "figma_mcp_missing";
    case "auth_required":
      return "figma_auth_required";
    case "access_denied":
      return "figma_access_denied";
    case "node_not_found":
      return "figma_node_not_found";
    case "timeout":
      return "figma_timeout";
    default:
      return "figma_unavailable";
  }
}

function cachedFigmaReferences(
  requested: FigmaNodeReferenceInput[],
  plannerModel: PlannerModel,
  cached?: VerifiedFigmaReference[],
): VerifiedFigmaReference[] | null {
  if (!cached || cached.length !== requested.length) return null;
  const expectedModel = plannerModel.id ?? plannerModel.model ?? "unknown";
  if (
    cached.some(
      (reference) =>
        reference.verifiedModel !== expectedModel ||
        reference.verifiedRunner !== plannerModel.runner ||
        !Number.isFinite(Date.parse(reference.verifiedAt)) ||
        Date.parse(reference.verifiedAt) < PLANNER_PROCESS_STARTED_AT_MS,
    )
  ) {
    return null;
  }
  const byUrl = new Map(cached.map((reference) => [reference.canonicalUrl, reference]));
  const ordered = requested.map((reference) => byUrl.get(reference.canonicalUrl));
  return ordered.every(
    (reference): reference is VerifiedFigmaReference => Boolean(reference),
  )
    ? ordered
    : null;
}

export async function verifyFigmaReferences(
  requested: FigmaNodeReferenceInput[],
  cwd: string,
  plannerModel: PlannerModel,
  signal?: AbortSignal,
  onInvocation?: PlannerInvocationSink,
  issueContext: FigmaVerificationIssueContext = {},
): Promise<{ references: VerifiedFigmaReference[]; costUsd: number }> {
  let result: ClaudeJsonResult;
  try {
    result = await runPlannerJson(
      buildFigmaVerificationPrompt(requested),
      cwd,
      plannerModel,
      plannerModel.runner === "codex" ? FIGMA_VERIFICATION_SCHEMA : undefined,
      signal,
      "health",
      onInvocation,
      {
        timeoutMs: FIGMA_PROBE_TIMEOUT_MS,
        maxOutputBytes: FIGMA_PROBE_MAX_OUTPUT_BYTES,
      },
    );
  } catch (err) {
    throw new FigmaVerificationError(
      makeFigmaIssue(
        classifyFigmaFailure(err),
        plannerModel,
        requested[0],
        issueContext,
      ),
    );
  }

  let parsed: {
    status?: unknown;
    references?: unknown;
    issue?: { code?: unknown; referenceIndex?: unknown };
  };
  try {
    parsed = parseJsonWithRepair(result.text) as typeof parsed;
  } catch {
    throw new FigmaVerificationError(
      makeFigmaIssue(
        "figma_malformed_response",
        plannerModel,
        requested[0],
        issueContext,
      ),
      result.costUsd,
    );
  }

  if (parsed.status !== "verified") {
    const referenceIndex =
      typeof parsed.issue?.referenceIndex === "number" &&
      Number.isInteger(parsed.issue.referenceIndex)
        ? parsed.issue.referenceIndex
        : 0;
    throw new FigmaVerificationError(
      makeFigmaIssue(
        rawIssueCode(parsed.issue?.code),
        plannerModel,
        requested[referenceIndex] ?? requested[0],
        issueContext,
      ),
      result.costUsd,
    );
  }

  if (parsed.issue?.code !== "none") {
    throw new FigmaVerificationError(
      makeFigmaIssue(
        "figma_malformed_response",
        plannerModel,
        requested[0],
        issueContext,
      ),
      result.costUsd,
    );
  }

  if (!Array.isArray(parsed.references)) {
    throw new FigmaVerificationError(
      makeFigmaIssue(
        "figma_malformed_response",
        plannerModel,
        requested[0],
        issueContext,
      ),
      result.costUsd,
    );
  }
  const normalized = normalizeVerifiedFigmaReferences(
    requested,
    parsed.references,
    plannerModel.id ?? plannerModel.model ?? "unknown",
    plannerModel.runner,
    new Date().toISOString(),
  );
  if (!normalized) {
    throw new FigmaVerificationError(
      makeFigmaIssue(
        "figma_malformed_response",
        plannerModel,
        requested[0],
        issueContext,
      ),
      result.costUsd,
    );
  }
  return { references: normalized, costUsd: result.costUsd };
}

function appendMarkdownList(
  description: string,
  heading: string,
  entries: string[],
): string {
  const missingEntries = entries.filter(
    (entry) => !description.includes(`- ${entry}`),
  );
  if (missingEntries.length === 0) return description;
  const block = missingEntries.map((entry) => `- ${entry}`).join("\n");
  const index = description.indexOf(heading);
  if (index === -1) return `${description.trimEnd()}\n\n${heading}\n${block}`;
  const afterHeading = index + heading.length;
  const nextHeading = description.indexOf("\n### ", afterHeading);
  const insertAt = nextHeading === -1 ? description.length : nextHeading;
  return `${description.slice(0, insertAt).trimEnd()}\n${block}\n${description.slice(insertAt).trimStart()}`;
}

/**
 * The deconstructor is asked to map references semantically. This small
 * fail-safe ensures a model omission cannot make a successfully verified
 * screen disappear from every implementation handoff.
 */
export function ensureVerifiedFigmaTaskHandoff(
  output: PlanOutput,
  references: VerifiedFigmaReference[],
): PlanOutput {
  const missing = references.filter(
    (reference) =>
      !output.tasks.some(
        (task) =>
          task.description.includes(reference.canonicalUrl) ||
          task.acceptanceCriteria.some((criterion) =>
            criterion.includes(reference.canonicalUrl),
          ),
      ),
  );
  if (missing.length === 0 || output.tasks.length === 0) return output;

  const taskIndex = output.tasks.findIndex(
    (task) =>
      task.role === "frontend" ||
      task.scopePaths.some((path) =>
        /(?:^|\/)(?:app|web|ui|client|components?|pages?)(?:\/|$)/iu.test(path),
      ),
  );
  const target = output.tasks[taskIndex === -1 ? 0 : taskIndex]!;
  target.description = appendMarkdownList(
    target.description,
    "### Relevant references",
    missing.map(
      (reference) => `${reference.name} — ${reference.canonicalUrl}`,
    ),
  );
  target.description = appendMarkdownList(
    target.description,
    "### Required skills/capabilities",
    [
      "figma — inspect the referenced nodes before implementation",
      "figma-implement-design — use for the implementation pass",
      "browser verification — exercise the real screen at the referenced viewports",
    ],
  );
  for (const reference of missing) {
    const viewport =
      reference.width && reference.height
        ? ` at ${reference.width}×${reference.height}`
        : "";
    target.acceptanceCriteria.push(
      `${reference.name} closely matches ${reference.canonicalUrl}${viewport}.`,
    );
  }
  return output;
}

function removeUnverifiedFigmaTaskClaims(
  output: PlanOutput,
): PlanOutput {
  const containsFigmaUrl = (value: string) =>
    /https?:\/\/(?:www\.)?figma\.com\//iu.test(value);
  for (const task of output.tasks) {
    task.description = task.description
      .split("\n")
      .filter(
        (line) =>
          !containsFigmaUrl(line) &&
          !/^\s*-\s*figma(?:-implement-design)?\b/iu.test(line),
      )
      .join("\n")
      .replace(
        /^### (?:Relevant references|Required skills\/capabilities)\s*(?=### |\s*$)/gmu,
        "",
      )
      .replace(/\n{3,}/gu, "\n\n")
      .trim();
    task.acceptanceCriteria = task.acceptanceCriteria.filter(
      (criterion) =>
        !containsFigmaUrl(criterion) &&
        !(
          /\bfigma\b/iu.test(criterion) &&
          /\b(?:match|fidelity|pixel|visual)\b/iu.test(criterion)
        ),
    );
    if (task.acceptanceCriteria.length === 0) {
      task.acceptanceCriteria = [defaultAcceptanceCriterion(task.description)];
    }
  }
  return output;
}

/**
 * B31 layer 3: the final fallback when parsing (or F46's post-parse
 * validation below) still fails after the repair pass — one re-ask of the
 * SAME planner model, given the parse error and a snippet of its own
 * invalid output, asking for a clean re-emit. Exactly one retry: a model
 * that can't produce valid JSON twice in a row won't on a third try either,
 * and every retry spends real money.
 */
function buildJsonRepairRetryPrompt(err: unknown, invalidText: string): string {
  const message = err instanceof Error ? err.message : String(err);
  const snippet = invalidText.slice(0, 500);
  return `Your previous response could not be parsed as valid JSON: ${message}

Here is the start of what you sent (truncated):
---
${snippet}
---

Respond again with ONLY the complete, valid JSON object described earlier — no markdown fences,
no commentary, no truncation, and no code fences anywhere inside string values (write multi-line
content as \\n-escaped text instead). Re-emit the ENTIRE object.`;
}

const DIFFICULTIES = new Set<Difficulty>(["easy", "medium", "hard"]);
const MAX_PLANNED_TASKS = 30;

/**
 * F46: recursively-nested output flattened to one level. Any task carrying a
 * `subtasks`/`children` array has those entries spliced in immediately after
 * it, each pointed at the parent via `dependsOn` (overriding whatever
 * dependsOn the child itself claimed — the parent relationship is the
 * trustworthy one here). Only one level is flattened; a child's own nested
 * subtasks (vanishingly rare in practice) are dropped along with the other
 * unrecognized fields. Non-object entries are dropped outright. Top-level
 * tasks' own `dependsOn` values are remapped through the index shift the
 * splicing introduces, so a later top-level task that depended on an
 * earlier one still points at the right task after flattening.
 */
export function flattenRawTasks(raw: unknown[]): Record<string, unknown>[] {
  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

  // rawIndex -> its new index in the flattened output (undefined for a
  // dropped non-object entry), so a sibling's dependsOn — which references
  // positions in the model's own emitted array, dropped garbage included —
  // is corrected for BOTH shifts this function introduces: children spliced
  // in ahead of it, and non-object entries dropped before it. Keying this by
  // raw index (not filtered position) is what keeps a dependency declared
  // past a dropped entry pointing at the task it meant instead of the one
  // that slid into its slot.
  const remap: (number | undefined)[] = [];
  let cursor = 0;
  for (const entry of raw) {
    if (!isPlainObject(entry)) {
      remap.push(undefined);
      continue;
    }
    remap.push(cursor);
    const nested = Array.isArray(entry.subtasks)
      ? entry.subtasks
      : Array.isArray(entry.children)
        ? entry.children
        : [];
    cursor += 1 + nested.filter(isPlainObject).length;
  }

  const flat: Record<string, unknown>[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) continue;
    const { subtasks, children, dependsOn, ...parentFields } = entry;
    const remappedDependsOn = Array.isArray(dependsOn)
      ? dependsOn
          .map((n) => (typeof n === "number" ? remap[n] : undefined))
          .filter((n): n is number => typeof n === "number")
      : dependsOn;
    const parentIndex = flat.length;
    flat.push({ ...parentFields, dependsOn: remappedDependsOn });

    const nested = Array.isArray(subtasks) ? subtasks : Array.isArray(children) ? children : [];
    for (const child of nested.filter(isPlainObject)) {
      const { subtasks: _cs, children: _cc, dependsOn: _cd, ...childFields } = child;
      flat.push({ ...childFields, dependsOn: [parentIndex] });
    }
  }
  return flat;
}

function isEmptyTaskLike(t: Record<string, unknown>): boolean {
  const title = typeof t.title === "string" ? t.title.trim() : "";
  const description = typeof t.description === "string" ? t.description.trim() : "";
  return title === "" && description === "";
}

function defaultAcceptanceCriterion(description: string): string {
  const firstLine = description.split("\n")[0]?.trim();
  return firstLine || "The implementation matches the task description.";
}

/** F46: suffix " (2)", " (3)", … onto later occurrences of a duplicate
 *  title — a model occasionally repeats a title verbatim across tasks,
 *  which reads confusingly on the Board. Mutates in place. */
function dedupeTaskTitles(tasks: PlannedTask[]): void {
  const counts = new Map<string, number>();
  for (const t of tasks) {
    const base = t.title;
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    if (n > 1) t.title = `${base} (${n})`;
  }
}

/** Parse a raw planner JSON string into a normalized PlanOutput. F46 hardens
 *  this against a model emitting nested subtasks, empty tasks, an
 *  unreasonably long list, or duplicate titles — defensive parsing for
 *  paths (claude, and F45's opencode) with no native output-schema
 *  enforcement. `onWarn` is optional and defaults to a no-op; callers with a
 *  logger (index.ts) pass one so drops/caps aren't silent. */
export function parsePlanOutput(
  text: string,
  projectName: string,
  goal = "",
  onWarn: (msg: string) => void = () => {},
): PlanOutput {
  const parsed = parseJsonWithRepair(text) as {
    prd?: string;
    agentsMd?: string;
    tasks?: unknown[];
  };

  if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
    throw new Error("planner returned no tasks");
  }

  const flattened = flattenRawTasks(parsed.tasks);

  // Dropping an empty entry shifts every later index, so surviving tasks'
  // dependsOn must be remapped through that shift (same reasoning as
  // flattenRawTasks' own remap) — otherwise a dependency declared past a
  // dropped slot silently lands on whichever task slid into it. A reference
  // TO a dropped task is itself dropped.
  const emptyRemap: (number | undefined)[] = [];
  let keptCount = 0;
  for (const t of flattened) emptyRemap.push(isEmptyTaskLike(t) ? undefined : keptCount++);

  let candidates = flattened
    .filter((t) => !isEmptyTaskLike(t))
    .map((t) =>
      Array.isArray(t.dependsOn)
        ? {
            ...t,
            dependsOn: t.dependsOn
              .map((n) => (typeof n === "number" ? emptyRemap[n] : undefined))
              .filter((n): n is number => typeof n === "number"),
          }
        : t,
    );
  const droppedEmpty = flattened.length - candidates.length;
  if (droppedEmpty > 0) {
    onWarn(`planner: dropped ${droppedEmpty} task(s) with no title or description`);
  }

  if (candidates.length === 0) {
    throw new Error("planner returned no valid tasks after validation");
  }

  if (candidates.length > MAX_PLANNED_TASKS) {
    onWarn(`planner: capped ${candidates.length} tasks down to ${MAX_PLANNED_TASKS}`);
    candidates = candidates.slice(0, MAX_PLANNED_TASKS);
  }

  const tasks: PlannedTask[] = candidates.map((raw, i) => {
    const t = raw;
    const difficulty = DIFFICULTIES.has(t.difficulty as Difficulty)
      ? (t.difficulty as Difficulty)
      : "medium";
    const description = String(t.description ?? "");
    return {
      title: String(t.title ?? `Task ${i + 1}`),
      description,
      difficulty,
      role: typeof t.role === "string" ? (t.role as Role) : undefined,
      acceptanceCriteria:
        Array.isArray(t.acceptanceCriteria) && t.acceptanceCriteria.length > 0
          ? t.acceptanceCriteria.map(String)
          : [defaultAcceptanceCriterion(description)],
      dependsOn: Array.isArray(t.dependsOn)
        ? t.dependsOn.map(Number).filter((n) => Number.isInteger(n) && n < i)
        : [],
      scopePaths: Array.isArray(t.scopePaths) ? t.scopePaths.map(String) : ["**/*"],
    };
  });

  dedupeTaskTitles(tasks);

  return {
    prdMarkdown: String(parsed.prd ?? `# ${projectName}\n\n${goal}`),
    agentsMd: String(parsed.agentsMd ?? ""),
    tasks,
  };
}

/** Single-shot planner: goal -> PRD + DAG. Used by the legacy /plan endpoint.
 *  `onWarn` surfaces F46 drop/cap warnings; defaults to a no-op. */
export async function runPlanner(
  goal: string,
  projectName: string,
  cwd: string,
  plannerModel: PlannerModel,
  onWarn: (msg: string) => void = () => {},
  signal?: AbortSignal,
  onInvocation?: PlannerInvocationSink,
): Promise<PlanOutput> {
  const schema = plannerModel.runner === "codex" ? DECONSTRUCT_JSON_SCHEMA : undefined;
  const prompt = buildPrompt(goal, projectName);
  const { text } = await runPlannerJson(
    prompt,
    cwd,
    plannerModel,
    schema,
    signal,
    "deconstructor",
    onInvocation,
  );
  try {
    return parsePlanOutput(text, projectName, goal, onWarn);
  } catch (err) {
    // B31 layer 3: one re-ask retry before giving up.
    onWarn(
      `planner: output failed to parse (${err instanceof Error ? err.message : String(err)}) — retrying once`,
    );
    const retry = await runPlannerJson(
      buildJsonRepairRetryPrompt(err, text),
      cwd,
      plannerModel,
      schema,
      signal,
      "deconstructor",
      onInvocation,
    );
    return parsePlanOutput(retry.text, projectName, goal, onWarn);
  }
}

/** One conversational planning turn (the planner model, claude or codex). Returns reply text + cost. */
export async function runPlannerChat(
  messages: PlanChatMessage[],
  projectName: string,
  cwd: string,
  plannerModel: PlannerModel,
  priorContext?: string,
  attachments?: string[],
  signal?: AbortSignal,
  onInvocation?: PlannerInvocationSink,
): Promise<{ reply: string; costUsd: number }> {
  const { text, costUsd } = await runPlannerJson(
    buildChatPrompt(messages, projectName, priorContext, attachments),
    cwd,
    plannerModel,
    undefined,
    signal,
    "planner",
    onInvocation,
  );
  return { reply: text.trim(), costUsd };
}

/** Deconstruct an agreed conversation into a strict task DAG (same planner
 *  model as chat). `onWarn` surfaces F46 drop/cap warnings and B31's retry
 *  notice; defaults to a no-op. */
export async function runPlannerDeconstruct(
  messages: PlanChatMessage[],
  projectName: string,
  cwd: string,
  plannerModel: PlannerModel,
  priorContext?: string,
  attachments?: string[],
  onWarn: (msg: string) => void = () => {},
  signal?: AbortSignal,
  onInvocation?: PlannerInvocationSink,
  cachedVerifiedFigmaReferences?: VerifiedFigmaReference[],
  onVerifiedFigmaReferences?: (references: VerifiedFigmaReference[]) => void,
  figmaVerification: "live" | "attachments" = "live",
): Promise<{
  output: PlanOutput;
  costUsd: number;
  verifiedFigmaReferences?: VerifiedFigmaReference[];
}> {
  const intake = extractFigmaReferences(messages);
  const useFigmaAttachmentFallback =
    figmaVerification === "attachments" &&
    (intake.nodes.length > 0 || intake.invalidNodeCount > 0);
  if (!useFigmaAttachmentFallback && intake.overLimit) {
    throw new FigmaVerificationError(
      makeFigmaIssue("figma_reference_limit", plannerModel),
    );
  }
  if (!useFigmaAttachmentFallback && intake.invalidNodeCount > 0) {
    throw new FigmaVerificationError(
      makeFigmaIssue("figma_invalid_node", plannerModel),
    );
  }

  let verifiedFigmaReferences: VerifiedFigmaReference[] | undefined;
  let verificationCostUsd = 0;
  if (intake.nodes.length > 0 && !useFigmaAttachmentFallback) {
    verifiedFigmaReferences =
      cachedFigmaReferences(
        intake.nodes,
        plannerModel,
        cachedVerifiedFigmaReferences,
      ) ?? undefined;
    if (!verifiedFigmaReferences) {
      const verification = await verifyFigmaReferences(
        intake.nodes,
        cwd,
        plannerModel,
        signal,
        onInvocation,
      );
      verifiedFigmaReferences = verification.references;
      verificationCostUsd = verification.costUsd;
      onVerifiedFigmaReferences?.(verifiedFigmaReferences);
    }
  }

  const schema = plannerModel.runner === "codex" ? DECONSTRUCT_JSON_SCHEMA : undefined;
  const prompt = buildDeconstructPrompt(
    messages,
    projectName,
    priorContext,
    attachments,
    verifiedFigmaReferences,
    useFigmaAttachmentFallback,
  );
  const { text, costUsd } = await runPlannerJson(
    prompt,
    cwd,
    plannerModel,
    schema,
    signal,
    "deconstructor",
    onInvocation,
  );
  try {
    const parsedOutput = parsePlanOutput(text, projectName, "", onWarn);
    const output = useFigmaAttachmentFallback
      ? removeUnverifiedFigmaTaskClaims(parsedOutput)
      : parsedOutput;
    return {
      output: verifiedFigmaReferences
        ? ensureVerifiedFigmaTaskHandoff(output, verifiedFigmaReferences)
        : output,
      costUsd: verificationCostUsd + costUsd,
      verifiedFigmaReferences,
    };
  } catch (err) {
    // B31 layer 3: one re-ask retry before giving up. Each CLI call gets its
    // own invocation row; `costUsd` still accumulates for the API response.
    onWarn(
      `planner: deconstruct output failed to parse (${err instanceof Error ? err.message : String(err)}) — retrying once`,
    );
    const retry = await runPlannerJson(
      buildJsonRepairRetryPrompt(err, text),
      cwd,
      plannerModel,
      schema,
      signal,
      "deconstructor",
      onInvocation,
    );
    const parsedOutput = parsePlanOutput(retry.text, projectName, "", onWarn);
    const output = useFigmaAttachmentFallback
      ? removeUnverifiedFigmaTaskClaims(parsedOutput)
      : parsedOutput;
    return {
      output: verifiedFigmaReferences
        ? ensureVerifiedFigmaTaskHandoff(output, verifiedFigmaReferences)
        : output,
      costUsd: verificationCostUsd + costUsd + retry.costUsd,
      verifiedFigmaReferences,
    };
  }
}
