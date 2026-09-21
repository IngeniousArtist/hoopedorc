import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Project, Task, WorkspaceFileEntry } from "@orc/types";
import { execManagedProcess, ManagedProcessError } from "@orc/adapters";

const MAX_FILES = 5_000;
const MAX_FILE_BYTES = 128 * 1024;
const hasControlCharacters = (value: string) => [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
export class WorkspaceInspectionError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}
export interface WorkspaceInspection {
  branch?: string; headSha?: string; baseSha?: string; dirty: boolean;
  changedFiles: number; files: WorkspaceFileEntry[]; truncated: boolean;
}
async function inspectGit(root: string, args: string[], maxOutputBytes = 1024 * 1024): Promise<string> {
  const { stdout: keys } = await execManagedProcess("git", ["config", "--null", "--name-only", "--list"], {
    cwd: root, maxOutputBytes: 128 * 1024, timeoutMs: 10_000,
  });
  const disabled = keys.split("\0").filter((key) => /^filter\..*\.(clean|smudge|process|required)$/.test(key))
    .flatMap((key) => ["-c", `${key}=${key.endsWith(".required") ? "false" : ""}`]);
  const result = await execManagedProcess("git", ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", ...disabled, ...args], {
    cwd: root, maxOutputBytes, timeoutMs: 10_000,
  });
  return result.stdout;
}

/** All symlinks are refused, including in intermediate directories. */
export function checkedWorkspaceFile(root: string, path: string): string {
  if (!path || path.length > 4096 || isAbsolute(path) || path.includes("\\") || hasControlCharacters(path) ||
      path.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) {
    throw new WorkspaceInspectionError("Choose a repository-relative file without traversal or Git metadata.", 400);
  }
  let cursor = root;
  for (const part of path.split("/")) {
    cursor = join(cursor, part);
    if (lstatSync(cursor).isSymbolicLink()) throw new WorkspaceInspectionError("Symlink files and directories are not available for inspection.", 403);
  }
  const canonical = realpathSync(cursor);
  const rel = relative(root, canonical);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new WorkspaceInspectionError("File is outside this workspace.", 403);
  }
  return canonical;
}

/** Caller owns the common Git lock. No clone, fetch, hooks or repository commands. */
export async function inspectWorkspaceRoot(project: Project, task?: Task): Promise<string> {
  const primary = realpathSync(project.localPath);
  if (realpathSync((await inspectGit(primary, ["rev-parse", "--show-toplevel"])).trim()) !== primary) {
    throw new WorkspaceInspectionError("The recorded primary clone is not a repository root.");
  }
  if (!task) return primary;
  if (task.projectId !== project.id || !/^[a-zA-Z0-9_-]+$/.test(task.id) || !task.worktreePath || !task.branch ||
      resolve(task.worktreePath) !== resolve(`${project.localPath}-wt-${task.id}`)) {
    throw new WorkspaceInspectionError("This task no longer owns the recorded workspace.");
  }
  if (lstatSync(task.worktreePath).isSymbolicLink()) throw new WorkspaceInspectionError("A task workspace cannot be a symlink.");
  const root = realpathSync(task.worktreePath);
  const common = async (path: string) => realpathSync(resolve(path, (await inspectGit(path, ["rev-parse", "--git-common-dir"])).trim()));
  if (root === primary || await common(root) !== await common(primary) ||
      realpathSync((await inspectGit(root, ["rev-parse", "--show-toplevel"])).trim()) !== root ||
      (await inspectGit(root, ["symbolic-ref", "--short", "HEAD"])).trim() !== task.branch) {
    throw new WorkspaceInspectionError("The workspace repository or branch no longer matches this task.");
  }
  const registered = (await inspectGit(primary, ["worktree", "list", "--porcelain", "-z"])).split("\0");
  if (!registered.includes(`worktree ${root}`)) throw new WorkspaceInspectionError("This workspace is no longer registered with the project.");
  return root;
}

