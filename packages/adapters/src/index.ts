// @orc/adapters — how the orchestrator actually runs a model on a task.
//
// Three runners:
//   - ClaudeAdapter   -> Claude Code headless (`claude -p`), uses the Pro sub
//   - OpenCodeAdapter -> the `opencode run` CLI (every other model)
//   - CodexAdapter    -> the native Codex CLI (`codex exec`), uses the
//                        ChatGPT subscription's flat rate
//
// All three stream output to onLog AND capture the model's final text into
// `summary` (the Validator parses summary for its JSON verdict).
//
// Depend ONLY on @orc/types.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelConfig, ModelId } from "@orc/types";
import { sanitizedEnv } from "./env.js";

export { sanitizedEnv } from "./env.js";

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
  exitReason: "completed" | "error" | "killed" | "stuck" | "rate_limited";
  costUsd: number;
  /** NON-cached input tokens. Each adapter normalizes to this convention
   *  (Codex reports input inclusive of cached; Claude/OpenCode report cache
   *  reads separately) so manual per-model pricing can bill fresh vs cached
   *  input at their different rates. */
  tokensIn: number;
  tokensOut: number;
  /** Cached (read-from-cache) input tokens; 0 when the CLI doesn't report them. */
  tokensCached?: number;
  /** The model's final text output (used by the Validator). */
  summary?: string;
}

// F6: a failure whose output looks like a rate limit gets its own exitReason
// instead of the generic "error" — EngineRunner watches for this on
// run.updated events and marks the model "cooling down" for a few minutes so
// the orchestrator's dispatch loop routes new work to a fallback instead of
// burning attempts against a model that's about to reject them anyway.
// "usage limit" covers Codex CLI's own phrasing ("You've hit your usage
// limit" — verified against the installed CLI's binary strings, 2026-07-08),
// which doesn't otherwise match "rate limit"/"429"/"quota".
const RATE_LIMIT_PATTERN = /rate.?limit|429|too many requests|quota|usage limit/i;

/** Exported for unit testing — see index.test.ts. */
export function classifyFailure(summary: string): "error" | "rate_limited" {
  return RATE_LIMIT_PATTERN.test(summary) ? "rate_limited" : "error";
}

export interface AgentAdapter {
  readonly runner: "claude-code" | "opencode" | "codex";
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
      // Prompt goes on stdin, not argv: a task's full instructions (description
      // + acceptance criteria + fix instructions from a prior failed attempt)
      // can be large enough to hit macOS's ~1MB total argv cap. `claude -p`
      // with no positional prompt reads from stdin (verified against the real
      // CLI, both --output-format json and stream-json).
      const args = [
        "-p",
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
          env: sanitizedEnv({ PWD: opts.cwd }),
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      proc.stdin?.end(opts.prompt);

      let costUsd = 0;
      let tokensIn = 0;
      let tokensOut = 0;
      let tokensCached = 0;
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
            | {
                input_tokens?: number;
                output_tokens?: number;
                cache_read_input_tokens?: number;
                cache_creation_input_tokens?: number;
              }
            | undefined;
          if (usage) {
            // claude's input_tokens already EXCLUDES cache reads (they're
            // reported separately). Cache-creation tokens are billed as
            // (pricier) input, so fold them into tokensIn rather than
            // dropping them.
            tokensIn =
              (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) || tokensIn;
            tokensOut = usage.output_tokens ?? tokensOut;
            tokensCached = usage.cache_read_input_tokens ?? tokensCached;
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
            tokensCached,
            summary: resultText || assistantText,
          });
          return;
        }
        const ok = code === 0;
        const finalSummary = resultText || assistantText;
        resolve({
          ok,
          exitReason: ok ? "completed" : classifyFailure(finalSummary),
          costUsd,
          tokensIn,
          tokensOut,
          tokensCached,
          summary: finalSummary,
        });
      });
    });
  }
}

/**
 * Startup races, not model failures — safe to retry the same model. The big
 * one: `opencode` keeps a shared SQLite session store, so two opencode runs
 * starting at the same instant (different models dispatched concurrently)
 * collide with "database is locked" and one dies in <1s. Retrying after a
 * short stagger clears it, instead of needlessly burning a fallback model.
 */
