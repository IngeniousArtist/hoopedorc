import { randomUUID } from "node:crypto";
import { GitServiceImpl, WorkspaceInspectionError } from "@orc/engine";
import type { ImportLibraryResponse, Project, ReferenceInput } from "@orc/types";
import type { Db } from "./db/index";
import * as repo from "./db/repo";
import { LibraryError, libraryHash, LibraryStore, referenceInput } from "./library";

function legacyHandoff(description: string): string {
  const lines = description.split("\n"); const selected: string[] = []; let collecting = false;
  for (const line of lines) {
    if (/^\s{0,3}#{2,6}\s/.test(line)) collecting = /^\s{0,3}#{2,6}\s+(Relevant references|Required skills\/capabilities)\s*#*\s*$/i.test(line);
    if (collecting) selected.push(line);
  }
  return selected.join("\n").trim();
}

/** Import snapshots into SQLite only. Never write, delete or commit source files. */
export async function importProjectLibrary(db: Db, project: Project, mock: boolean): Promise<ImportLibraryResponse> {
  const store = new LibraryStore(db); const result: ImportLibraryResponse = { imported: 0, unchanged: 0, issues: [] };
  const sources: ReferenceInput[] = [];
  const add = (title: string, kind: ReferenceInput["kind"], source: ReferenceInput["source"], content: string, applicability = "Project reference; select for applicable tasks") => {
    sources.push({ title: title.slice(0, 160), kind, source, content, applicability, conflictGroup: "", archived: false });
  };
  if (mock) add("DESIGN.md", "design", { type: "repository", locator: "DESIGN.md", revision: "mock-fixture-v1" }, "# Design guidance\nUse existing components and readable focus states. This is a mock fixture.");
  else {
    const git = new GitServiceImpl();
    try {
      const inventory = await git.inspectWorkspace(project);
      if (inventory.truncated) result.issues.push("Repository inventory exceeded 5,000 files; import only inspected the bounded inventory.");
      const paths = inventory.files.filter((file) => /^(agents|claude|design|brand)\.md$/i.test(file.path) || /^context\/attachments\/[^/]+$/.test(file.path));
      if (paths.length > 50) result.issues.push("Only the first 50 repository sources were considered. Add other references explicitly.");
      for (const { path } of paths.slice(0, 50)) {
        if (/\.(png|jpe?g|gif|webp|pdf)$/i.test(path)) {
          add(path, /\.pdf$/i.test(path) ? "reference" : "screenshot", { type: "attachment", locator: path }, "Existing attachment pointer. Contents and source revision have not been verified by the Library; inspect the original before relying on it.");
          continue;
        }
        try {
          const inspected = await git.inspectWorkspace(project, undefined, { path });
          const contents = inspected.contents!;
          add(path, /^(agents|claude)\.md$/i.test(path) ? "rules" : /^(design|brand)\.md$/i.test(path) ? "design" : "reference",
            { type: "repository", locator: path, revision: `sha256:${contents.contentSha}` }, contents.content);
        } catch (error) { result.issues.push(`${path}: ${error instanceof WorkspaceInspectionError ? error.message : "Source could not be safely inspected."}`); }
      }
    } catch (error) { result.issues.push(error instanceof WorkspaceInspectionError ? error.message : "Repository is unavailable. Existing database references can still be imported; source files are unchanged."); }
  }
  for (const figma of repo.getPlanningSession(db, project.id).verifiedFigmaReferences ?? []) {
    add(figma.name, "figma", { type: "url", locator: figma.canonicalUrl }, `Previously verified Figma node ${figma.nodeId} at ${figma.verifiedAt}. Live access is not reverified by this import.`);
  }
  const legacyTasks = repo.getTasks(db, project.id).filter((task) => legacyHandoff(task.description) && !task.description.includes("hoop-reference:"));
  if (legacyTasks.length > 50) result.issues.push("Only the first 50 legacy task handoffs were indexed. All original task Markdown remains available.");
  for (const task of legacyTasks.slice(0, 50)) {
    const content = legacyHandoff(task.description);
    add(`Task handoff: ${task.title}`, "reference", { type: "legacy-task", locator: task.id, revision: `sha256:${libraryHash(content)}` }, content, `Historical task ${task.title}; review before reusing`);
  }
  if (repo.getProject(db, project.id)?.localPath !== project.localPath) throw new LibraryError("Project workspace changed during import. Refresh and retry; no sources were written.");
  for (const source of sources) {
    const id = `legacy-${libraryHash(`${source.source.type}:${source.source.locator}`).slice(0, 32)}`;
    const previous = store.version(project.id, id);
    if (previous?.archived || previous?.provenance === "operator") { result.unchanged++; continue; }
    try {
      const input = referenceInput(source);
      if (previous && previous.contentSha === libraryHash(input.content) && previous.source.revision === input.source.revision) { result.unchanged++; continue; }
      store.save(project.id, id, { requestId: randomUUID(), expectedRevision: previous?.revision ?? 0, reference: input }, "legacy-import"); result.imported++;
    } catch (error) {
      if (!(error instanceof LibraryError)) throw error;
      result.issues.push(`${source.title}: ${error.message}`);
    }
  }
  return result;
}
