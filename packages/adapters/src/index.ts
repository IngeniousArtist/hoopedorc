// @orc/adapters — how the orchestrator actually runs a model on a task.
//
// Two runners:
//   - ClaudeAdapter   -> Claude Code headless (`claude -p`), uses the Pro sub
//   - OpenCodeAdapter -> the `opencode run` CLI (every other model)
//
// Both stream output to onLog AND capture the model's final text into
// `summary` (the Validator parses summary for its JSON verdict).
//
// Depend ONLY on @orc/types.

import { spawn } from "node:child_process";
import type { ModelConfig, ModelId } from "@orc/types";

export interface AgentRunOptions {
  model: ModelId;
  /** The full task instructions: description + acceptance criteria + scope. */
  prompt: string;
  /** The task's worktree path — the agent's working directory. */
  cwd: string;
  /** Stream every line of agent output here (drives live logs). */
  onLog: (line: string) => void;
  /** Abort to stop/kill the run (stuck detection + manual stop). */
  signal?: AbortSignal;
}

export interface AgentRunResult {
  ok: boolean;
  exitReason: "completed" | "error" | "killed" | "stuck";
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  /** The model's final text output (used by the Validator). */
  summary?: string;
}

export interface AgentAdapter {
  readonly runner: "claude-code" | "opencode";
  run(opts: AgentRunOptions): Promise<AgentRunResult>;
}

/**
 * Coding agents run unattended inside a throwaway, branch-isolated git worktree,
 * so we let them act without interactive permission prompts. `main` is still
 * protected by branch + PR + the pre-merge gates.
 */
const CLAUDE_PERMISSION_MODE = "bypassPermissions";

function wireAbort(
  proc: ReturnType<typeof spawn>,
  signal: AbortSignal | undefined,
  onKilled: () => void,
): boolean {
  if (!signal) return false;
  const kill = () => {
    proc.kill("SIGTERM");
    setTimeout(() => {
      if (!proc.killed) proc.kill("SIGKILL");
    }, 2000);
    onKilled();
  };
  if (signal.aborted) {
    kill();
    return true;
  }
  signal.addEventListener("abort", kill, { once: true });
  return false;
}

export class ClaudeAdapter implements AgentAdapter {
  readonly runner = "claude-code" as const;

  /** Optional `claude --model` alias/id (e.g. "sonnet" / "opus"). */
  constructor(private readonly claudeModel?: string) {}

  async run(opts: AgentRunOptions): Promise<AgentRunResult> {
    return new Promise((resolve) => {
      const args = [
        "-p",
        opts.prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        CLAUDE_PERMISSION_MODE,
      ];
      if (this.claudeModel) args.push("--model", this.claudeModel);
      const proc = spawn(
        "claude",
        args,
        // PWD must be set explicitly: spawn's `cwd` changes the child's actual
        // working directory but does NOT update the inherited $PWD env var, and
        // CLI agents resolve their project root from $PWD. Without this, the
        // agent runs in the server's launch directory instead of the worktree.
        {
          cwd: opts.cwd,
          env: { ...process.env, PWD: opts.cwd },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      let costUsd = 0;
      let tokensIn = 0;
      let tokensOut = 0;
      let assistantText = "";
      let resultText = "";
      let lineBuf = "";
      let killed = false;

      const handleEvent = (obj: Record<string, unknown>) => {
        const type = obj.type;
        if (type === "assistant") {
          const msg = obj.message as
            | { content?: Array<{ type?: string; text?: string }> }
            | undefined;
          for (const part of msg?.content ?? []) {
            if (part.type === "text" && part.text) assistantText += part.text;
          }
        } else if (type === "result") {
          if (typeof obj.result === "string") resultText = obj.result;
          costUsd =
            (obj.total_cost_usd as number) ?? (obj.cost_usd as number) ?? costUsd;
          const usage = obj.usage as
            | { input_tokens?: number; output_tokens?: number }
            | undefined;
          if (usage) {
            tokensIn = usage.input_tokens ?? tokensIn;
            tokensOut = usage.output_tokens ?? tokensOut;
          }
        }
      };

      const onData = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        opts.onLog(text);
        lineBuf += text;
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop() ?? "";
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          try {
            handleEvent(JSON.parse(t));
          } catch {
            /* non-JSON log line, already streamed */
          }
        }
      };

      proc.stdout?.on("data", onData);
      proc.stderr?.on("data", (c: Buffer) => opts.onLog(c.toString("utf8")));

      wireAbort(proc, opts.signal, () => {
        killed = true;
      });

      proc.on("error", (err) => {
        opts.onLog(`[claude] spawn error: ${err.message}\n`);
        resolve({
          ok: false,
          exitReason: "error",
          costUsd,
          tokensIn,
          tokensOut,
          summary: err.message,
        });
      });

      proc.on("close", (code) => {
        // Flush a final line with no trailing newline. The `result` event
        // (carrying total_cost_usd + usage) is the LAST line claude emits; if
        // it isn't newline-terminated it sits unparsed in lineBuf and the run
        // would otherwise report $0 / 0 tokens.
        const tail = lineBuf.trim();
        if (tail) {
          try {
            handleEvent(JSON.parse(tail));
          } catch {
            /* not JSON */
          }
        }
        if (killed || opts.signal?.aborted) {
          resolve({
            ok: false,
            exitReason: "killed",
            costUsd,
            tokensIn,
            tokensOut,
            summary: resultText || assistantText,
          });
          return;
        }
        const ok = code === 0;
        resolve({
          ok,
          exitReason: ok ? "completed" : "error",
          costUsd,
          tokensIn,
          tokensOut,
          summary: resultText || assistantText,
        });
      });
    });
  }
}

