import { spawn } from "node:child_process";
import type { Difficulty, Role } from "@orc/types";

// Real planner: runs Claude Code headless to turn a goal into a PRD + task DAG.
// Falls back to a stub in the caller if this throws.

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

function buildPrompt(goal: string, projectName: string): string {
  return `You are the planning agent for an autonomous multi-model coding team.
Plan the project "${projectName}" for this goal:

${goal}

Produce a short PRD and break the work into a dependency-ordered task DAG.
For each task choose:
- difficulty: "easy" | "medium" | "hard"
- role (optional): "frontend" | "docs" | "hard" | "medium" | "updates"
- acceptanceCriteria: concrete, checkable statements
- dependsOn: array of indices of earlier tasks that must finish first
- scopePaths: glob(s) the task is allowed to modify

Respond with ONLY a JSON object, no markdown fences, in this exact shape:
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
}`;
}

function runClaudeJson(prompt: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "claude",
      ["-p", prompt, "--output-format", "json"],
      { cwd, stdio: ["ignore", "pipe", "pipe"] },
    );
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
      // claude --output-format json wraps the answer: { ..., "result": "<text>" }
      try {
        const wrapper = JSON.parse(out);
        resolve(typeof wrapper.result === "string" ? wrapper.result : out);
      } catch {
        resolve(out);
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

export async function runPlanner(
  goal: string,
  projectName: string,
  cwd: string,
): Promise<PlanOutput> {
  const text = await runClaudeJson(buildPrompt(goal, projectName), cwd);
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

  return { prdMarkdown: String(parsed.prd ?? `# ${projectName}\n\n${goal}`), tasks };
}
