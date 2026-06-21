import { spawn } from "node:child_process";
import type { Difficulty, PlanChatMessage, Role } from "@orc/types";

// Planning runs Claude Code headless. Two tiers (see docs/NEXT_STEPS.md):
//   - chat turns           -> Sonnet (many cheap conversational turns)
//   - final deconstruction  -> Opus  (one high-leverage call: plan -> task DAG)
// Both go through `claude -p`; the model is selected with `--model`.

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
}

const PLAN_TIMEOUT_MS = 5 * 60 * 1000;

const DECONSTRUCT_SHAPE = `Respond with ONLY a JSON object, no markdown fences, in this exact shape:
{
  "prd": "markdown string",
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
- difficulty: "easy" | "medium" | "hard"
- role (optional): "frontend" | "docs" | "hard" | "medium" | "updates"
- acceptanceCriteria: concrete, checkable statements
- dependsOn: indices of earlier tasks that must finish first
- scopePaths: glob(s) the task is allowed to modify`;

function buildPrompt(goal: string, projectName: string): string {
  return `You are the planning agent for an autonomous multi-model coding team.
Plan the project "${projectName}" for this goal:

${goal}

Produce a short PRD and break the work into a dependency-ordered task DAG.
${DECONSTRUCT_SHAPE}`;
}

const CHAT_SYSTEM = `You are the planning collaborator for an autonomous multi-model coding team.
Talk with the user to shape WHAT to build and how to break it into tasks. Be concise and
concrete: propose a small set of dependency-ordered tasks, ask clarifying questions when scope
is ambiguous, and adapt when the user says things like "split that task", "add tests", or
"don't touch the DB". Keep replies short — this is a planning chat, not an essay. Do NOT output
JSON; a separate step turns the agreed plan into a structured task list.

When you are satisfied that the plan is complete — you have no more clarifying questions, no
outstanding ambiguities, and the scope/tasks are well-defined — end your reply with exactly
this token on its own line: [PLAN_COMPLETE]
Only emit [PLAN_COMPLETE] once you are genuinely ready; do not emit it mid-conversation.`;

function buildChatPrompt(messages: PlanChatMessage[], projectName: string): string {
  const transcript = messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");
  return `${CHAT_SYSTEM}

Project: "${projectName}"

Conversation so far:
${transcript}

Reply as the Assistant to the latest User message.`;
}

function buildDeconstructPrompt(
  messages: PlanChatMessage[],
  projectName: string,
): string {
  const transcript = messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");
  return `You are the planning agent for an autonomous multi-model coding team.
Below is a planning conversation for the project "${projectName}". Turn the AGREED plan into a
short PRD and a dependency-ordered task DAG. Honor every constraint the user stated.

## Planning conversation
${transcript}

${DECONSTRUCT_SHAPE}`;
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
    const args = ["-p", prompt, "--output-format", "json"];
    if (model) args.push("--model", model);
    const proc = spawn("claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
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
    tasks,
  };
}

/** Single-shot planner: goal -> PRD + DAG. Used by the legacy /plan endpoint. */
export async function runPlanner(
  goal: string,
  projectName: string,
  cwd: string,
  model?: string,
): Promise<PlanOutput> {
  const { text } = await runClaudeJson(buildPrompt(goal, projectName), cwd, model);
  return parsePlanOutput(text, projectName, goal);
}

/** One conversational planning turn (Sonnet). Returns reply text + cost. */
export async function runPlannerChat(
  messages: PlanChatMessage[],
  projectName: string,
  cwd: string,
  model?: string,
): Promise<{ reply: string; costUsd: number }> {
  const { text, costUsd } = await runClaudeJson(
    buildChatPrompt(messages, projectName),
    cwd,
    model,
  );
  return { reply: text.trim(), costUsd };
}

/** Deconstruct an agreed conversation into a strict task DAG (Opus). */
export async function runPlannerDeconstruct(
  messages: PlanChatMessage[],
  projectName: string,
  cwd: string,
  model?: string,
): Promise<{ output: PlanOutput; costUsd: number }> {
  const { text, costUsd } = await runClaudeJson(
    buildDeconstructPrompt(messages, projectName),
    cwd,
    model,
  );
  return { output: parsePlanOutput(text, projectName), costUsd };
}