export class OpenCodeAdapter implements AgentAdapter {
  readonly runner = "opencode" as const;

  constructor(
    private readonly baseUrl: string,
    private readonly opencodeModel: string,
  ) {}

  async run(opts: AgentRunOptions): Promise<AgentRunResult> {
    // `opencode run -m provider/model --format json <prompt>` runs the agent to
    // completion and emits JSON events on stdout. We attach to a shared server
    // when one is configured so sessions + cost are centralized.
    const args = ["run", "-m", this.opencodeModel, "--format", "json"];
    if (this.baseUrl) args.push("--attach", this.baseUrl);
    args.push(opts.prompt);

    return new Promise((resolve) => {
      const proc = spawn("opencode", args, {
        cwd: opts.cwd,
        // PWD must be set explicitly: spawn's `cwd` does NOT update the inherited
        // $PWD env var, and `opencode run` resolves its working directory from
        // $PWD (verified). Without this it runs in the server's launch directory
        // and writes files there instead of the task worktree.
        env: { ...process.env, PWD: opts.cwd },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let costUsd = 0;
      let tokensIn = 0;
      let tokensOut = 0;
      let text = "";
      let lineBuf = "";
      let killed = false;

      const handleEvent = (obj: Record<string, unknown>) => {
        // `opencode run --format json` nests everything under `part`. Text
        // arrives on "text" parts; cost/tokens arrive per-step on "step-finish"
        // parts and are incremental (per step), so accumulate across the run.
        const part = obj.part as
          | {
              text?: string;
              cost?: number;
              tokens?: { input?: number; output?: number };
            }
          | undefined;
        if (typeof part?.text === "string") text += part.text;
        if (typeof part?.cost === "number") costUsd += part.cost;
        if (part?.tokens) {
          tokensIn += part.tokens.input ?? 0;
          tokensOut += part.tokens.output ?? 0;
        }
      };

      const onData = (chunk: Buffer) => {
        const s = chunk.toString("utf8");
        opts.onLog(s);
        lineBuf += s;
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop() ?? "";
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          try {
            handleEvent(JSON.parse(t));
          } catch {
            /* non-JSON line, already streamed */
          }
        }
      };

      proc.stdout?.on("data", onData);
      proc.stderr?.on("data", (c: Buffer) => opts.onLog(c.toString("utf8")));

      wireAbort(proc, opts.signal, () => {
        killed = true;
      });

      proc.on("error", (err) => {
        opts.onLog(`[opencode] spawn error: ${err.message}\n`);
        resolve({
          ok: false,
          exitReason: "error",
          costUsd,
          tokensIn,
          tokensOut,
          summary: err.message,
        });
      });

      proc.on("close", (code) => {
        // Flush a final line with no trailing newline so a last step-finish
        // event's cost/tokens aren't dropped (see ClaudeAdapter for detail).
        const tail = lineBuf.trim();
        if (tail) {
          try {
            handleEvent(JSON.parse(tail));
          } catch {
            /* not JSON */
          }
        }
        if (killed || opts.signal?.aborted) {
          resolve({
            ok: false,
            exitReason: "killed",
            costUsd,
            tokensIn,
            tokensOut,
            summary: text,
          });
          return;
        }
        const ok = code === 0;
        resolve({
          ok,
          exitReason: ok ? "completed" : "error",
          costUsd,
          tokensIn,
          tokensOut,
          summary: text,
        });
      });
    });
  }
}

/** Resolve a ModelConfig to a ready-to-use adapter. */
export function makeAdapter(
  cfg: ModelConfig,
  opencodeBaseUrl: string,
): AgentAdapter {
  if (cfg.runner === "claude-code") return new ClaudeAdapter(cfg.claudeModel);
  if (!cfg.opencodeModel) {
    throw new Error(`model ${cfg.id} is runner=opencode but has no opencodeModel`);
  }
  return new OpenCodeAdapter(opencodeBaseUrl, cfg.opencodeModel);
}
