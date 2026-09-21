import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Fastify from "fastify";
import type { LibraryReference, ReferenceInput } from "@orc/types";
import { initDb } from "./db/index";
import * as repo from "./db/repo";
import { LibraryStore, libraryToken, parseLibrarySave, parseLibrarySelection, selectedLibraryReferences } from "./library";
import { importProjectLibrary } from "./library-import";
import { registerLibraryRoutes } from "./library-routes";

function fixture(localPath = "/mock-library-never-read") {
  const db = initDb(":memory:");
  const project = repo.createProject(db, { id: "p", name: "Library", repoUrl: "unused", localPath, defaultBranch: "main", status: "paused" });
  return { db, project, store: new LibraryStore(db) };
}
const input = (content = "Use existing buttons.", conflictGroup = ""): ReferenceInput => ({ title: "Design rules", kind: "design", source: { type: "text", locator: "" }, applicability: "UI tasks", conflictGroup, content, archived: false });
const request = (reference = input(), expectedRevision = 0) => ({ requestId: randomUUID(), expectedRevision, reference });

test("VW11: edits are revision-bound and idempotent; history, archive and task usage survive restart", () => {
  const f = fixture();
  try {
    const body = request(); const first = f.store.save("p", "design", body);
    assert.deepEqual(f.store.save("p", "design", body), first);
    assert.throws(() => f.store.save("p", "design", { ...body, reference: input("changed") }), /another reference edit/);
    assert.throws(() => f.store.save("p", "design", request(input("stale"))), /changed in another session/);
    const second = f.store.save("p", "design", request(input("Use the new buttons."), 1));
    assert.equal(second.revision, 2); assert.equal(f.store.version("p", "design", 1)?.content, first.content);
    f.store.save("p", "design", request({ ...input(), archived: true }, 2));
    assert.throws(() => f.store.handoff("p", [first]), /archived/);
    const reopened = new LibraryStore(f.db);
    assert.match(reopened.context("p", libraryToken(first)), /Use existing buttons/);
    assert.doesNotMatch(reopened.context("p", libraryToken(first)), /new buttons/);
    repo.createTask(f.db, { id: "t", projectId: "p", title: "Pinned task", description: libraryToken(first), difficulty: "easy", assignedModel: "codex", status: "ready", acceptanceCriteria: [], dependsOn: [], scopePaths: [], attempts: 0, maxAttempts: 3 });
    assert.deepEqual(reopened.list("p")[0]?.referencedByTasks, [{ id: "t", title: "Pinned task", revisions: [1] }]);
    assert.equal(reopened.detail("p", "design").versions.length, 3);
    assert.equal(Object.hasOwn(reopened.list("p")[0]!, "content"), false);
    assert.equal(reopened.version("other", "design"), null);
  } finally { f.db.close(); }
});

test("VW11: unselected references stay absent; conflicting or missing selections fail before use", () => {
  const f = fixture();
  try {
    const first = f.store.save("p", "a", request(input("A buttons", "design-system")));
    const other = f.store.save("p", "b", request(input("B buttons", "design-system")));
    f.store.save("p", "unused", request(input("Never inject this")));
    assert.equal(f.store.context("p", "ordinary task"), "");
    assert.doesNotMatch(f.store.handoff("p", [first]), /Never inject|B buttons/);
    assert.throws(() => f.store.handoff("p", [first, other]), /Conflicting sources/);
    assert.match(f.store.checkTask("p", `${libraryToken(first)} ${libraryToken(other)}`)!, /Conflicting sources/);
    f.store.save("p", "a", request(input("A2"), 1));
    assert.throws(() => f.store.resolve("p", [first, { id: "a", revision: 2 }]), /Conflicting revisions/);
    assert.match(f.store.checkTask("p", "hoop-reference:missing@1")!, /unavailable/);
    assert.match(f.store.checkTask("p", "hoop-reference:bad@0")!, /malformed/);
    assert.deepEqual(selectedLibraryReferences(`${libraryToken(first)} ${libraryToken(first)}`), [{ id: "a", revision: 1 }]);
    assert.equal(f.store.list("p").find((entry) => entry.id === "b")?.conflictsWith.length, 0, "latest revisions determine library alternative warnings");
  } finally { f.db.close(); }
});

