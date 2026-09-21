import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Project, Task } from "@orc/types";
import { GitServiceImpl } from "./git-service";
import { checkedWorkspaceFile, readWorkspaceFile } from "./workspace-inspection";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hoop-vw08-"));
  const localPath = join(root, "primary"); mkdirSync(localPath);
  git(localPath, ["init", "-q", "-b", "main"]);
  git(localPath, ["config", "user.email", "test@example.com"]); git(localPath, ["config", "user.name", "Test"]);
  writeFileSync(join(localPath, "code.ts"), "export const answer = 1;\n");
  git(localPath, ["add", "."]); git(localPath, ["commit", "-qm", "Initial"]);
  const project: Project = { id: "p", name: "p", repoUrl: "unused", localPath, defaultBranch: "main", status: "paused", createdAt: "", updatedAt: "" };
  const task = { id: "t", projectId: "p", branch: "orc/t", worktreePath: `${localPath}-wt-t` } as Task;
  git(localPath, ["worktree", "add", "-qb", task.branch!, task.worktreePath!]);
  return { root, project, task, service: new GitServiceImpl() };
}

test("VW08: real Git inventory, working-copy reads/diffs and ownership refusal preserve files", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.task.worktreePath!, "code.ts"), "export const answer = 2;\n");
    const snapshot = await f.service.inspectWorkspace(f.project, f.task);
    assert.equal(snapshot.dirty, true); assert.equal(snapshot.changedFiles, 1);
    assert.equal(snapshot.branch, "orc/t"); assert.equal(snapshot.headSha, snapshot.baseSha);
    assert.match((await f.service.inspectWorkspace(f.project, f.task, { path: "code.ts" })).contents!.content, /answer = 2/);
    assert.match((await f.service.inspectWorkspace(f.project, f.task, { path: "code.ts", diff: true })).diff!, /\+export const answer = 2/);
    await assert.rejects(f.service.inspectWorkspace(f.project, { ...f.task, projectId: "foreign" }), /owns/);
    await assert.rejects(f.service.inspectWorkspace(f.project, { ...f.task, worktreePath: f.project.localPath }), /owns/);
    await assert.rejects(f.service.inspectWorkspace(f.project, { ...f.task, branch: "other" }), /branch/);
    await assert.rejects(f.service.inspectWorkspace(f.project, f.task, { path: "../primary/code.ts" }), /inventory/);
    await assert.rejects(f.service.inspectWorkspace(f.project, f.task, { path: ".git" }), /inventory/);
    assert.equal(existsSync(f.task.worktreePath!), true);
    rmSync(f.task.worktreePath!, { recursive: true });
    await assert.rejects(f.service.inspectWorkspace(f.project, f.task));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("VW08: symlinks, shared files, binary/invalid text, oversized files and traversal fail closed", async () => {
  const f = fixture();
  const root = f.task.worktreePath!;
  try {
    writeFileSync(join(f.root, "private"), "not project data");
    symlinkSync(join(f.root, "private"), join(root, "escape"));
    symlinkSync(f.project.localPath, join(root, "linked-dir"));
    linkSync(join(f.root, "private"), join(root, "shared"));
    writeFileSync(join(root, "binary"), Buffer.from([0, 1]));
    writeFileSync(join(root, "invalid"), Buffer.from([255]));
    writeFileSync(join(root, "large"), "a".repeat(128 * 1024 + 1));
    for (const path of ["escape", "linked-dir/code.ts", "shared", "binary", "invalid", "large", "../private", ".git/config", "/etc/passwd"]) {
      assert.throws(() => readWorkspaceFile(root, path), path);
    }
    assert.throws(() => checkedWorkspaceFile(root, "./code.ts"));
    await assert.rejects(f.service.inspectWorkspace(f.project, f.task, { path: "escape", diff: true }), /Symlink/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("VW08: inspection never launches repository filters or fsmonitor commands", async () => {
  const f = fixture();
  try {
    const marker = join(f.root, "executed");
    const command = join(f.root, "filter.cjs");
    writeFileSync(command, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); process.stdout.write(require('node:fs').readFileSync(0));`);
    git(f.project.localPath, ["config", "filter.evil.clean", `node '${command}'`]);
    git(f.project.localPath, ["config", "filter.evil.required", "true"]);
    git(f.project.localPath, ["config", "core.fsmonitor", `node '${command}'`]);
    writeFileSync(join(f.task.worktreePath!, ".gitattributes"), "*.ts filter=evil\n");
    writeFileSync(join(f.task.worktreePath!, "code.ts"), "export const answer = 3;\n");
    await f.service.inspectWorkspace(f.project, f.task, { path: "code.ts", diff: true });
    assert.equal(existsSync(marker), false, "read-only browsing must not execute repository-configured commands");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
