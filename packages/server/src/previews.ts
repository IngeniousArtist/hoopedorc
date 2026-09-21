import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { abortableDelay, execManagedProcess, ManagedProcessError } from "@orc/adapters";
import { GitServiceImpl, retainWorkspace } from "@orc/engine";
import type { PreviewProfile, Project, Task, WorkspacePreview } from "@orc/types";
import type { Db } from "./db/index";
import * as repo from "./db/repo";
import { PreviewGateway } from "./preview-gateway";
import { parsePreviewProfile, type PreviewSlot } from "./preview-policy";

export class PreviewError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}
interface PreviewRow { id: string; child_pid: number | null; workspace_path: string; preview_json: string }
interface LivePreview {
  value: WorkspacePreview; controller: AbortController; finished: Promise<void>;
  release: () => void; worker?: ChildProcess; workerClosed?: Promise<void>; childPid?: number;
  gateway?: PreviewGateway; stopRequested: boolean; home?: string;
}
const activeStates = new Set(["starting", "ready", "stopping"]);
const asError = (error: unknown) => error instanceof Error ? error : new Error(String(error));
export function processGroupExists(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a preview port.");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}
export async function previewOwnsPort(port: number, group: number): Promise<boolean> {
  let output: string;
  try { output = (await execManagedProcess("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], { timeoutMs: 2000, maxOutputBytes: 16_384 })).stdout; }
  catch (error) { if (error instanceof ManagedProcessError && error.code === 1) return false; throw new PreviewError("Cannot verify preview port ownership. Install lsof and ps on this host."); }
  const pids = [...new Set(output.split("\n").filter((line) => /^p\d+$/.test(line)).map((line) => Number(line.slice(1))))];
  if (!pids.length) return false;
  for (const pid of pids) {
    const pgid = Number((await execManagedProcess("ps", ["-o", "pgid=", "-p", String(pid)], { timeoutMs: 2000, maxOutputBytes: 4096 })).stdout.trim());
    if (pgid !== group) throw new PreviewError("The preview port belongs to another process. Stop the conflicting service and retry.");
  }
  return true;
}

export class PreviewManager {
  private readonly live = new Map<string, LivePreview>();
  private readonly recovering = new Map<string, { pid: number; release: () => void; projectId: string }>();
  private closing = false;
  private readonly recoveryTimer: ReturnType<typeof setInterval>;
  constructor(private readonly db: Db, readonly slots: PreviewSlot[], private readonly mock = false) {
    for (const row of db.prepare("SELECT * FROM workspace_previews WHERE state IN ('starting', 'ready', 'stopping', 'interrupted')").all() as PreviewRow[]) {
      const value = JSON.parse(row.preview_json) as WorkspacePreview;
      value.state = "interrupted"; value.detail = "Server restarted. Preview access was revoked; retry after the old process settles.";
      this.persist(value);
      if (!mock && row.child_pid && processGroupExists(row.child_pid)) {
        this.recovering.set(row.id, { pid: row.child_pid, release: retainWorkspace(row.workspace_path), projectId: value.projectId });
      } else db.prepare("UPDATE workspace_previews SET child_pid = NULL WHERE id = ?").run(row.id);
    }
    this.recoveryTimer = setInterval(() => this.reconcile(), 1000); this.recoveryTimer.unref();
  }
  private reconcile(): void {
    for (const [id, orphan] of this.recovering) if (!processGroupExists(orphan.pid)) {
      this.db.prepare("UPDATE workspace_previews SET child_pid = NULL WHERE id = ?").run(id);
      orphan.release(); this.recovering.delete(id);
    }
  }
  latest(projectId: string, taskId: string): WorkspacePreview | null {
    const row = this.db.prepare("SELECT preview_json FROM workspace_previews WHERE project_id = ? AND task_id = ? ORDER BY rowid DESC LIMIT 1").get(projectId, taskId) as { preview_json: string } | undefined;
    return row ? JSON.parse(row.preview_json) as WorkspacePreview : null;
  }
  hasActivity(projectId: string): boolean {
    this.reconcile();
    return [...this.live.values()].some((run) => run.value.projectId === projectId) || [...this.recovering.values()].some((run) => run.projectId === projectId);
  }
  private persist(value: WorkspacePreview): void {
    value.updatedAt = new Date().toISOString();
    this.db.prepare("UPDATE workspace_previews SET state = ?, preview_json = ? WHERE id = ?").run(value.state, JSON.stringify(value), value.id);
  }
  start(project: Project, task: Task, profile: PreviewProfile): WorkspacePreview {
    if (this.closing) throw new PreviewError("Server is shutting down.", 503);
    if (task.projectId !== project.id) throw new PreviewError("Task does not belong to this project.", 404);
    if (!this.mock && (!task.worktreePath || !task.branch)) throw new PreviewError("Start this task through the board first; it has no workspace to preview.");
    if (!this.mock && !["linux", "darwin"].includes(process.platform)) throw new PreviewError("Native previews currently require Linux or macOS with lsof and ps.");
    if (repo.getSettings(this.db)?.sandboxGates === "required") throw new PreviewError("This project requires sandboxing. Native host previews are unavailable; no fallback is performed.");
    const parsed = parsePreviewProfile(profile); if ("error" in parsed) throw new PreviewError(parsed.error, 400);
    this.reconcile();
    const existing = this.latest(project.id, task.id);
    if (existing && activeStates.has(existing.state)) return existing;
    if (existing && this.recovering.has(existing.id)) throw new PreviewError("The previous preview process is still settling. Retry shortly; no unverified process will be killed.");
    const value = this.db.transaction(() => {
      const ports = new Set((this.db.prepare("SELECT proxy_port FROM workspace_previews WHERE state IN ('starting', 'ready', 'stopping')").all() as { proxy_port: number }[]).map((row) => row.proxy_port));
      const slot = this.slots.find((candidate) => !ports.has(candidate.port));
      if (!slot) throw new PreviewError("All preview slots are occupied. Stop a preview before starting another.");
      const now = new Date().toISOString();
      const preview: WorkspacePreview = { id: randomUUID(), projectId: project.id, taskId: task.id, state: "starting", profile: parsed.value,
        dirty: false, isolation: "host", publicOrigin: slot.origin, detail: "Verifying workspace and starting the preview…", logs: "", startedAt: now, updatedAt: now };
      this.db.prepare("INSERT INTO workspace_previews (id, project_id, task_id, state, proxy_port, target_port, workspace_path, preview_json) VALUES (?, ?, ?, 'starting', ?, 0, ?, ?)")
        .run(preview.id, project.id, task.id, slot.port, task.worktreePath ?? `${project.localPath}-wt-${task.id}`, JSON.stringify(preview));
      return { preview, slot };
    })();
    const run: LivePreview = { value: value.preview, controller: new AbortController(), finished: Promise.resolve(),
      release: this.mock ? () => {} : retainWorkspace(task.worktreePath!), stopRequested: false };
    this.live.set(run.value.id, run);
    run.finished = this.execute(run, project, task, value.slot);
    return run.value;
  }
  private async execute(run: LivePreview, project: Project, task: Task, slot: PreviewSlot): Promise<void> {
    let failure: Error | undefined;
    try {
      if (this.mock) {
        await abortableDelay(150, run.controller.signal);
        run.value.headSha = "d".repeat(40); run.value.state = "ready"; run.value.detail = "Mock preview ready. No host process was started."; this.persist(run.value);
        await new Promise<void>((resolve) => run.controller.signal.addEventListener("abort", () => resolve(), { once: true }));
        return;
      }
      const snapshot = await new GitServiceImpl().inspectWorkspace(project, task);
      run.controller.signal.throwIfAborted();
      const current = repo.getTask(this.db, task.id);
      if (!current || repo.getProject(this.db, project.id)?.localPath !== project.localPath || current.projectId !== project.id || current.worktreePath !== task.worktreePath || current.branch !== task.branch) throw new PreviewError("Task workspace changed before preview launch.");
      run.value.headSha = snapshot.headSha; run.value.dirty = snapshot.dirty; this.persist(run.value);
      const workspaceIdentity = lstatSync(task.worktreePath!);
      const targetPort = await unusedPort();
      this.db.prepare("UPDATE workspace_previews SET target_port = ? WHERE id = ?").run(targetPort, run.value.id);
      run.gateway = new PreviewGateway({ id: run.value.id, port: slot.port, targetPort, origin: slot.origin,
        ready: () => run.value.state === "ready" && !run.controller.signal.aborted,
        verifyTarget: async () => {
          try {
            const owner = repo.getTask(this.db, task.id);
            const identity = lstatSync(task.worktreePath!);
            if (!owner || repo.getProject(this.db, project.id)?.localPath !== project.localPath || owner.worktreePath !== task.worktreePath || owner.branch !== task.branch || !identity.isDirectory()
              || identity.ino !== workspaceIdentity.ino || identity.dev !== workspaceIdentity.dev
              || !run.childPid || !await previewOwnsPort(targetPort, run.childPid)) throw new Error("Preview process or workspace is no longer owned by this session.");
            return true;
          } catch (error) { failure = asError(error); run.controller.abort(); return false; }
        } });
      await run.gateway.listen();
      run.controller.signal.throwIfAborted();
      run.home = mkdtempSync(join(tmpdir(), "hoop-preview-"));
      const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: process.env.LANG ?? "C.UTF-8", HOME: run.home, TMPDIR: run.home,
        PORT: String(targetPort), HOST: "127.0.0.1", BROWSER: "none", CI: "1" };
      const worker = fork(fileURLToPath(new URL("./preview-worker.mjs", import.meta.url)), [], { env: environment, execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
      run.worker = worker;
      run.controller.signal.addEventListener("abort", () => { if (worker.connected) worker.send({ type: "stop" }, () => {}); }, { once: true });
      run.workerClosed = new Promise<void>((resolve) => worker.once("close", () => resolve()));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Preview supervisor did not start.")), 5000);
        worker.once("error", (error) => { clearTimeout(timer); reject(error); });
        worker.on("message", (raw: unknown) => {
          const message = raw as { type?: string; pid?: number; text?: string; message?: string; code?: number | null };
          try {
            if (message.type === "spawned" && typeof message.pid === "number") {
              run.childPid = message.pid; this.db.prepare("UPDATE workspace_previews SET child_pid = ? WHERE id = ?").run(message.pid, run.value.id);
              clearTimeout(timer); resolve();
            } else if (message.type === "log" && typeof message.text === "string") {
              run.value.logs = (run.value.logs + message.text).slice(0, 66_000); this.persist(run.value);
            } else if (message.type === "error") {
              clearTimeout(timer); failure ??= new Error(message.message ?? "Preview process failed."); reject(failure); run.controller.abort();
            } else if (message.type === "ended" && !run.stopRequested) {
              clearTimeout(timer); failure ??= new Error(`Preview process exited (${message.code ?? "signal"}). Check its logs and start command.`); reject(failure); run.controller.abort();
            }
          } catch (error) { failure = asError(error); clearTimeout(timer); reject(failure); run.controller.abort(); }
        });
        const args = run.value.profile.args.map((arg) => arg.replaceAll("{port}", String(targetPort)).replaceAll("{host}", "127.0.0.1"));
        worker.send({ type: "start", command: run.value.profile.command, args, cwd: task.worktreePath, env: environment });
      });
      const deadline = Date.now() + run.value.profile.startupTimeoutSeconds * 1000;
      let ready = false;
      while (Date.now() < deadline) {
        run.controller.signal.throwIfAborted();
        if (run.childPid && await previewOwnsPort(targetPort, run.childPid)) {
          try {
            const response = await fetch(`http://127.0.0.1:${targetPort}${run.value.profile.readinessPath}`, { redirect: "manual", signal: AbortSignal.any([run.controller.signal, AbortSignal.timeout(1000)]) });
            ready = response.status >= 200 && response.status < 400; await response.body?.cancel();
            if (ready) break;
          } catch { run.controller.signal.throwIfAborted(); }
        }
        await abortableDelay(200, run.controller.signal);
      }
      if (!ready) throw new PreviewError("Preview readiness timed out. Check the command, assigned PORT and readiness path, then retry.");
      run.value.state = "ready"; run.value.detail = "Preview ready · native host process. Working files may continue to change."; this.persist(run.value);
      await run.workerClosed;
      if (!run.stopRequested) throw failure ?? new Error("Preview supervisor exited unexpectedly.");
    } catch (error) { if (!run.stopRequested) failure ??= asError(error); }
    finally {
      run.controller.abort();
      if (run.worker?.connected) run.worker.send({ type: "stop" }, () => {});
      await run.gateway?.close();
      await run.workerClosed;
      const orphaned = !!run.childPid && processGroupExists(run.childPid);
      run.value.state = orphaned ? "interrupted" : run.stopRequested ? "stopped" : "failed";
      run.value.detail = orphaned ? "The preview supervisor exited before its process group settled. Access is revoked and the workspace is retained; stop the orphan on this host before retrying."
        : run.stopRequested ? "Preview stopped. Workspace files are preserved." : failure instanceof Error ? failure.message : "Preview could not start.";
      this.persist(run.value);
      if (orphaned) this.recovering.set(run.value.id, { pid: run.childPid!, release: run.release, projectId: project.id });
      else { run.release(); if (run.home) rmSync(run.home, { recursive: true, force: true }); }
      this.live.delete(run.value.id);
    }
  }
  async stop(projectId: string, taskId: string): Promise<WorkspacePreview | null> {
    const value = this.latest(projectId, taskId); if (!value) return null;
    const run = this.live.get(value.id);
    if (run) {
      run.stopRequested = true; run.value.state = "stopping"; run.value.detail = "Stopping preview and settling its process group…"; this.persist(run.value);
      run.controller.abort(); if (run.worker?.connected) run.worker.send({ type: "stop" }, () => {});
      await run.finished;
      const settled = this.latest(projectId, taskId);
      if (settled?.state === "interrupted") throw new PreviewError(settled.detail);
    } else if (this.recovering.has(value.id)) throw new PreviewError("An interrupted preview is still settling. No unverified process was killed.");
    return this.latest(projectId, taskId);
  }
  open(projectId: string, taskId: string, controlOrigin?: string) {
    const value = this.latest(projectId, taskId);
    if (!value || value.state !== "ready") throw new PreviewError("Preview is not ready.");
    if (this.mock) return { url: new URL("/mock-preview.html", controlOrigin ?? "http://127.0.0.1:4317").href, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const gateway = this.live.get(value.id)?.gateway;
    if (!gateway) throw new PreviewError("Preview session was interrupted. Restart it before opening.");
    return gateway.launch(controlOrigin);
  }
  async close(): Promise<void> {
    this.closing = true; clearInterval(this.recoveryTimer);
    const results = await Promise.allSettled([...this.live.values()].map((run) => this.stop(run.value.projectId, run.value.taskId)));
    this.reconcile();
    const unsettled = this.recovering.size;
    for (const orphan of this.recovering.values()) orphan.release(); this.recovering.clear();
    const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason as unknown);
    if (unsettled) failures.push(new Error(`${unsettled} interrupted preview process groups remain unverified; their records are preserved.`));
    if (failures.length) throw new AggregateError(failures, "Not every preview process settled during shutdown.");
  }
}