const OPENCODE_TRANSIENT =
  /database is locked|SQLITE_BUSY|EADDRINUSE|ECONNREFUSED|connection refused/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class OpenCodeAdapter implements AgentAdapter {
  readonly runner = "opencode" as const;

  constructor(
    private readonly baseUrl: string,
    private readonly opencodeModel: string,
  ) {}

  async run(opts: AgentRunOptions): Promise<AgentRunResult> {
    // Retry transient STARTUP races (cost===0 means it died before doing any
    // billable work, so a retry can't double-charge). Anything that already
    // incurred cost, or doesn't match a known-transient signature, is returned
    // as-is for the orchestrator's normal fallback handling.
    let result: AgentRunResult = { ok: false, exitReason: "error", costUsd: 0, tokensIn: 0, tokensOut: 0 };
    for (let attempt = 0; attempt < 3; attempt++) {
      result = await this.runOnce(opts);
      if (result.ok || opts.signal?.aborted) return result;
      const transient =
        result.costUsd === 0 && OPENCODE_TRANSIENT.test(result.summary ?? "");
      if (!transient) return result;
      opts.onLog(
        `[opencode] transient startup error (attempt ${attempt + 1}), retrying…\n`,
      );
      await sleep(1500 * (attempt + 1));
    }
    return result;
  }

  private async runOnce(opts: AgentRunOptions): Promise<AgentRunResult> {
    // `opencode run -m provider/model --format json` runs the agent to
    // completion and emits JSON events on stdout. We attach to a shared server
    // when one is configured so sessions + cost are centralized. The message
    // goes on stdin rather than as a trailing positional arg — `opencode run`
    // with no positional message reads it from stdin (verified against the
    // real CLI) — so a large task prompt can't hit macOS's ~1MB argv cap.
    const args = ["run", "-m", this.opencodeModel, "--format", "json"];
    if (this.baseUrl) args.push("--attach", this.baseUrl);

    return new Promise((resolve) => {
      const proc = spawn("opencode", args, {
        cwd: opts.cwd,
        // PWD must be set explicitly: spawn's `cwd` does NOT update the inherited
        // $PWD env var, and `opencode run` resolves its working directory from
        // $PWD (verified). Without this it runs in the server's launch directory
        // and writes files there instead of the task worktree.
        env: sanitizedEnv({ PWD: opts.cwd }),
        stdio: ["pipe", "pipe", "pipe"],
      });
      proc.stdin?.end(opts.prompt);

      let costUsd = 0;
      let tokensIn = 0;
      let tokensOut = 0;
      let tokensCached = 0;
      let text = "";
      let lineBuf = "";
      let stderrTail = ""; // kept so run() can detect transient startup races
      let killed = false;

      const handleEvent = (obj: Record<string, unknown>) => {
        // `opencode run --format json` nests everything under `part`. Text
        // arrives on "text" parts; cost/tokens arrive per-step on "step-finish"
        // parts and are incremental (per step), so accumulate across the run.
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
          // tokens.input excludes cache activity (reported under cache.read/
          // write). Cache writes are billed as input; reads go to tokensCached.
          tokensIn += (part.tokens.input ?? 0) + (part.tokens.cache?.write ?? 0);
          tokensOut += part.tokens.output ?? 0;
          tokensCached += part.tokens.cache?.read ?? 0;
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
      proc.stderr?.on("data", (c: Buffer) => {
        const s = c.toString("utf8");
        // Keep a bounded tail of stderr so the retry layer can recognize
        // transient startup errors (e.g. "database is locked").
        stderrTail = (stderrTail + s).slice(-2000);
        opts.onLog(s);
      });

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
            tokensCached,
            summary: text,
          });
          return;
        }
        const ok = code === 0;
        // On failure include stderr so the retry layer can spot transient
        // startup races; on success the model's text is the summary.
        const finalSummary = ok ? text : `${text}\n${stderrTail}`.trim();
        resolve({
          ok,
          exitReason: ok ? "completed" : classifyFailure(finalSummary),
          costUsd,
          tokensIn,
          tokensOut,
          tokensCached,
          summary: finalSummary,
        });
      });
    });
  }
}

/**
 * Native Codex CLI (`codex exec`) — the ChatGPT-subscription-billed path for
 * OpenAI's Codex models, parallel to how ClaudeAdapter is the Claude-
 * subscription-billed path (Codex models are also reachable via
 * OpenCodeAdapter, but that's API-billed).
 *
 * Verified against the real CLI (`codex-cli 0.143.0`, 2026-07-08):
 *  - `codex exec -` reads the prompt from stdin (same stdin-not-argv
 *    reasoning as ClaudeAdapter/OpenCodeAdapter).
 *  - `--json` emits JSONL on stdout: `thread.started`, `turn.started`,
 *    `item.started`/`item.updated`/`item.completed` (item types include
 *    `agent_message`, `reasoning`, `command_execution`, `file_change`,
 *    `error`, …), `turn.completed` (carries `usage` with `input_tokens`/
 *    `cached_input_tokens`/`output_tokens`), `turn.failed` (carries
 *    `error.message`). Rust-side log lines land on stderr, not stdout.
 *  - `--output-last-message <file>` is the most robust way to capture the
 *    final message, but the file is only written on a *successful* turn —
 *    confirmed empty/absent after a failed one, so the JSONL-derived text
 *    is still needed as a fallback.
 *  - No cost-USD anywhere in the output — it's subscription-billed, so
 *    `costUsd` is always 0 here (same honesty as any other subscription
 *    spend the app can't see into).
 *  - Non-interactive `exec` mode has no separate approval flag (only
 *    `--dangerously-bypass-approvals-and-sandbox`, which also drops
 *    sandboxing entirely) — confirmed live that an unattended run neither
 *    hangs nor prompts; `--sandbox` alone is the full gate.
 */
