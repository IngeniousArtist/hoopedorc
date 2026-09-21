import { createHash } from "node:crypto";
import { sanitizedEnv } from "./env.js";
import { execManagedProcess, spawnManagedProcess } from "./managed-process.js";

export const SELECTIVE_CLAUDE_VERSION = "2.1.278";
export interface SelectiveLaunch { mcpConfigPath: string }
export function selectiveClaudeArgs(launch?: SelectiveLaunch): string[] {
  return launch ? ["--setting-sources", "", "--disable-slash-commands", "--strict-mcp-config", "--mcp-config", launch.mcpConfigPath, "--settings", '{"disableAllHooks":true}'] : [];
}
export async function selectiveClaudeVersion(signal?: AbortSignal): Promise<string> {
  const result = await execManagedProcess("claude", ["--version"], { env: sanitizedEnv(), signal, timeoutMs: 5000, maxOutputBytes: 4096 });
  const version = result.stdout.trim().split(/\s/)[0];
  if (version !== SELECTIVE_CLAUDE_VERSION) throw new Error(`Selective activation requires the verified Claude Code ${SELECTIVE_CLAUDE_VERSION}; installed version is ${version || "unknown"}. Choose inherited mode or verify this version before enabling it.`);
  return version;
}

/** Compare only non-secret auth identity. Raw status output never reaches logs
 * or manifests; an API helper excluded by setting-sources must not become an
 * implicit switch to another billing method. */
export async function verifySelectiveClaudeAuth(launch: SelectiveLaunch, signal?: AbortSignal): Promise<void> {
  const identities: string[] = [];
  for (const args of [[], selectiveClaudeArgs(launch)]) {
    try {
      const result = await execManagedProcess("claude", [...args, "auth", "status"], { env: sanitizedEnv(), signal, timeoutMs: 5000, maxOutputBytes: 64 * 1024 });
      const status = JSON.parse(result.stdout) as { loggedIn?: boolean; authMethod?: string; apiProvider?: string };
      if (!status.loggedIn || typeof status.authMethod !== "string" || typeof status.apiProvider !== "string") throw new Error("unavailable");
      identities.push(JSON.stringify([status.authMethod, status.apiProvider]));
    } catch { throw new Error("CLI-owned authentication could not be verified for selective mode. Authenticate Claude through its CLI or use inherited mode; no API-key fallback was attempted."); }
  }
  if (identities[0] !== identities[1]) throw new Error("Selective mode would change the CLI authentication or billing method. Use inherited mode until this authentication configuration is supported.");
}

/** Control initialization only: no user message and no model request. Never
 * return raw CLI output (which may contain MCP authentication diagnostics). */
export async function probeSelectiveClaude(cwd: string, launch: SelectiveLaunch, selected: string[], signal?: AbortSignal): Promise<{ id: string; tools: { name: string; schemaSha?: string }[] }[]> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  const managed = spawnManagedProcess("claude", ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", ...selectiveClaudeArgs(launch)], {
    cwd, env: sanitizedEnv({ PWD: cwd }), signal: controller.signal, timeoutMs: 20_000, maxOutputBytes: 1024 * 1024, captureOutput: false, keepStdinOpen: true,
  });
  let poll: ReturnType<typeof setTimeout> | undefined;
  let failure = "Capability initialization did not complete. Check the selected MCP installation and its CLI-owned authentication.";
  let found: Awaited<ReturnType<typeof probeSelectiveClaude>> | undefined;
  let buffer = ""; let initialized = false;
  const request = (subtype: string) => { if (!managed.child.stdin.destroyed) managed.child.stdin.write(JSON.stringify({ type: "control_request", request_id: subtype, request: { subtype } }) + "\n"); };
  managed.child.stdout.on("data", (bytes: Buffer) => {
    buffer += bytes.toString("utf8"); const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
    for (const line of lines) {
      let message: Record<string, unknown>; try { message = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (message.type !== "control_response") continue;
      const envelope = message.response as { subtype?: string; response?: { commands?: { name: string }[]; agents?: { name: string }[]; mcpServers?: { name: string; status: string; tools?: { name: string; inputSchema?: unknown }[] }[] } } | undefined;
      if (envelope?.subtype !== "success" || !envelope.response) { controller.abort(); continue; }
      const response = envelope.response;
      if (!initialized) {
        if (!Array.isArray(response.commands) || response.commands.length || !Array.isArray(response.agents) || response.agents.some((agent) => !["claude", "Explore", "general-purpose", "Plan", "statusline-setup"].includes(agent.name))) {
          failure = "The harness loaded an unselected command or plugin. Selective activation was refused."; controller.abort(); continue;
        }
        initialized = true; request("mcp_status"); continue;
      }
      const servers = response.mcpServers;
      if (!Array.isArray(servers)) { controller.abort(); continue; }
      if (servers.some((server) => !selected.includes(server.name)) || new Set(servers.map((s) => s.name)).size !== servers.length) {
        failure = "The harness exposed an unselected MCP server. Selective activation was refused."; controller.abort(); continue;
      }
      if (servers.some((server) => server.status === "pending")) { poll = setTimeout(() => request("mcp_status"), 200); continue; }
      if (servers.length !== selected.length || servers.some((server) => server.status !== "connected" || !Array.isArray(server.tools))) {
        failure = "A selected MCP is unavailable or needs authentication. Authenticate it through its owning CLI, then retry."; controller.abort(); continue;
      }
      found = servers.map((server) => ({ id: server.name, tools: server.tools!.map((tool) => ({ name: tool.name, ...(tool.inputSchema === undefined ? {} : { schemaSha: createHash("sha256").update(JSON.stringify(tool.inputSchema)).digest("hex") }) })) }));
      controller.abort();
    }
  });
  // stdin stays open for the two control requests; managed cancellation owns
  // the complete CLI/MCP process group and settles before returning.
  request("initialize");
  try { await managed.settled; }
  finally { if (poll) clearTimeout(poll); signal?.removeEventListener("abort", abort); }
  if (signal?.aborted) throw new Error("Capability initialization was cancelled.");
  if (!found) throw new Error(failure);
  return found;
}
