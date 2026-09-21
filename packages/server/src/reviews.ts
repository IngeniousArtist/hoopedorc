import { fork, type ChildProcess } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { GitServiceImpl, retainWorkspace, taskRunId } from "@orc/engine";
import type { CaptureReviewRequest, Project, ReviewArtifact, ReviewEvidence, Task, TaskReviewResponse, UploadReviewEvidenceRequest, WorkspaceSummary } from "@orc/types";
import type { Db } from "./db/index";
import * as repo from "./db/repo";
import { processGroupExists, type PreviewManager } from "./previews";
import { evidenceFreshness, ReviewError } from "./review-policy";
import { reviewRequestHash, ReviewStore } from "./review-store";

interface LiveReview {
  value: ReviewEvidence; worker?: ChildProcess; finished: Promise<void>; cancelled: boolean;
  release: () => void; browserPid?: number;
}

export class ReviewManager {
  readonly store: ReviewStore;
  private readonly live = new Map<string, LiveReview>();
  private readonly recovering = new Map<string, { pid: number; projectId: string; taskId: string; release: () => void }>();
  private readonly timer: ReturnType<typeof setInterval>;
  private closing = false;
  constructor(private readonly db: Db, private readonly previews: PreviewManager, private readonly mock: boolean) {
    this.store = new ReviewStore(db);
    for (const row of db.prepare("SELECT id, project_id, task_id, browser_pid, workspace_path FROM review_evidence WHERE state IN ('running', 'interrupted') AND browser_pid IS NOT NULL").all() as { id: string; project_id: string; task_id: string; browser_pid: number; workspace_path: string | null }[]) {
      if (!mock && processGroupExists(row.browser_pid)) this.recovering.set(row.id, { pid: row.browser_pid, projectId: row.project_id, taskId: row.task_id, release: row.workspace_path ? retainWorkspace(row.workspace_path) : () => {} });
      else db.prepare("UPDATE review_evidence SET browser_pid = NULL WHERE id = ?").run(row.id);
    }
    this.store.recover();
    this.timer = setInterval(() => { this.reconcile(); this.store.prune(); }, 1000 * 60); this.timer.unref();
  }
  private reconcile() {
    for (const [id, item] of this.recovering) if (!processGroupExists(item.pid)) {
      this.db.prepare("UPDATE review_evidence SET browser_pid = NULL WHERE id = ?").run(id); item.release(); this.recovering.delete(id);
    }
  }
  hasActivity(projectId: string): boolean {
    this.reconcile();
    return [...this.live.values()].some((item) => item.value.projectId === projectId) || [...this.recovering.values()].some((item) => item.projectId === projectId);
  }
  private assertCapacity(taskId: string): void {
    this.reconcile();
    if ([...this.recovering.values()].some((item) => item.taskId === taskId)) throw new ReviewError("This task's previous browser process is still settling. Retry after it stops.");
    if (this.live.size + this.recovering.size >= 2) throw new ReviewError("Two browser checks are already active or settling. Wait or cancel one first.");
  }
  capability(): TaskReviewResponse["browser"] {
    if (repo.getSettings(this.db)?.sandboxGates === "required") return { available: false, reason: "Sandboxing is required. Native browser checks are unavailable; no fallback is performed." };
    if (this.mock) return { available: true };
    if (!["linux", "darwin"].includes(process.platform)) return { available: false, reason: "Managed browser checks currently require Linux or macOS." };
    try { accessSync(chromium.executablePath(), constants.X_OK); return { available: true }; }
    catch { return { available: false, reason: "Chromium is unavailable for the server user. Install it with npx playwright install chromium (Linux also needs its OS dependencies)." }; }
  }
  async workspace(project: Project, task: Task): Promise<WorkspaceSummary> {
    const base: WorkspaceSummary = { id: task.id, taskId: task.id, projectId: project.id, title: task.title, state: "unavailable", branch: task.branch, taskStatus: task.status, worker: task.assignedModel };
    if (this.mock) return { ...base, state: "available", branch: task.branch ?? `orc/${task.id}`, headSha: "d".repeat(40), dirty: true, changedFiles: 1 };
    try {
      const snapshot = await new GitServiceImpl().inspectWorkspace(project, task);
      return { ...base, state: "available", headSha: snapshot.headSha, dirty: snapshot.dirty, branch: snapshot.branch, baseSha: snapshot.baseSha, changedFiles: snapshot.changedFiles };
    } catch (error) { return { ...base, reason: error instanceof Error ? error.message : "Workspace cannot be inspected." }; }
  }
  async context(project: Project, task: Task): Promise<TaskReviewResponse> {
    const workspace = await this.workspace(project, task);
    const current = repo.getTask(this.db, task.id);
    if (!current || current.projectId !== project.id) throw new ReviewError("Task no longer belongs to this project.", 404);
    if (repo.getProject(this.db, project.id)?.localPath !== project.localPath || current.worktreePath !== task.worktreePath || current.branch !== task.branch) { workspace.state = "unavailable"; workspace.reason = "Workspace changed while it was inspected. Refresh review."; }
    const preview = this.previews.latest(project.id, task.id);
    const listed = this.store.list(project.id, task.id);
    return { output: project.config?.environment?.output ?? "web", task: current, runs: repo.getRuns(this.db, task.id), decisions: repo.getMergeDecisions(this.db, task.id), workspace, preview, browser: this.capability(),
      ...listed, evidence: listed.evidence.map((item) => ({ ...item, ...evidenceFreshness(item, current, workspace, preview) })) };
  }
  private value(id: string, project: Project, task: Task, workspace: WorkspaceSummary, source: ReviewEvidence["source"]): ReviewEvidence {
    const run = repo.getRun(this.db, taskRunId(task));
    return { id, projectId: project.id, taskId: task.id, runId: run?.id, attempt: task.attempts, runGeneration: task.runGeneration,
      headSha: workspace.headSha, dirty: workspace.dirty ?? true, environment: this.mock ? "Mock browser fixture; no browser launched" : "Native host · isolated browser context",
      source, state: source === "upload" ? "supplied" : "running", detail: source === "upload" ? "Operator-supplied evidence." : "Starting a supervised browser check…",
      startedAt: new Date().toISOString(), freshness: "unverified", artifacts: [] };
  }
  private currentTask(project: Project, task: Task, expected: string) {
    if (this.closing) throw new ReviewError("Server is shutting down.", 503);
    const current = repo.getTask(this.db, task.id);
    if (!current || current.projectId !== task.projectId) throw new ReviewError("Task not found.", 404);
    if (repo.getProject(this.db, project.id)?.localPath !== project.localPath) throw new ReviewError("Project workspace changed. Refresh before creating evidence.");
    if (current.updatedAt !== expected) throw new ReviewError("Task changed. Refresh and review before creating evidence.");
  }
  async upload(project: Project, task: Task, request: UploadReviewEvidenceRequest, bytes: Buffer): Promise<ReviewEvidence> {
    const hash = reviewRequestHash(request);
    const existing = this.store.existing(request.requestId, project.id, task.id, hash); if (existing) return existing;
    const workspace = await this.workspace(project, task); this.currentTask(project, task, request.taskUpdatedAt);
    const repeated = this.store.existing(request.requestId, project.id, task.id, hash); if (repeated) return repeated;
    const value = this.value(request.requestId, project, task, workspace, "upload");
    value.detail = request.description; value.endedAt = value.startedAt; value.environment = "Operator-supplied artifact; execution environment unverified";
    this.db.transaction(() => { this.store.create(value, hash); this.store.addArtifact(value, request.kind, request.name, bytes); })();
    return this.store.get(value.id)!;
  }
  async capture(project: Project, task: Task, request: CaptureReviewRequest): Promise<ReviewEvidence> {
    const hash = reviewRequestHash(request);
    const existing = this.store.existing(request.requestId, project.id, task.id, hash); if (existing) return existing;
    this.assertCapacity(task.id);
    const capability = this.capability(); if (!capability.available) throw new ReviewError(capability.reason!, 503);
    const workspace = await this.workspace(project, task); this.currentTask(project, task, request.taskUpdatedAt);
    const repeated = this.store.existing(request.requestId, project.id, task.id, hash); if (repeated) return repeated;
    if (workspace.state !== "available") throw new ReviewError(workspace.reason ?? "Task workspace is unavailable.");
    const preview = this.previews.latest(project.id, task.id);
    if (!preview || preview.id !== request.previewId || preview.state !== "ready") throw new ReviewError("The reviewed preview changed or is not ready. Refresh and start a preview first.");
    this.assertCapacity(task.id);
    const value = this.value(request.requestId, project, task, workspace, "browser");
    value.previewId = preview.id; value.previewProfile = preview.profile;
    value.testedPath = request.path; value.testedUrl = new URL(request.path, preview.publicOrigin).href;
    value.viewport = request.viewport; value.steps = request.steps;
    this.store.create(value, hash);
    this.db.prepare("UPDATE review_evidence SET workspace_path = ? WHERE id = ?").run(task.worktreePath ?? null, value.id);
    const run: LiveReview = { value, release: !this.mock && task.worktreePath ? retainWorkspace(task.worktreePath) : () => {}, cancelled: false, finished: Promise.resolve() };
    this.live.set(value.id, run); run.finished = this.execute(run, project, task, request);
    return value;
  }
  private async execute(run: LiveReview, project: Project, task: Task, request: CaptureReviewRequest): Promise<void> {
    let directory: string | undefined; let closed: Promise<void> | undefined; let timeout: ReturnType<typeof setTimeout> | undefined;
    let received = false; let storageFailure: Error | undefined;
    try {
      if (this.mock) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        if (!run.cancelled) {
          this.store.addArtifact(run.value, "text", "mock-check.txt", Buffer.from("Mock browser evidence. No browser, host command or model was used."));
          run.value.state = "passed"; run.value.detail = "Mock browser check completed. No real application was verified.";
        }
        received = true; return;
      }
      directory = mkdtempSync(join(tmpdir(), "hoop-review-"));
      const env = { PATH: process.env.PATH, LANG: process.env.LANG ?? "C.UTF-8", HOME: directory, TMPDIR: directory };
      const worker = fork(fileURLToPath(new URL("./review-worker.mjs", import.meta.url)), [], { env, execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
      run.worker = worker;
      closed = new Promise<void>((resolve) => worker.once("close", () => resolve()));
      worker.once("error", (error) => { storageFailure = error; });
      worker.on("message", (raw: unknown) => {
        const message = raw as { type?: string; pid?: number; kind?: ReviewArtifact["kind"]; name?: string; content?: string; state?: "passed" | "failed" | "cancelled"; detail?: string };
        try {
          if (message.type === "browser" && typeof message.pid === "number") {
            run.browserPid = message.pid; this.db.prepare("UPDATE review_evidence SET browser_pid = ? WHERE id = ?").run(message.pid, run.value.id);
          } else if (message.type === "artifact" && message.kind && message.name && typeof message.content === "string") {
            this.store.addArtifact(run.value, message.kind, message.name, Buffer.from(message.content, "base64"));
          } else if (message.type === "result" && message.state && ["passed", "failed", "cancelled"].includes(message.state)) {
            received = true; run.value.state = message.state; run.value.detail = (message.detail ?? "Browser check ended.").slice(0, 20_000);
          }
        } catch (error) {
          storageFailure = error instanceof Error ? error : new Error(String(error));
          if (worker.connected) worker.send({ type: "stop" }, () => {});
        }
      });
      const launch = this.previews.open(project.id, task.id);
      worker.send({ type: "start", ...request, directory, env, executablePath: chromium.executablePath(), launchUrl: launch.url });
      if (run.cancelled && worker.connected) worker.send({ type: "stop" }, () => {});
      timeout = setTimeout(() => {
        storageFailure ??= new Error("Browser supervisor exceeded its 75-second deadline.");
        if (worker.connected) worker.send({ type: "stop" }, () => {});
      }, 75_000);
      await closed;
      if (storageFailure) throw storageFailure;
      if (!received) throw new Error("Browser supervisor exited without a result. Available artifacts were retained.");
      const after = await this.workspace(project, task);
      if (after.state !== "available" || after.headSha !== run.value.headSha || after.dirty) run.value.dirty = true;
    } catch (error) { run.value.state = "failed"; run.value.detail = error instanceof Error ? error.message : "Browser check failed."; }
    finally {
      if (timeout) clearTimeout(timeout);
      if (run.worker?.connected) run.worker.send({ type: "stop" }, () => {});
      await closed;
      const orphaned = !!run.browserPid && processGroupExists(run.browserPid);
      if (orphaned) {
        run.value.state = "interrupted"; run.value.detail = "Browser process is still settling. Evidence and workspace are retained; no unverified process will be killed.";
        this.recovering.set(run.value.id, { pid: run.browserPid!, release: run.release, projectId: project.id, taskId: task.id });
      } else {
        if (run.cancelled) { run.value.state = "cancelled"; run.value.detail = "Browser check cancelled. Available artifacts were retained."; }
        run.release(); if (directory) rmSync(directory, { recursive: true, force: true });
        this.db.prepare("UPDATE review_evidence SET browser_pid = NULL WHERE id = ?").run(run.value.id);
      }
      run.value.endedAt = new Date().toISOString(); this.store.update(run.value); this.live.delete(run.value.id);
    }
  }
  async cancel(projectId: string, taskId: string, evidenceId: string): Promise<ReviewEvidence> {
    const value = this.store.get(evidenceId);
    if (!value || value.projectId !== projectId || value.taskId !== taskId) throw new ReviewError("Review evidence not found for this task.", 404);
    const run = this.live.get(evidenceId);
    if (run) { run.cancelled = true; if (run.worker?.connected) run.worker.send({ type: "stop" }, () => {}); await run.finished; }
    if (this.recovering.has(evidenceId)) throw new ReviewError("This browser process is still settling after interruption. No unverified process was killed.");
    return this.store.get(evidenceId)!;
  }
  async close(): Promise<void> {
    this.closing = true; clearInterval(this.timer);
    const results = await Promise.allSettled([...this.live.values()].map((run) => this.cancel(run.value.projectId, run.value.taskId, run.value.id)));
    this.reconcile();
    const unsettled = this.recovering.size;
    for (const item of this.recovering.values()) item.release(); this.recovering.clear();
    const errors = results.filter((item) => item.status === "rejected").map((item) => item.reason as unknown);
    if (unsettled) errors.push(new Error(`${unsettled} interrupted browser process groups remain unverified; their records are preserved.`));
    if (errors.length) throw new AggregateError(errors, "Some browser checks did not settle during shutdown.");
  }
}