export async function describeWorkspace(root: string, project: Project, task?: Task): Promise<WorkspaceInspection> {
  const [branchResult, headResult] = await Promise.allSettled([
    inspectGit(root, ["symbolic-ref", "--short", "--quiet", "HEAD"]),
    inspectGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"]),
  ]);
  for (const result of [branchResult, headResult]) {
    if (result.status === "rejected" && (!(result.reason instanceof ManagedProcessError) || result.reason.code !== 1)) throw result.reason;
  }
  const headSha = headResult.status === "fulfilled" ? headResult.value.trim() : undefined;
  const branch = branchResult.status === "fulfilled" ? branchResult.value.trim() : undefined;
  let baseSha = headSha;
  if (task && headSha) {
    baseSha = undefined;
    for (const ref of [`refs/remotes/origin/${project.defaultBranch}`, `refs/heads/${project.defaultBranch}`]) {
      try { baseSha = (await inspectGit(root, ["merge-base", "HEAD", ref])).trim(); break; }
      catch { /* Missing base is explicit: diff refuses until one is available. */ }
    }
  }
  const names = (await inspectGit(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])).split("\0").filter(Boolean);
  const untracked = new Set((await inspectGit(root, ["ls-files", "-z", "--others", "--exclude-standard"])).split("\0").filter(Boolean));
  const changed = new Set(baseSha ? (await inspectGit(root, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", baseSha, "--"])).split("\0").filter(Boolean) : names);
  for (const name of untracked) changed.add(name);
  const dirty = (await inspectGit(root, ["status", "--porcelain", "-z", "--untracked-files=normal"])).length > 0;
  const all = [...new Set([...names, ...changed])].sort();
  return { branch, headSha, baseSha, dirty, changedFiles: changed.size, truncated: all.length > MAX_FILES,
    files: all.slice(0, MAX_FILES).map((path) => ({ path, changed: changed.has(path), untracked: untracked.has(path) })) };
}

export function readWorkspaceFile(root: string, path: string): { content: string; contentSha: string } {
  const full = checkedWorkspaceFile(root, path);
  const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink > 1) throw new WorkspaceInspectionError("Only regular, unshared files can be inspected.", 403);
    if (info.size > MAX_FILE_BYTES) throw new WorkspaceInspectionError("This file exceeds the 128 KiB inspection limit.", 413);
    const data = Buffer.alloc(MAX_FILE_BYTES + 1);
    const count = readSync(fd, data, 0, data.length, 0);
    const after = lstatSync(checkedWorkspaceFile(root, path));
    if (count > MAX_FILE_BYTES) throw new WorkspaceInspectionError("This file exceeds the 128 KiB inspection limit.", 413);
    if (info.ino !== after.ino || info.dev !== after.dev || info.size !== after.size || info.mtimeMs !== after.mtimeMs) {
      throw new WorkspaceInspectionError("The file changed during inspection. Refresh and try again.");
    }
    const bytes = data.subarray(0, count);
    if (bytes.includes(0)) throw new WorkspaceInspectionError("Binary files cannot be displayed as code.", 415);
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new WorkspaceInspectionError("This file is not UTF-8 text.", 415); }
    if (content.split("\n").length > 5_000) throw new WorkspaceInspectionError("This file exceeds the 5,000-line inspection limit.", 413);
    return { content, contentSha: createHash("sha256").update(bytes).digest("hex") };
  } finally { closeSync(fd); }
}

export async function diffWorkspaceFile(root: string, path: string, baseSha?: string): Promise<string> {
  if (!baseSha) throw new WorkspaceInspectionError("A base commit is unavailable; inspect the file contents instead.");
  // Validate syntactic scope even for deleted files. Git receives a literal pathspec.
  if (!path || isAbsolute(path) || path.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git") || path.includes("\\") || hasControlCharacters(path)) {
    throw new WorkspaceInspectionError("Invalid repository-relative file.", 400);
  }
  try { checkedWorkspaceFile(root, path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return inspectGit(root, ["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", baseSha, "--", path], 256 * 1024);
}
