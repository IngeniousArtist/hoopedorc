import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { test } from "node:test";
import Fastify from "fastify";
import type { ReviewEvidence, TaskReviewResponse } from "@orc/types";
import { defaultSettings } from "./config";
import { initDb } from "./db/index";
import * as repo from "./db/repo";
import { PreviewManager } from "./previews";
import { ReviewManager } from "./reviews";
import { registerReviewRoutes } from "./review-routes";
import { evidenceFreshness, parseCaptureRequest, parseUploadRequest, RETENTION_MS } from "./review-policy";

function fixture() {
  const db = initDb(":memory:"); repo.upsertSettings(db, defaultSettings());
  const project = repo.createProject(db, { id: "p", name: "Review", repoUrl: "unused", localPath: "/never-read-for-mock-review", defaultBranch: "main", status: "paused" });
  const task = repo.createTask(db, { id: "t", projectId: "p", title: "Review", description: "", difficulty: "easy", assignedModel: "codex", status: "in_review", acceptanceCriteria: [], dependsOn: [], scopePaths: [], attempts: 1, maxAttempts: 3 });
  const previews = new PreviewManager(db, [{ port: 4318, origin: "http://127.0.0.1:4318" }], true);
  const reviews = new ReviewManager(db, previews, true);
  return { db, project, task, previews, reviews };
}
const upload = (version: string) => ({ requestId: randomUUID(), taskUpdatedAt: version, kind: "text", name: "diagnostics.txt", description: "Native build diagnostics", contentBase64: Buffer.from("Build passed\n").toString("base64") });

test("VW10: review policy rejects arbitrary browser destinations/scripts and unsafe or oversized artifacts", () => {
  const base = { requestId: randomUUID(), taskUpdatedAt: "v1", previewId: "preview", path: "/", viewport: { width: 390, height: 844 }, steps: [] };
  assert.equal(parseCaptureRequest(base).viewport.width, 390);
  for (const path of ["https://example.com", "//169.254.169.254", "/\\localhost", "/__hoop_session/secret"]) assert.throws(() => parseCaptureRequest({ ...base, path }));
  assert.throws(() => parseCaptureRequest({ ...base, url: "http://metadata" }));
  assert.throws(() => parseCaptureRequest({ ...base, steps: [{ action: "evaluate", target: "process.env" }] }));
  assert.throws(() => parseCaptureRequest({ ...base, viewport: { width: 999999, height: 844 } }));
  const valid = upload("v1"); assert.equal(parseUploadRequest(valid).bytes.toString(), "Build passed\n");
  for (const name of ["../secret.txt", "nested/file.txt", "a\".txt"]) assert.throws(() => parseUploadRequest({ ...valid, name }));
  assert.throws(() => parseUploadRequest({ ...valid, contentBase64: "not base64" }));
  assert.throws(() => parseUploadRequest({ ...valid, kind: "screenshot", name: "fake.png" }));
  assert.throws(() => parseUploadRequest({ ...valid, contentBase64: Buffer.alloc(256 * 1024 + 1).toString("base64") }));
});

test("VW10: supplied artifacts are idempotent, task-scoped, unverified and expire without losing their record", async () => {
  const f = fixture();
  try {
    const parsed = parseUploadRequest(upload(f.task.updatedAt));
    const first = await f.reviews.upload(f.project, f.task, parsed.request, parsed.bytes);
    const repeated = await f.reviews.upload(f.project, f.task, parsed.request, parsed.bytes);
    assert.equal(repeated.id, first.id); assert.equal(repeated.artifacts.length, 1);
    await assert.rejects(f.reviews.upload(f.project, f.task, { ...parsed.request, description: "Different request" }, parsed.bytes), /different review request/);
    const context = await f.reviews.context(f.project, f.task);
    assert.equal(context.evidence[0]?.freshness, "unverified");
    assert.throws(() => f.reviews.store.artifact("other", "t", first.artifacts[0]!.id), /not found/);
    assert.equal(f.reviews.store.artifact("p", "t", first.artifacts[0]!.id).bytes.toString(), "Build passed\n");
    f.reviews.store.prune(new Date(Date.now() + RETENTION_MS + 1));
    assert.equal(f.reviews.store.get(first.id)?.artifacts[0]?.available, false);
    assert.throws(() => f.reviews.store.artifact("p", "t", first.artifacts[0]!.id), /expired/);
    assert.equal(f.reviews.store.get(first.id)?.detail, "Native build diagnostics");
    repo.createRun(f.db, { id: "run-t-1", projectId: "p", taskId: "t", model: "codex", attempt: 1, status: "passed", startedAt: "2026-01-01", costUsd: 0, tokensIn: 0, tokensOut: 0 });
    const next = repo.updateTask(f.db, "t", { runGeneration: 1 })!;
    const supplied = parseUploadRequest(upload(next.updatedAt));
    const nextEvidence = await f.reviews.upload(f.project, next, supplied.request, supplied.bytes);
    assert.equal(nextEvidence.runId, undefined, "an old generation's attempt 1 cannot identify a new generation's attempt 1");
    const racedRequest = parseUploadRequest(upload(next.updatedAt));
    const raced = f.reviews.upload(f.project, next, racedRequest.request, racedRequest.bytes);
    repo.updateProject(f.db, "p", { localPath: "/changed-during-inspection" });
    await assert.rejects(raced, /Project workspace changed/);
  } finally { await f.reviews.close(); await f.previews.close(); f.db.close(); }
});

