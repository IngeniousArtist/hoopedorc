import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DraftTask, PlanChatMessage, PlanSessionArchive, Project } from "@orc/types";
import type { Db } from "./db/index";
import * as repo from "./db/repo";
import { contextDir } from "./context-dir";

/**
 * F28: one markdown file per planning session at
 * `context/plan-sessions/<YYYY-MM-DD-HHmm>.md` — the owner's readable
 * archive of every plan-mode chat. A "session" is exactly what the
 * existing planning-session DB row already models: it starts with the
 * first chat turn after the row is empty and ends when `/plan/commit`
 * clears it, so "plan again" naturally starts a new file. Each of the
 * three planning routes (chat/deconstruct/commit) rewrites the WHOLE file
 * from current state rather than appending — simpler and can't drift out
 * of sync with the DB row it mirrors.
 */

function sessionsDir(project: Project, mock: boolean): string {
  return join(contextDir(project, mock), "plan-sessions");
}

/**
 * All archived plan-session files for a project, newest first — the Plan
 * tab's read-only history of every past planning conversation (the live
 * session row is cleared on commit, so without this the chat visually
 * vanishes the moment a plan is committed). Filenames sort chronologically
 * by construction (mintSessionFilename), so a plain reverse-lexicographic
 * sort is newest-first. Best-effort like every other archive path in this
 * file: an unreadable dir/file just yields an empty/shorter list, never an
 * error to the caller.
 */
export function listArchivedSessions(project: Project, mock: boolean): PlanSessionArchive[] {
  const dir = sessionsDir(project, mock);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".md"));
  } catch {
    return []; // dir doesn't exist yet — no sessions archived
  }
  names.sort().reverse();
  const sessions: PlanSessionArchive[] = [];
  for (const name of names) {
    try {
      sessions.push({
        name,
        startedLabel: describeSessionStart(name),
        markdown: readFileSync(join(dir, name), "utf8"),
      });
    } catch {
      /* skip unreadable file */
    }
  }
  return sessions;
}

/**
 * Minute-resolution timestamp — but two sessions (e.g. commit, then
 * immediately start a new chat) can land in the same clock minute, and a
 * plain collision would silently overwrite the just-archived file instead
 * of starting the "different session" the owner asked for. Dedupe against
 * `dir` the same way attachments.ts suffixes `-2`, `-3`… on collision.
 */
function mintSessionFilename(dir: string, now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const base = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  if (!existsSync(join(dir, `${base}.md`))) return `${base}.md`;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}.md`;
    if (!existsSync(join(dir, candidate))) return candidate;
  }
}

/** Best-effort inverse of mintSessionFilename, for a human-readable header
 *  line — falls back to the raw filename if it doesn't match (e.g. a
 *  session file renamed by hand). */
function describeSessionStart(filename: string): string {
  const m = filename.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(?:-\d+)?\.md$/);
  if (!m) return filename;
  const [, y, mo, d, h, mi] = m;
  return `${y}-${mo}-${d} ${h}:${mi}`;
}

interface RenderInput {
  projectName: string;
  plannerModel?: string;
  sessionFile: string;
  messages: PlanChatMessage[];
  deconstructed?: { prdMarkdown: string; tasks: DraftTask[] };
  committed?: { atIso: string; taskCount: number };
}

export type PlanSessionWriteResult =
  | { ok: true }
  | { ok: false; error: string };

function renderSessionMarkdown(input: RenderInput): string {
  const lines: string[] = [
    `# Planning session — ${input.projectName}`,
    "",
    `- Started: ${describeSessionStart(input.sessionFile)}`,
  ];
  if (input.plannerModel) lines.push(`- Planner model: ${input.plannerModel}`);
  lines.push("");

  for (const m of input.messages) {
    lines.push(`## ${m.role === "user" ? "User" : "Assistant"}`, "", m.content, "");
  }

  if (input.deconstructed) {
    lines.push("## Deconstructed plan", "", input.deconstructed.prdMarkdown.trim(), "", "### Tasks", "");
    input.deconstructed.tasks.forEach((t, i) => {
      const deps = t.dependsOn.length ? ` (depends on: ${t.dependsOn.join(", ")})` : "";
      const role = t.role ? `, role: ${t.role}` : "";
      lines.push(`${i + 1}. **${t.title}** — difficulty: ${t.difficulty}${role}${deps}`);
    });
    lines.push("");
  }

  if (input.committed) {
    lines.push(
      "## Committed",
      "",
      `Committed ${input.committed.taskCount} task(s) at ${input.committed.atIso}.`,
      "",
    );
  }

  return lines.join("\n");
}

