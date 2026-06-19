// @orc/adapters — how the orchestrator actually runs a model on a task.
//
// OWNER: deepseek-flash  (see docs/specs/deepseek-flash-server-adapters.md)
//
// Two runners:
//   - ClaudeAdapter   -> Claude Code headless (uses the logged-in Pro sub)
//   - OpenCodeAdapter -> a running `opencode serve` HTTP API (every other model)
//
// Depend ONLY on @orc/types.

import type { ModelConfig, ModelId } from "@orc/types";

export interface AgentRunOptions {
  model: ModelId;
  /** The full task instructions: description + acceptance criteria + scope. */
  prompt: string;
  /** The task's worktree path — the agent's working directory. */
  cwd: string;
  /** Stream every line of agent output here (drives live logs). */
  onLog: (line: string) => void;
  /** Abort to stop/kill the run (used by stuck detection + manual stop). */
  signal?: AbortSignal;
}

export interface AgentRunResult {
  ok: boolean;
  exitReason: "completed" | "error" | "killed" | "stuck";
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  summary?: string;
}

export interface AgentAdapter {
  readonly runner: "claude-code" | "opencode";
  run(opts: AgentRunOptions): Promise<AgentRunResult>;
}

/**
 * Drives Claude Code in headless mode. Implement with either:
 *   - the Claude Agent SDK (@anthropic-ai/claude-agent-sdk), or
 *   - spawning `claude -p <prompt> --output-format stream-json` and parsing it.
 * Uses the existing Claude Code login (Pro subscription) — no API key here.
 */
export class ClaudeAdapter implements AgentAdapter {
  readonly runner = "claude-code" as const;
  async run(_opts: AgentRunOptions): Promise<AgentRunResult> {
    throw new Error(
      "not implemented — see docs/specs/deepseek-flash-server-adapters.md",
    );
  }
}

/**
 * Talks to a running `opencode serve` HTTP API and selects the provider/model
 * per call (opencodeModel, e.g. "deepseek/deepseek-pro"). Handles every
 * non-Claude model, including Grok (OAuth is configured inside OpenCode).
 */
export class OpenCodeAdapter implements AgentAdapter {
  readonly runner = "opencode" as const;
  constructor(
    private readonly baseUrl: string,
    private readonly opencodeModel: string,
  ) {}
  async run(_opts: AgentRunOptions): Promise<AgentRunResult> {
    throw new Error(
      "not implemented — see docs/specs/deepseek-flash-server-adapters.md",
    );
  }
}

/** Resolve a ModelConfig to a ready-to-use adapter. */
export function makeAdapter(
  cfg: ModelConfig,
  opencodeBaseUrl: string,
): AgentAdapter {
  if (cfg.runner === "claude-code") return new ClaudeAdapter();
  if (!cfg.opencodeModel) {
    throw new Error(`model ${cfg.id} is runner=opencode but has no opencodeModel`);
  }
  return new OpenCodeAdapter(opencodeBaseUrl, cfg.opencodeModel);
}
