import type { AgentAdapter, AgentRunOptions, AgentRunResult } from "./index.js";
import { sanitizedEnv } from "./env.js";
import { execManagedProcess, spawnManagedProcess } from "./managed-process.js";

export const GEMINI_VERSION = "0.60.0";
export async function checkGeminiVersion(signal?: AbortSignal): Promise<string> {
  const result = await execManagedProcess("gemini", ["--version"], { env: sanitizedEnv(), signal, timeoutMs: 15_000, maxOutputBytes: 32_768 });
  const version = result.stdout.trim();
  if (version !== GEMINI_VERSION) throw new Error(`Gemini CLI ${GEMINI_VERSION} is required; installed version is ${version.slice(0, 80) || "unknown"}. Verify compatibility before upgrading.`);
  return version;
}

/** Final stats are cumulative, never summed with model sub-totals or repeats. */
export class GeminiStream {
  text = "";
  failure = "";
  final = false;
  succeeded = false;
  malformed = false;
  tokensIn = 0;
  tokensOut = 0;
  tokensCached = 0;
  line(value: string): void {
    if (!value.trim()) return;
    let event: Record<string, unknown>;
    try { event = JSON.parse(value) as Record<string, unknown>; }
    catch { this.malformed = true; return; }
    if (!event || typeof event !== "object" || Array.isArray(event)) { this.malformed = true; return; }
    if (this.final) { this.malformed = true; return; }
    if (event.type === "message" && event.role === "assistant" && typeof event.content === "string") this.text += event.content;
    if (event.type === "error") this.failure = JSON.stringify(event.error ?? event.message ?? event).slice(0, 2000);
    if (event.type !== "result") return;
    this.final = true;
    this.succeeded = event.status === "success";
    const stats = event.stats as Record<string, unknown> | undefined;
    const valid = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
    if (!stats || !valid(stats.input_tokens) || !valid(stats.output_tokens) || !valid(stats.cached) || stats.cached > stats.input_tokens || (stats.input !== undefined && (!valid(stats.input) || stats.input !== stats.input_tokens - stats.cached))) {
      this.malformed = true;
      return;
    }
    this.tokensIn = stats.input_tokens - stats.cached;
    this.tokensOut = stats.output_tokens;
    this.tokensCached = stats.cached;
    if (event.error) this.failure = JSON.stringify(event.error).slice(0, 2000);
  }
}

export class GeminiAdapter implements AgentAdapter {
  readonly runner = "gemini" as const;
  constructor(private readonly model: string, private readonly effort?: string) {}
  async run(opts: AgentRunOptions & { timeoutMs?: number; maxOutputBytes?: number }): Promise<AgentRunResult> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(this.model)) throw new Error("Gemini requires an explicit safe model ID from your CLI account.");
    if (this.effort) throw new Error("Reasoning effort is not verified for Gemini CLI.");
    if (opts.activation) throw new Error("Selective activation is not verified for Gemini CLI. Explicitly choose inherited configuration.");
    if (opts.execution) throw new Error("Isolated execution is not verified for Gemini CLI.");
    await checkGeminiVersion(opts.signal);
    const stream = new GeminiStream();
    const managed = spawnManagedProcess("gemini", ["--model", this.model, "--prompt", "Follow the task instructions provided on stdin.", "--output-format", "stream-json", "--approval-mode", "yolo", "--skip-trust"], {
      cwd: opts.cwd, env: sanitizedEnv({ PWD: opts.cwd }), input: opts.prompt, signal: opts.signal,
      timeoutMs: opts.timeoutMs, maxOutputBytes: opts.maxOutputBytes ?? 16 * 1024 * 1024, captureOutput: false,
    });
    let buffer = ""; let stderr = "";
    managed.child.stdout.setEncoding("utf8");
    managed.child.stdout.on("data", (chunk: string) => {
      opts.onLog(chunk); buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf("\n")) !== -1) { stream.line(buffer.slice(0, index)); buffer = buffer.slice(index + 1); }
    });
    managed.child.stderr.setEncoding("utf8");
    managed.child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4000); opts.onLog(chunk); });
    const result = await managed.settled;
    stream.line(buffer);
    const ok = result.code === 0 && !result.aborted && !result.timedOut && !result.outputLimitExceeded && stream.final && stream.succeeded && !stream.malformed;
    const failure = result.outputLimitExceeded ? "Gemini output limit exceeded." : result.timedOut ? "Gemini timed out." : stream.malformed || !stream.final ? "Gemini returned a malformed or missing final result." : stream.failure || "Gemini failed.";
    const diagnostic = `${failure} ${stderr}`.trim();
    return { ok, exitReason: ok ? "completed" : result.aborted ? "killed" : result.timedOut ? "stuck" : /rate.?limit|429|too many requests|quota|usage limit/i.test(diagnostic) ? "rate_limited" : "error",
      costUsd: 0, tokensIn: stream.tokensIn, tokensOut: stream.tokensOut, tokensCached: stream.tokensCached,
      summary: ok ? stream.text : `${stream.text}\n${diagnostic}`.trim() };
  }
}
