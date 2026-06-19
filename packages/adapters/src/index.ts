import { spawn } from "node:child_process";
import type { ModelConfig, ModelId } from "@orc/types";

export interface AgentRunOptions {
  model: ModelId;
  prompt: string;
  cwd: string;
  onLog: (line: string) => void;
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

export class ClaudeAdapter implements AgentAdapter {
  readonly runner = "claude-code" as const;

  async run(opts: AgentRunOptions): Promise<AgentRunResult> {
    return new Promise((resolve) => {
      const proc = spawn("claude", [
        "-p", opts.prompt,
        "--output-format", "stream-json",
      ], {
        cwd: opts.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const buffers: string[] = [];

      const onData = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        buffers.push(text);
        opts.onLog(text);
      };

      proc.stdout?.on("data", onData);
      proc.stderr?.on("data", onData);

      const kill = () => {
        proc.kill("SIGTERM");
        setTimeout(() => proc.killed || proc.kill("SIGKILL"), 2000);
      };

      if (opts.signal) {
        if (opts.signal.aborted) {
          kill();
          resolve({
            ok: false,
            exitReason: "killed",
            costUsd: 0,
            tokensIn: 0,
            tokensOut: 0,
          });
          return;
        }
        opts.signal.addEventListener("abort", kill, { once: true });
      }

      proc.on("error", (err) => {
        opts.onLog(`[claude] spawn error: ${err.message}\n`);
        resolve({
          ok: false,
          exitReason: "error",
          costUsd: 0,
          tokensIn: 0,
          tokensOut: 0,
        });
      });

      proc.on("close", (code, _signal) => {
        if (opts.signal?.aborted) {
          resolve({
            ok: false,
            exitReason: "killed",
            costUsd: 0,
            tokensIn: 0,
            tokensOut: 0,
          });
          return;
        }

        const full = buffers.join("");
        let costUsd = 0;
        let tokensIn = 0;
        let tokensOut = 0;

        for (const line of full.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed.type === "result" && parsed.result) {
              const r = parsed.result;
              costUsd = r.costUsd ?? r.cost_usd ?? 0;
              tokensIn = r.tokensIn ?? r.tokens_in ?? 0;
              tokensOut = r.tokensOut ?? r.tokens_out ?? 0;
            } else if (parsed.type === "error") {
              resolve({
                ok: false,
                exitReason: "error",
                costUsd,
                tokensIn,
                tokensOut,
                summary: parsed.error?.message ?? parsed.error,
              });
              return;
            }
          } catch {
            // not JSON — log line from claude, already streamed via onLog
          }
        }

        const ok = code === 0;
        resolve({
          ok,
          exitReason: ok ? "completed" : "error",
          costUsd,
          tokensIn,
          tokensOut,
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
    const url = `${this.baseUrl.replace(/\/$/, "")}/chat`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.opencodeModel,
        prompt: opts.prompt,
        stream: true,
      }),
      signal: opts.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "unknown error");
      opts.onLog(`[opencode] HTTP ${response.status}: ${text}\n`);
      return { ok: false, exitReason: "error", costUsd: 0, tokensIn: 0, tokensOut: 0 };
    }

    if (!response.body) {
      return { ok: false, exitReason: "error", costUsd: 0, tokensIn: 0, tokensOut: 0 };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let costUsd = 0;
    let tokensIn = 0;
    let tokensOut = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");

        for (const raw of lines) {
          const line = raw.trim();
          if (!line) continue;

          // SSE format: "data: {...}"
          let jsonStr = line;
          if (line.startsWith("data: ")) {
            jsonStr = line.slice(6);
          }

          if (jsonStr === "[DONE]") continue;

          try {
            const parsed = JSON.parse(jsonStr);
            const text =
              parsed.choices?.[0]?.delta?.content ??
              parsed.choices?.[0]?.text ??
              parsed.message?.content ??
              parsed.text ??
              "";
            if (text) {
              opts.onLog(text);
            }
            if (parsed.usage) {
              tokensIn = parsed.usage.prompt_tokens ?? parsed.usage.input_tokens ?? tokensIn;
              tokensOut = parsed.usage.completion_tokens ?? parsed.usage.output_tokens ?? tokensOut;
            }
            if (parsed.costUsd != null) {
              costUsd = parsed.costUsd;
            }
          } catch {
            // not JSON — stream it raw
            if (line) opts.onLog(line + "\n");
          }
        }
      }
    } catch (err) {
      if (opts.signal?.aborted) {
        return { ok: false, exitReason: "killed", costUsd, tokensIn, tokensOut };
      }
      opts.onLog(`[opencode] stream error: ${err}\n`);
      return { ok: false, exitReason: "error", costUsd, tokensIn, tokensOut };
    }

    return { ok: true, exitReason: "completed", costUsd, tokensIn, tokensOut };
  }
}

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