test("VW11: invalid sources and payload bounds are refused", () => {
  for (const locator of ["javascript:alert(1)", "file:///etc/passwd", "https://user:password@example.com/"]) assert.throws(() => parseLibrarySave(request({ ...input(), source: { type: "url", locator } })));
  assert.throws(() => parseLibrarySave(request({ ...input(), source: { type: "repository", locator: "../secrets" } })));
  assert.throws(() => parseLibrarySave(request(input("界".repeat(20_000)))));
  assert.throws(() => parseLibrarySave({ ...request(), expectedRevision: -1 }));
  assert.throws(() => parseLibrarySelection({ references: [] }));
  assert.throws(() => parseLibrarySelection({ references: [{ id: "a", revision: 0 }] }));
});

test("VW11: real Git legacy import preserves files and task Markdown, rejects symlinks and creates only changed revisions", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoop-library-")); const f = fixture(root);
  try {
    execFileSync("git", ["init", "-b", "main", root], { stdio: "ignore" });
    writeFileSync(join(root, "DESIGN.md"), "# Design\nUse components.\n");
    mkdirSync(join(root, "context", "attachments"), { recursive: true });
    writeFileSync(join(root, "context", "attachments", "reference.md"), "Original attachment");
    writeFileSync(join(root, "context", "attachments", "large.md"), "x".repeat(40_000));
    writeFileSync(join(root, "outside.txt"), "Do not ingest symlink contents"); symlinkSync(join(root, "outside.txt"), join(root, "AGENTS.md"));
    const description = "Do work.\n### Relevant references\n- old/design.md\n### Required skills/capabilities\n- existing skill — inspect when needed\n### Other\nNot a reference";
    repo.createTask(f.db, { id: "old-task", projectId: "p", title: "Old task", description, difficulty: "easy", assignedModel: "codex", status: "done", acceptanceCriteria: [], dependsOn: [], scopePaths: [], attempts: 1, maxAttempts: 3 });
    const first = await importProjectLibrary(f.db, f.project, false);
    assert.equal(first.imported, 3); assert.ok(first.issues.some((issue) => /Symlink/.test(issue))); assert.ok(first.issues.some((issue) => /32/.test(issue)));
    assert.equal(repo.getTask(f.db, "old-task")?.description, description);
    assert.equal(readFileSync(join(root, "DESIGN.md"), "utf8"), "# Design\nUse components.\n");
    assert.equal((await importProjectLibrary(f.db, f.project, false)).imported, 0);
    writeFileSync(join(root, "DESIGN.md"), "# Design\nUse revised components.\n");
    assert.equal((await importProjectLibrary(f.db, f.project, false)).imported, 1);
    const design = f.store.list("p").find((entry) => entry.title === "DESIGN.md")!;
    assert.equal(design.revision, 2); assert.equal(f.store.detail("p", design.id).versions[1]?.content, "# Design\nUse components.\n");
    repo.deleteProject(f.db, "p"); assert.equal(f.store.list("p").length, 0);
  } finally { f.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("VW11: routes scope references to projects and mock import never reads the host", async () => {
  const f = fixture(); const app = Fastify(); registerLibraryRoutes(app, f.db, true);
  try {
    assert.equal((await app.inject("/api/projects/other/library")).statusCode, 404);
    const saved = await app.inject({ method: "PUT", url: "/api/projects/p/library/a", payload: request() });
    assert.equal(saved.statusCode, 200);
    const reference = saved.json<{ reference: LibraryReference }>().reference;
    const handoff = await app.inject({ method: "POST", url: "/api/projects/p/library/handoff", payload: { references: [reference] } });
    assert.equal(handoff.statusCode, 200); assert.match(handoff.json<{ markdown: string }>().markdown, /hoop-reference:a@1/);
    assert.equal((await app.inject("/api/projects/other/library/a")).statusCode, 404);
    const imported = await app.inject({ method: "POST", url: "/api/projects/p/library/import", payload: {} });
    assert.equal(imported.statusCode, 200); assert.equal(imported.json<{ imported: number }>().imported, 1);
  } finally { await app.close(); f.db.close(); }
});