/** Return a typed outcome and log it through the injected warning sink.
 * Chat/deconstruct remain best-effort; B39's commit boundary treats a failed
 * final archive write as retryable and refuses to clear the DB session. */
function writeSessionFile(
  dir: string,
  filename: string,
  markdown: string,
  warn: (msg: string) => void,
): PlanSessionWriteResult {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, filename), markdown, "utf8");
    return { ok: true };
  } catch (err) {
    const error =
      `plan session file write failed (${filename}): ` +
      `${err instanceof Error ? err.message : String(err)}`;
    warn(error);
    return { ok: false, error };
  }
}

function ensureSessionFile(
  db: Db,
  projectId: string,
  existing: string | undefined,
  dir: string,
): string {
  if (existing) return existing;
  const filename = mintSessionFilename(dir);
  repo.savePlanningSession(db, projectId, { sessionFile: filename });
  return filename;
}

/** Call after persisting a /plan/chat turn — mints the session file on the
 *  first turn, then rewrites it with the full transcript so far. */
export function recordPlanChatTurn(
  db: Db,
  project: Project,
  mock: boolean,
  messages: PlanChatMessage[],
  plannerModel: string | undefined,
  warn: (msg: string) => void,
): void {
  const dir = sessionsDir(project, mock);
  const session = repo.getPlanningSession(db, project.id);
  const filename = ensureSessionFile(db, project.id, session.sessionFile, dir);
  const markdown = renderSessionMarkdown({
    projectName: project.name,
    plannerModel,
    sessionFile: filename,
    messages,
  });
  writeSessionFile(dir, filename, markdown, warn);
}

/** Call after a /plan/deconstruct turn — appends (via full rewrite) the
 *  deconstructed PRD + task list section. */
export function recordPlanDeconstruct(
  db: Db,
  project: Project,
  mock: boolean,
  messages: PlanChatMessage[],
  prdMarkdown: string,
  tasks: DraftTask[],
  plannerModel: string | undefined,
  warn: (msg: string) => void,
): void {
  const dir = sessionsDir(project, mock);
  const session = repo.getPlanningSession(db, project.id);
  const filename = ensureSessionFile(db, project.id, session.sessionFile, dir);
  const markdown = renderSessionMarkdown({
    projectName: project.name,
    plannerModel,
    sessionFile: filename,
    messages,
    deconstructed: { prdMarkdown, tasks },
  });
  writeSessionFile(dir, filename, markdown, warn);
}

/** Call from /plan/commit BEFORE the planning-session DB row is cleared —
 *  writes the final "## Committed" marker using the about-to-be-cleared
 *  state. No-ops (nothing to finalize) if the session never had a file,
 *  e.g. a commit with no prior chat turn. Does not itself clear
 *  `sessionFile` — the commit route's own savePlanningSession call does
 *  that, so the next chat turn mints a genuinely new file. */
export function recordPlanCommit(
  db: Db,
  project: Project,
  mock: boolean,
  taskCount: number,
  plannerModel: string | undefined,
  warn: (msg: string) => void,
): PlanSessionWriteResult {
  const session = repo.getPlanningSession(db, project.id);
  if (!session.sessionFile) return { ok: true };
  const markdown = renderSessionMarkdown({
    projectName: project.name,
    plannerModel,
    sessionFile: session.sessionFile,
    messages: session.messages,
    deconstructed:
      session.prd && session.draftTasks
        ? { prdMarkdown: session.prd, tasks: session.draftTasks }
        : undefined,
    committed: { atIso: new Date().toISOString(), taskCount },
  });
  return writeSessionFile(sessionsDir(project, mock), session.sessionFile, markdown, warn);
}
