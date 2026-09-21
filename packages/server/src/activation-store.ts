import type { ActivationManifest, ActivationPolicy, ActivationResponse, ActivationRevision, SaveActivationRequest } from "@orc/types";
import { SELECTIVE_CLAUDE_VERSION } from "@orc/adapters";
import type { Db } from "./db/index";
import { LibraryError, LibraryStore, libraryHash, parseLibrarySelection } from "./library";

export const inheritedActivation = (): ActivationPolicy => ({ mode: "inherit", skills: [], mcps: [], browser: false });
export const activationToken = (revision: number) => `hoop-activation:${revision}`;
export function activationRevision(description: string): number | undefined {
  const tokens = [...description.matchAll(/hoop-activation:([1-9][0-9]*)\b/g)];
  if (tokens.length !== (description.match(/hoop-activation:/g)?.length ?? 0) || new Set(tokens.map((t) => t[1])).size > 1) throw new LibraryError("The task has malformed or conflicting activation revisions. Choose one exact hoop-activation:<revision> marker.");
  const revision = tokens.length ? Number(tokens[0]![1]) : undefined;
  if (revision !== undefined && !Number.isSafeInteger(revision)) throw new LibraryError("The activation revision is invalid.");
  return revision;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LibraryError("Expected an activation object.", 400);
  return value as Record<string, unknown>;
}
const clean = (value: unknown, limit: number): value is string => typeof value === "string" && value.length <= limit && !/[\0\r\n]/.test(value);
function keys(value: Record<string, unknown>, allowed: string[]) { if (Object.keys(value).some((k) => !allowed.includes(k))) throw new LibraryError("Unknown activation setting. Native plugin bundles, environment overrides and embedded credentials are not supported.", 400); }
export function parseActivationSave(value: unknown): SaveActivationRequest {
  const raw = object(value); keys(raw, ["requestId", "expectedRevision", "policy"]);
  if (typeof raw.requestId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(raw.requestId) || !Number.isSafeInteger(raw.expectedRevision) || (raw.expectedRevision as number) < 0) throw new LibraryError("Use a UUID v4 request ID and a non-negative expected revision.", 400);
  const policy = object(raw.policy); keys(policy, ["mode", "skills", "mcps", "browser"]);
  if (!["inherit", "selected"].includes(policy.mode as string) || typeof policy.browser !== "boolean" || !Array.isArray(policy.skills) || !Array.isArray(policy.mcps) || policy.mcps.length > 12) throw new LibraryError("Choose an activation mode, up to 20 skills and up to 12 MCP registrations.", 400);
  const skills = policy.skills.length ? parseLibrarySelection({ references: policy.skills }) : [];
  const ids = new Set<string>();
  const mcps: ActivationPolicy["mcps"] = policy.mcps.map((item) => {
    const entry = object(item); keys(entry, ["id", "enabled", "transport"]);
    if (typeof entry.id !== "string" || !/^[a-z][a-z0-9_-]{0,47}$/.test(entry.id) || entry.id === "hoop-browser" || ids.has(entry.id) || typeof entry.enabled !== "boolean") throw new LibraryError("MCP IDs must be unique lowercase names; hoop-browser is reserved.", 400);
    ids.add(entry.id); const transport = object(entry.transport);
    if (transport.type === "stdio") {
      keys(transport, ["type", "command", "args"]);
      if (!clean(transport.command, 1000) || !transport.command.startsWith("/") || !Array.isArray(transport.args) || transport.args.length > 32 || transport.args.some((arg) => !clean(arg, 2000))) throw new LibraryError("A stdio MCP requires an absolute installed command path and at most 32 arguments. No shell expansion or installation is performed.", 400);
      return { id: entry.id, enabled: entry.enabled, transport: { type: "stdio", command: transport.command, args: transport.args as string[] } };
    }
    keys(transport, ["type", "url"]);
    let url: URL; try { url = new URL(String(transport.url)); } catch { throw new LibraryError("Use a complete HTTP(S) MCP URL.", 400); }
    if (transport.type !== "http" || !clean(transport.url, 2000) || !["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new LibraryError("MCP URLs must be HTTP(S) without credentials, query parameters or fragments. Authentication stays with the CLI.", 400);
    return { id: entry.id, enabled: entry.enabled, transport: { type: "http", url: url.href } };
  });
  return { requestId: raw.requestId, expectedRevision: raw.expectedRevision as number, policy: { mode: policy.mode as ActivationPolicy["mode"], skills, mcps, browser: policy.browser } };
}

export class ActivationStore {
  constructor(readonly db: Db) {}
  version(projectId: string, revision?: number): ActivationRevision {
    if (revision === 0) return { projectId, revision: 0, createdAt: "", policy: inheritedActivation() };
    const row = this.db.prepare(`SELECT json FROM activation_versions WHERE project_id = ? ${revision === undefined ? "ORDER BY revision DESC LIMIT 1" : "AND revision = ?"}`).get(...(revision === undefined ? [projectId] : [projectId, revision])) as { json: string } | undefined;
    if (!row && revision !== undefined) throw new LibraryError("The selected activation revision is unavailable in this project.");
    return row ? JSON.parse(row.json) as ActivationRevision : this.version(projectId, 0);
  }
  resolve(projectId: string, description = ""): ActivationRevision { return this.version(projectId, activationRevision(description)); }
  save(projectId: string, input: SaveActivationRequest): ActivationRevision {
    const request = parseActivationSave(input); const hash = libraryHash(JSON.stringify(request));
    return this.db.transaction(() => {
      const receipt = this.db.prepare("SELECT project_id, revision, request_hash FROM activation_versions WHERE request_id = ?").get(request.requestId) as { project_id: string; revision: number; request_hash: string } | undefined;
      if (receipt) { if (receipt.project_id !== projectId || receipt.request_hash !== hash) throw new LibraryError("This request ID belongs to a different activation edit."); return this.version(projectId, receipt.revision); }
      const prior = this.version(projectId);
      if (prior.revision !== request.expectedRevision) throw new LibraryError("Activation changed in another session. Reload before saving; your draft is preserved.");
      if (prior.revision >= 200) throw new LibraryError("This project has reached 200 activation revisions. Existing history is preserved.");
      const selected = new LibraryStore(this.db).resolve(projectId, request.policy.skills, false);
      if (selected.some((ref) => ref.kind !== "skill")) throw new LibraryError("Only Library entries marked Skill may be activated as instructions.", 400);
      const value: ActivationRevision = { projectId, revision: prior.revision + 1, policy: request.policy, createdAt: new Date().toISOString() };
      this.db.prepare("INSERT INTO activation_versions (project_id, revision, request_id, request_hash, json) VALUES (?, ?, ?, ?, ?)").run(projectId, value.revision, request.requestId, hash, JSON.stringify(value));
      return value;
    })();
  }
  manifest(value: ActivationManifest) {
    this.db.prepare("INSERT INTO activation_manifests (id, project_id, json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json WHERE project_id = excluded.project_id").run(value.id, value.projectId, JSON.stringify(value));
  }
  response(projectId: string): ActivationResponse {
    return { current: this.version(projectId), revisions: (this.db.prepare("SELECT json FROM activation_versions WHERE project_id = ? ORDER BY revision DESC").all(projectId) as { json: string }[]).map((r) => JSON.parse(r.json) as ActivationRevision),
      manifests: (this.db.prepare("SELECT json FROM activation_manifests WHERE project_id = ? ORDER BY rowid DESC LIMIT 50").all(projectId) as { json: string }[]).map((r) => JSON.parse(r.json) as ActivationManifest),
      compatibility: [ { runner: "claude-code", selective: true, detail: `Claude Code ${SELECTIVE_CLAUDE_VERSION}: selected instruction snapshots and MCPs; repository instructions and managed policy remain inherited.` }, ...(["codex", "opencode", "gemini"] as const).map((runner) => ({ runner, selective: false, detail: "Selective activation is not yet verified. Inherited CLI configuration remains available." })) ],
      nativePlugins: { supported: false, reason: "Native plugin bundles may include agents, hooks, skills and MCPs with different controls. Complete selective activation is not verified; register individual skills and MCPs instead." } };
  }
}