test("VW10: mock capture has one owner, cancellation is idempotent and restart preserves interrupted evidence", async () => {
  const f = fixture();
  try {
    const preview = f.previews.start(f.project, f.task, { command: "never-execute", args: [], readinessPath: "/", startupTimeoutSeconds: 5 });
    await new Promise((resolve) => setTimeout(resolve, 180));
    const input = { requestId: randomUUID(), taskUpdatedAt: f.task.updatedAt, previewId: preview.id, path: "/", viewport: { width: 390, height: 844 }, steps: [] };
    const first = await f.reviews.capture(f.project, f.task, input);
    assert.equal((await f.reviews.capture(f.project, f.task, input)).id, first.id);
    await assert.rejects(f.reviews.capture(f.project, f.task, { ...input, requestId: randomUUID() }), /already running/);
    assert.equal((await f.reviews.cancel("p", "t", first.id)).state, "cancelled");
    assert.equal((await f.reviews.cancel("p", "t", first.id)).state, "cancelled");
    await f.reviews.close();
    const interrupted: ReviewEvidence = { ...first, id: randomUUID(), state: "running", artifacts: [] };
    f.reviews.store.create(interrupted, "interrupted-request");
    f.reviews.store.addArtifact(interrupted, "text", "failure.txt", Buffer.from("Partial failure evidence"));
    const recovered = new ReviewManager(f.db, f.previews, true);
    try { assert.equal(recovered.store.get(interrupted.id)?.state, "interrupted"); assert.equal(recovered.store.get(interrupted.id)?.artifacts.length, 1); }
    finally { await recovered.close(); }
    const workspace = { id: "t", projectId: "p", title: "Task", state: "available" as const, headSha: "a".repeat(40), dirty: false };
    const completed = { ...first, state: "passed" as const, headSha: workspace.headSha, dirty: false };
    assert.equal(evidenceFreshness(completed, f.task, workspace, { ...preview, state: "ready", headSha: workspace.headSha }).freshness, "current");
    assert.equal(evidenceFreshness(completed, { ...f.task, attempts: 2 }, workspace, preview).freshness, "stale");
    assert.equal(evidenceFreshness(completed, f.task, { ...workspace, dirty: true }, preview).freshness, "unverified");
    assert.equal(evidenceFreshness(completed, f.task, { ...workspace, state: "unavailable" }, preview).freshness, "unavailable");
  } finally { await f.reviews.close(); await f.previews.close(); f.db.close(); }
});

test("VW10: review routes bind artifacts to their project/task and preserve existing gates", async () => {
  const f = fixture(); const app = Fastify(); registerReviewRoutes(app, f.db, f.reviews);
  try {
    const url = "/api/projects/p/tasks/t/review";
    assert.equal((await app.inject("/api/projects/other/tasks/t/review")).statusCode, 404);
    const before = (await app.inject(url)).json<TaskReviewResponse>(); assert.equal(before.evidence.length, 0);
    const supplied = await app.inject({ method: "POST", url: `${url}/evidence`, payload: upload(f.task.updatedAt) });
    assert.equal(supplied.statusCode, 200);
    const evidence = supplied.json<{ evidence: ReviewEvidence }>().evidence;
    const artifact = await app.inject(`${url}/artifacts/${evidence.artifacts[0]!.id}`);
    assert.equal(artifact.statusCode, 200); assert.match(artifact.headers["content-disposition"] as string, /attachment/);
    assert.equal(artifact.headers["x-content-type-options"], "nosniff");
    assert.equal((await app.inject(`/api/projects/other/tasks/t/review/artifacts/${evidence.artifacts[0]!.id}`)).statusCode, 404);
    assert.equal(repo.getTask(f.db, "t")?.status, "in_review"); assert.equal(repo.getMergeDecisions(f.db, "t").length, 0);
  } finally { await app.close(); await f.reviews.close(); await f.previews.close(); f.db.close(); }
});

test("VW10: recovery refuses a competing capture while an unverified old process group exists", async () => {
  const f = fixture(); await f.reviews.close();
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  const id = randomUUID();
  const old: ReviewEvidence = { id, projectId: "p", taskId: "t", attempt: 1, runGeneration: 0, dirty: false, source: "browser", state: "running", detail: "old capture", environment: "host", startedAt: new Date().toISOString(), freshness: "unverified", artifacts: [] };
  f.reviews.store.create(old, "old-request");
  f.db.prepare("UPDATE review_evidence SET browser_pid = ? WHERE id = ?").run(child.pid!, id);
  const recovered = new ReviewManager(f.db, f.previews, false);
  try {
    assert.equal(recovered.store.get(id)?.state, "interrupted");
    await assert.rejects(recovered.capture(f.project, f.task, { requestId: randomUUID(), taskUpdatedAt: f.task.updatedAt, previewId: "unused", path: "/", viewport: { width: 390, height: 844 }, steps: [] }), /previous browser process is still settling/);
    assert.equal(child.exitCode, null, "recovery does not kill an unverified recorded PID");
    child.kill("SIGTERM"); await closed;
    assert.equal(recovered.hasActivity("p"), false);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await closed; await recovered.close(); await f.previews.close(); f.db.close(); }
});

test("VW16: mock-safe review context exposes the project's artifact output preference", async () => {
  const f = fixture();
  try {
    f.project.config = { environment: { runtime: "python3", platform: "any", output: "artifacts", setupInputs: [], setupOutputs: [] } };
    assert.equal((await f.reviews.context(f.project, f.task)).output, "artifacts");
  } finally { await f.reviews.close(); await f.previews.close(); f.db.close(); }
});