const CODEX_SANDBOX = "danger-full-access";

export class CodexAdapter implements AgentAdapter {
  readonly runner = "codex" as const;

  /** Optional `codex exec -m` id (e.g. "gpt-5.2-codex"). */
  constructor(private readonly codexModel?: string) {}

  async run(opts: AgentRunOptions): Promise<AgentRunResult> {
    const outputFile = join(tmpdir(), `codex-summary-${randomUUID()}.txt`);
    try {
      return await this.runOnce(opts, outputFile);
    } finally {
      await unlink(outputFile).catch(() => {});
    }
  }

  private async runOnce(
    opts: AgentRunOptions,
    outputFile: string,
  ): Promise<AgentRunResult> {
    const args = [
      "exec",
      "-",
      "--json",
      "--output-last-message",
      outputFile,
      "-C",
      opts.cwd,
      // Runner parity with Claude/OpenCode, which run unsandboxed on the
      // host: gates/deps/network need to behave identically across
      // runners. `workspace-write`'s default network block would break
      // `npm install` mid-task — this is the right default until F13's
      // sandbox story covers agents generally, not just gates.
      "--sandbox",
      CODEX_SANDBOX,
    ];
    if (this.codexModel) args.push("-m", this.codexModel);

    return new Promise((resolve) => {
      const proc = spawn("codex", args, {
        cwd: opts.cwd,
        // Same $PWD lesson as the other two adapters — belt and suspenders
        // alongside the explicit -C flag above.
        env: sanitizedEnv({ PWD: opts.cwd }),
        stdio: ["pipe", "pipe", "pipe"],
      });
      proc.stdin?.end(opts.prompt);

      let tokensIn = 0;
      let tokensOut = 0;
      let tokensCached = 0;
      let assistantText = "";
      let lastError = "";
      let lineBuf = "";
      let killed = false;

      const handleEvent = (obj: Record<string, unknown>) => {
        const type = obj.type;
        if (type === "item.completed") {
          const item = obj.item as
            | { type?: string; text?: string; message?: string }
            | undefined;
          if (item?.type === "agent_message" && typeof item.text === "string") {
            assistantText += item.text;
          } else if (item?.type === "error" && typeof item.message === "string") {
            lastError = item.message;
          }
        } else if (type === "turn.completed") {
          const usage = obj.usage as
            | {
                input_tokens?: number;
                output_tokens?: number;
                cached_input_tokens?: number;
              }
            | undefined;
          if (usage) {
            // Codex's input_tokens INCLUDES cached_input_tokens (OpenAI
            // convention) — subtract so tokensIn is fresh input only,
            // matching the other adapters' normalization.
            const cached = usage.cached_input_tokens ?? 0;
            tokensIn = Math.max(0, (usage.input_tokens ?? 0) - cached) || tokensIn;
            tokensOut = usage.output_tokens ?? tokensOut;
            tokensCached = cached || tokensCached;
          }
        } else if (type === "turn.failed") {
          const err = obj.error as { message?: string } | undefined;
          if (err?.message) lastError = err.message;
        } else if (type === "error" && typeof obj.message === "string") {
          lastError = obj.message;
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

      const finish = async (code: number | null) => {
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
            costUsd: 0,
            tokensIn,
            tokensOut,
            tokensCached,
            summary: assistantText || lastError,
          });
          return;
        }
        // --output-last-message is the most robust summary source (it's the
        // model's actual final message, not a text fragment reassembled
        // from JSONL) but is only written on a successful turn.
        const fileSummary = await readFile(outputFile, "utf8").catch(() => "");
        const ok = code === 0;
        const finalSummary = fileSummary.trim() || assistantText || lastError;
        resolve({
          ok,
          exitReason: ok ? "completed" : classifyFailure(finalSummary),
          costUsd: 0,
          tokensIn,
          tokensOut,
          tokensCached,
          summary: finalSummary,
        });
      };

      proc.on("error", (err) => {
        opts.onLog(`[codex] spawn error: ${err.message}\n`);
        resolve({
          ok: false,
          exitReason: "error",
          costUsd: 0,
          tokensIn,
          tokensOut,
          summary: err.message,
        });
      });

      proc.on("close", (code) => {
        void finish(code);
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
  if (cfg.runner === "codex") return new CodexAdapter(cfg.codexModel);
  if (!cfg.opencodeModel) {
    throw new Error(`model ${cfg.id} is runner=opencode but has no opencodeModel`);
  }
  return new OpenCodeAdapter(opencodeBaseUrl, cfg.opencodeModel);
}
