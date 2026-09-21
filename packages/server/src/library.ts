import { createHash } from "node:crypto";
import type { LibraryDetailResponse, LibraryEntry, LibraryReference, LibrarySelection, ReferenceInput, ReferenceKind, SaveLibraryReferenceRequest } from "@orc/types";
import type { Db } from "./db/index";
import * as repo from "./db/repo";

export class LibraryError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}
export const libraryHash = (value: string) => createHash("sha256").update(value).digest("hex");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const kinds: ReferenceKind[] = ["rules", "design", "tokens", "component", "framework", "figma", "screenshot", "skill", "reference"];
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LibraryError("Expected a reference object.", 400);
  return value as Record<string, unknown>;
};
const text = (value: unknown, name: string, max: number, empty = false): string => {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > max || value.includes("\0")) throw new LibraryError(`${name} must be ${empty ? "0" : "1"}–${max} characters.`, 400);
  return value;
};
export function referenceInput(value: unknown): ReferenceInput {
  const raw = object(value); const source = object(raw.source);
  if (!kinds.includes(raw.kind as ReferenceKind)) throw new LibraryError("Unknown reference kind.", 400);
  if (!["text", "url", "repository", "attachment", "legacy-task"].includes(source.type as string)) throw new LibraryError("Unknown reference source.", 400);
  const locator = text(source.locator, "Source", 2000, source.type === "text");
  if (source.type === "url") {
    let url: URL; try { url = new URL(locator); } catch { throw new LibraryError("Use a complete http(s) source URL.", 400); }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new LibraryError("Source URLs must use http(s) without credentials.", 400);
  }
  if (["repository", "attachment"].includes(source.type as string) && (locator.startsWith("/") || locator.includes("\\") || locator.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git"))) throw new LibraryError("Use a repository-relative source path.", 400);
  const content = text(raw.content, "Content", 32_000, true);
  if (Buffer.byteLength(content) > 32 * 1024) throw new LibraryError("Reference content exceeds 32 KiB.", 413);
  if (typeof raw.archived !== "boolean") throw new LibraryError("archived must be a boolean.", 400);
  return { title: text(raw.title, "Title", 160).trim(), kind: raw.kind as ReferenceKind,
    source: { type: source.type as ReferenceInput["source"]["type"], locator, ...(source.revision !== undefined ? { revision: text(source.revision, "Source revision", 200) } : {}) },
    applicability: text(raw.applicability, "Applicability", 500, true), conflictGroup: text(raw.conflictGroup, "Conflict group", 80, true).trim().toLowerCase(), content, archived: raw.archived };
}
export function parseLibrarySave(value: unknown): SaveLibraryReferenceRequest {
  const raw = object(value); const requestId = text(raw.requestId, "Request ID", 36);
  if (!UUID.test(requestId) || !Number.isInteger(raw.expectedRevision) || (raw.expectedRevision as number) < 0) throw new LibraryError("Use a UUID v4 request ID and non-negative expected revision.", 400);
  return { requestId, expectedRevision: raw.expectedRevision as number, reference: referenceInput(raw.reference) };
}
export function parseLibrarySelection(value: unknown): LibrarySelection[] {
  const raw = object(value);
  if (!Array.isArray(raw.references) || raw.references.length < 1 || raw.references.length > 20) throw new LibraryError("Select 1–20 reference revisions.", 400);
  return raw.references.map((item) => {
    const row = object(item);
    if (typeof row.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(row.id) || !Number.isInteger(row.revision) || (row.revision as number) < 1) throw new LibraryError("Invalid reference revision.", 400);
    return { id: row.id, revision: row.revision as number };
  });
}

/** Markers stay in the existing Markdown handoff; content is resolved by version. */
export const libraryToken = (item: LibrarySelection) => `hoop-reference:${item.id}@${item.revision}`;
export function selectedLibraryReferences(description: string): LibrarySelection[] {
  const values = [...description.matchAll(/hoop-reference:([a-zA-Z0-9_-]{1,100})@([1-9][0-9]*)\b/g)];
  if ((description.match(/hoop-reference:/g)?.length ?? 0) !== values.length) throw new LibraryError("A library reference marker is malformed. Restore its exact ID and revision in the task.");
  const unique = new Map(values.map((item) => [`${item[1]}@${item[2]}`, { id: item[1]!, revision: Number(item[2]) }]));
  if (unique.size > 20) throw new LibraryError("This task selects more than 20 library references. Narrow its handoff.");
  return [...unique.values()];
}

export class LibraryStore {
  constructor(readonly db: Db) {}
  version(projectId: string, id: string, revision?: number): LibraryReference | null {
    const row = this.db.prepare(`SELECT json FROM library_versions WHERE project_id = ? AND reference_id = ? ${revision === undefined ? "ORDER BY revision DESC LIMIT 1" : "AND revision = ?"}`)
      .get(...(revision === undefined ? [projectId, id] : [projectId, id, revision])) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as LibraryReference : null;
  }
  detail(projectId: string, id: string): LibraryDetailResponse {
    const reference = this.version(projectId, id); if (!reference) throw new LibraryError("Reference not found for this project.", 404);
    const versions = (this.db.prepare("SELECT json FROM library_versions WHERE project_id = ? AND reference_id = ? ORDER BY revision DESC").all(projectId, id) as { json: string }[]).map((row) => JSON.parse(row.json) as LibraryReference);
    return { reference, versions };
  }
  list(projectId: string): LibraryEntry[] {
    const rows = this.db.prepare("SELECT json FROM library_versions v WHERE project_id = ? AND revision = (SELECT MAX(revision) FROM library_versions WHERE project_id = v.project_id AND reference_id = v.reference_id) ORDER BY rowid DESC").all(projectId) as { json: string }[];
    const entries = rows.map((row) => JSON.parse(row.json) as LibraryReference);
    const tasks = repo.getTasks(this.db, projectId);
    return entries.map(({ content, ...entry }) => ({ ...entry, contentBytes: Buffer.byteLength(content),
      referencedByTasks: tasks.flatMap((task) => {
        const revisions = [...task.description.matchAll(new RegExp(`hoop-reference:${entry.id}@([1-9][0-9]*)\\b`, "g"))].map((m) => Number(m[1]));
        return revisions.length ? [{ id: task.id, title: task.title, revisions: [...new Set(revisions)] }] : [];
      }),
      conflictsWith: !entry.archived && entry.conflictGroup ? entries.filter((item) => !item.archived && item.id !== entry.id && item.conflictGroup === entry.conflictGroup).map((item) => item.id) : [],
    }));
  }
  save(projectId: string, id: string, request: SaveLibraryReferenceRequest, provenance: LibraryReference["provenance"] = "operator"): LibraryReference {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new LibraryError("Invalid reference ID.", 400);
    const hash = libraryHash(JSON.stringify({ projectId, id, request }));
    return this.db.transaction(() => {
      const receipt = this.db.prepare("SELECT project_id, reference_id, revision, request_hash FROM library_writes WHERE request_id = ?").get(request.requestId) as { project_id: string; reference_id: string; revision: number; request_hash: string } | undefined;
      if (receipt) {
        if (receipt.request_hash !== hash) throw new LibraryError("Request ID belongs to another reference edit.");
        return this.version(receipt.project_id, receipt.reference_id, receipt.revision)!;
      }
      if (!repo.getProject(this.db, projectId)) throw new LibraryError("Project not found.", 404);
      const previous = this.version(projectId, id);
      if ((previous?.revision ?? 0) !== request.expectedRevision) throw new LibraryError("This reference changed in another session. Reload its latest revision; your draft has been preserved.");
      if (!previous && (this.db.prepare("SELECT COUNT(DISTINCT reference_id) AS count FROM library_versions WHERE project_id = ?").get(projectId) as { count: number }).count >= 200) throw new LibraryError("Project library is limited to 200 entries; existing history is preserved.");
      if ((previous?.revision ?? 0) >= 50) throw new LibraryError("This reference has reached its 50-revision limit; create a new entry and retain this history.");
      const value: LibraryReference = { ...referenceInput(request.reference), id, projectId, revision: (previous?.revision ?? 0) + 1, contentSha: libraryHash(request.reference.content), createdAt: new Date().toISOString(), provenance };
      const json = JSON.stringify(value);
      const used = (this.db.prepare("SELECT COALESCE(SUM(length(CAST(json AS BLOB))), 0) AS bytes FROM library_versions WHERE project_id = ?").get(projectId) as { bytes: number }).bytes;
      if (used + Buffer.byteLength(json) > 10 * 1024 * 1024) throw new LibraryError("Project reference history reached 10 MiB. Existing sources are preserved.");
      this.db.prepare("INSERT INTO library_versions (project_id, reference_id, revision, json) VALUES (?, ?, ?, ?)").run(projectId, id, value.revision, json);
      this.db.prepare("INSERT INTO library_writes (request_id, project_id, reference_id, revision, request_hash) VALUES (?, ?, ?, ?, ?)").run(request.requestId, projectId, id, value.revision, hash);
      return value;
    })();
  }
  resolve(projectId: string, selection: LibrarySelection[], allowArchived = true): LibraryReference[] {
    const values: LibraryReference[] = []; const ids = new Map<string, number>(); const groups = new Map<string, string>();
    for (const selected of selection) {
      const prior = ids.get(selected.id);
      if (prior && prior !== selected.revision) throw new LibraryError("Conflicting revisions of one source are selected. Choose exactly one revision.");
      if (prior) continue;
      const item = this.version(projectId, selected.id, selected.revision);
      if (!item) throw new LibraryError(`Reference ${libraryToken(selected)} is unavailable in this project. Restore or replace it before running the task.`);
      if (!allowArchived && (item.archived || this.version(projectId, item.id)?.archived)) throw new LibraryError("An archived reference is selected. Restore it or choose another reference.");
      if (item.conflictGroup && groups.has(item.conflictGroup)) throw new LibraryError(`Conflicting sources for “${item.conflictGroup}”: ${groups.get(item.conflictGroup)} and ${item.title}. Select one alternative before planning or running.`);
      if (item.conflictGroup) groups.set(item.conflictGroup, item.title);
      ids.set(item.id, item.revision); values.push(item);
    }
    if (values.reduce((total, item) => total + Buffer.byteLength(item.content), 0) > 64 * 1024) throw new LibraryError("Selected reference content exceeds 64 KiB. Narrow the selection.");
    return values;
  }
  context(projectId: string, description: string): string {
    const values = this.resolve(projectId, selectedLibraryReferences(description));
    if (!values.length) return "";
    return "\n## Selected project references\nFollow explicit task requirements, then project rules, existing code/components, project design system and general defaults. Report contradictions rather than silently choosing. These are reference snapshots, not proof of live source access or enabled tools.\n" + values.map((item) =>
      `\n### ${item.title} (${libraryToken(item)})\nKind: ${item.kind}; applies to: ${item.applicability || "operator-selected task"}\nSource: ${item.source.locator || "operator text"}; source revision: ${item.source.revision || "unknown"}; content SHA-256: ${item.contentSha}\n${item.content}\n`).join("");
  }
  checkTask(projectId: string, description: string): string | null {
    try { this.context(projectId, description); return null; }
    catch (error) { if (error instanceof LibraryError) return error.message; throw error; }
  }
  handoff(projectId: string, selection: LibrarySelection[]): string {
    const values = this.resolve(projectId, selection, false);
    const markers = values.map((item) => `- ${libraryToken(item)} — ${item.title}`).join("\n");
    return `Use these explicitly selected library revisions for the relevant tasks. Preserve their exact hoop-reference markers in each applicable task's Relevant references section. Do not activate a tool merely because it is referenced.\n\n${markers}\n${this.context(projectId, markers)}`;
  }
}
