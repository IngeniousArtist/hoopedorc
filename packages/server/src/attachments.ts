import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import type { PlanAttachment, Project } from "@orc/types";
import { contextDir } from "./context-dir";

/**
 * F27: plan-mode attachments (images/PDFs/reference files) live in the
 * project's own clone at `context/attachments/` — the planner already runs
 * `claude -p` with the clone as its cwd (see `resolvePlannerCwd` in
 * index.ts), so it reads these with its own file tools. No base64-into-
 * prompt plumbing, no size explosion in the transcript.
 *
 * This module is the write-to-disk surface (S-item-grade care, same as
 * S4's localPath validation): every name that reaches disk has already
 * been through `sanitizeAttachmentName` (charset + extension allowlist)
 * and every path through `resolveAttachmentPath` (containment).
 */

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const ALLOWED_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "pdf",
  "md",
  "txt",
  "csv",
  "json",
]);

export function attachmentsDir(project: Project, mock: boolean): string {
  return join(contextDir(project, mock), "attachments");
}

/**
 * Reduce a client-supplied filename to a safe attachment name, or return
 * null if it can't be made safe. Never throws.
 *  - `basename()` strips any directory components the client might send.
 *  - every character outside `[A-Za-z0-9._-]` becomes `_` (common
 *    filenames with spaces/unicode still work, just normalized).
 *  - a name that's empty or starts with `.` after sanitizing is rejected
 *    outright (dotfiles have no legitimate use here, and this is also what
 *    keeps a name like ".." from ever reaching the containment check).
 *  - the extension must be in the allowlist — coercing an unlisted
 *    extension to something safe isn't possible, so this rejects rather
 *    than mangling it.
 */
export function sanitizeAttachmentName(raw: string): string | null {
  const base = basename(raw).replace(/[^A-Za-z0-9._-]/g, "_");
  if (!base || base.startsWith(".")) return null;
  const dot = base.lastIndexOf(".");
  if (dot === -1) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) return null;
  return base;
}

/** Resolve `name` inside `dir`, rejecting anything that would resolve
 *  outside it — belt-and-braces alongside `sanitizeAttachmentName` (which
 *  already can't produce a path-escaping name on its own, since it strips
 *  `/` and rejects a leading `.`), mirroring S4's containment reasoning. */
export function resolveAttachmentPath(dir: string, name: string): string | null {
  const dirResolved = resolve(dir) + sep;
  const resolved = resolve(dir, name);
  if (!resolved.startsWith(dirResolved)) return null;
  return resolved;
}

/** `name-2.ext`, `name-3.ext`, … on collision, rather than silently
 *  overwriting an existing attachment. */
function uniqueAttachmentName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name;
  const dot = name.lastIndexOf(".");
  const stem = name.slice(0, dot);
  const ext = name.slice(dot);
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!existsSync(join(dir, candidate))) return candidate;
  }
}

export function listAttachments(dir: string): PlanAttachment[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => !f.startsWith("."))
    .map((name) => {
      const st = statSync(join(dir, name));
      return { name, size: st.size, mtime: st.mtime.toISOString() };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Writes `buffer` under a sanitized, collision-free name inside `dir` and
 *  returns the updated listing. Caller has already validated `sanitized`
 *  via `sanitizeAttachmentName`. */
export function saveAttachment(
  dir: string,
  sanitized: string,
  buffer: Buffer,
): PlanAttachment[] {
  mkdirSync(dir, { recursive: true });
  const finalName = uniqueAttachmentName(dir, sanitized);
  const finalPath = resolveAttachmentPath(dir, finalName);
  if (!finalPath) {
    // Unreachable given sanitizeAttachmentName's guarantees, but never
    // write outside `dir` no matter what.
    throw new Error("resolved attachment path escaped its directory");
  }
  writeFileSync(finalPath, buffer);
  return listAttachments(dir);
}

/** Deletes `name` from `dir` if it exists and resolves safely inside it.
 *  Returns the updated listing, or null if the file wasn't there (or the
 *  name couldn't be safely resolved) — callers should treat null as 404. */
export function removeAttachment(dir: string, name: string): PlanAttachment[] | null {
  const sanitized = sanitizeAttachmentName(name);
  if (!sanitized) return null;
  const resolved = resolveAttachmentPath(dir, sanitized);
  if (!resolved || !existsSync(resolved)) return null;
  unlinkSync(resolved);
  return listAttachments(dir);
}
