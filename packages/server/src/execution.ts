import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { execInvocationProcess, type AgentAdapter, type AgentExecution } from "@orc/adapters";
import { ResourceUnavailableError, type ExecutionCapability, type ExecutionProfile, type ExecutionStatusResponse, type ExecutionWorker, type ModelConfig, type Project, type Task } from "@orc/types";
import type { Db } from "./db/index";
import * as repo from "./db/repo";
import { defaultSettings, ENV } from "./config";
import { DockerExecutionDriver, ExecutionUnsettledError, workerIdentity, WORKER_CLI_VERSION, type DockerWorkerIdentity } from "./execution-docker";
import { ResourceManager } from "./resources";
import { persistInvocationEvent } from "./invocation-ledger";

interface WorkerRecord extends ExecutionWorker { identity: DockerWorkerIdentity; directory: string; cwd: string }
const within = (root: string, path: string) => { const r = relative(root, path); return !r || r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r); };
async function canonicalPath(path: string): Promise<string> {
  let current = resolve(path); const tail: string[] = [];
  for (;;) {
    try { return join(await realpath(current), ...tail); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(current) === current) throw error;
      tail.unshift(basename(current)); current = dirname(current);
    }
  }
}
const fingerprint = (profile: ExecutionProfile) => createHash("sha256").update(JSON.stringify(profile)).digest("hex");
const PROBE = `const {spawnSync}=require('node:child_process'); const v=spawnSync('codex',['--version'],{encoding:'utf8'}); const a=spawnSync('codex',['login','status'],{encoding:'utf8'}); console.log(JSON.stringify({version:v.status===0?v.stdout.trim():'unavailable',chatgpt:a.status===0 && /Logged in using ChatGPT/i.test(a.stdout+a.stderr)}));`;

/** One owner for isolated CLI transports; no client command or secret payloads. */
export class ExecutionService {
  readonly owner: string;
  readonly root: string;
  private readonly verifying = new Map<string, { fingerprint: string; promise: Promise<ExecutionCapability> }>();
  constructor(readonly db: Db, readonly driver = new DockerExecutionDriver(), root = join(dirname(resolve(ENV.dbPath)), ".hoopedorc-execution")) {
    this.root = resolve(root);
    db.prepare("INSERT OR IGNORE INTO execution_installation (id, owner) VALUES (1, ?)").run(randomUUID());
    this.owner = (db.prepare("SELECT owner FROM execution_installation WHERE id = 1").get() as { owner: string }).owner;
  }
  private settings() { return repo.getSettings(this.db) ?? defaultSettings(); }
  profile(model: ModelConfig): ExecutionProfile | undefined {
    if (!model.executionProfileId) return undefined;
    const profile = this.settings().executionProfiles?.find((item) => item.id === model.executionProfileId);
    if (!profile || model.runner !== profile.runner || profile.accountPoolId !== model.accountPoolId) throw new ResourceUnavailableError("The requested execution profile no longer matches this model and subscription pool. Update settings before retrying.", false);
    return structuredClone(profile);
  }
  private row(id: string): WorkerRecord | undefined {
    const row = this.db.prepare("SELECT json, state FROM execution_workers WHERE id = ?").get(id) as { json: string; state: ExecutionWorker["state"] } | undefined;
    return row ? { ...JSON.parse(row.json) as WorkerRecord, state: row.state } : undefined;
  }
  private transition(id: string, state: ExecutionWorker["state"]) {
    const record = this.row(id); if (!record) throw new Error("Execution ownership is missing.");
    record.state = state; record.updatedAt = new Date().toISOString();
    this.db.prepare("UPDATE execution_workers SET state = ?, json = ? WHERE id = ?").run(state, JSON.stringify(record), id);
    if (state === "unresolved") this.db.prepare("UPDATE resource_reservations SET state = 'unresolved', updated_at = ? WHERE id = ? AND state != 'released'").run(record.updatedAt, record.invocationId);
  }
  private async newWorker(profile: ExecutionProfile, imageId: string, runtimeId: string, invocationId: string, cwd: string, readOnly: boolean, signal?: AbortSignal, project?: Project, task?: Task, verification?: ExecutionCapability): Promise<{ execution: AgentExecution; finish: () => Promise<void> }> {
    if (this.db.prepare("SELECT 1 FROM execution_workers WHERE invocation_id = ?").get(invocationId)) throw new ResourceUnavailableError("This invocation already owns an isolated worker. Retry with a new invocation ID.", false);
    const identity = workerIdentity(this.owner, runtimeId); const directory = join(this.root, "jobs", identity.id);
    const now = new Date().toISOString();
    const record: WorkerRecord = { id: identity.id, invocationId, projectId: project?.id, taskId: task?.id, profileId: profile.id, profile: structuredClone(profile), verification, imageId, runtimeId, workerName: identity.workerName, proxyName: identity.proxyName, state: "preparing", createdAt: now, updatedAt: now, identity, directory, cwd };
    this.db.prepare("INSERT INTO execution_workers (id, invocation_id, project_id, task_id, profile_id, state, json) VALUES (?, ?, ?, ?, ?, ?, ?)").run(record.id, invocationId, project?.id ?? null, task?.id ?? null, profile.id, record.state, JSON.stringify(record));
    const execution = await this.driver.prepare({ identity, profile, imageId, cwd, directory, readOnly, transition: (state) => this.transition(identity.id, state) }, signal);
    return { execution, finish: async () => { await execution.close(); await this.cleanFiles(record);
      const invocation = repo.getInvocation(this.db, invocationId);
      if (invocation && invocation.outcome !== "running") new ResourceManager(this.db).release(invocationId);
    } };
  }
  private async cleanFiles(record: WorkerRecord) {
    // Never recursively remove a restored arbitrary path or a workspace.
    if (record.identity.owner !== this.owner || record.directory !== join(this.root, "jobs", record.id) || !/^[a-f0-9-]{36}$/.test(record.id)) throw new ExecutionUnsettledError();
    await rm(record.directory, { recursive: true, force: true });
  }
  async stop(id: string): Promise<void> {
    const record = this.row(id); if (!record) throw new ResourceUnavailableError("Worker not found.", false);
    if (record.identity.owner !== this.owner) throw new ExecutionUnsettledError();
    if (!["unresolved", "stopped"].includes(record.state)) throw new ResourceUnavailableError("This worker has an active owner. Stop its task first; running verification probes settle automatically.", false);
    if (record.state !== "stopped") {
      this.transition(id, "stopping");
      try { await this.driver.stop(record.identity); this.transition(id, "stopped"); }
      catch { this.transition(id, "unresolved"); throw new ExecutionUnsettledError(); }
    }
    await this.cleanFiles(record);
  }
  async recover(): Promise<string[]> {
    const unresolved: string[] = [];
    const rows = this.db.prepare("SELECT id FROM execution_workers WHERE state != 'stopped'").all() as { id: string }[];
    for (const row of rows) { try { await this.stop(row.id); } catch (error) { if (!(error instanceof ExecutionUnsettledError)) throw error; unresolved.push(row.id); } }
    return unresolved;
  }
  workspaceHeld(projectId: string, taskId?: string): boolean { return Boolean(taskId ? this.db.prepare("SELECT 1 FROM execution_workers WHERE project_id = ? AND task_id = ? AND state != 'stopped'").get(projectId, taskId) : this.db.prepare("SELECT 1 FROM execution_workers WHERE project_id = ? AND state != 'stopped'").get(projectId)); }
  async stopInvocation(id: string): Promise<void> {
    const row = this.db.prepare("SELECT id FROM execution_workers WHERE invocation_id = ?").get(id) as { id: string } | undefined;
    if (row) {
      const worker = this.row(row.id)!;
      if (!["unresolved", "stopped"].includes(worker.state)) throw new ResourceUnavailableError("This worker still has an active owner. Stop its task before recovering capacity.", false);
      await this.stop(row.id);
    }
  }
  response(): ExecutionStatusResponse {
    const settings = this.settings();
    const profiles = (settings.executionProfiles ?? []).map((profile): ExecutionCapability => {
      const row = this.db.prepare("SELECT fingerprint, json FROM execution_capabilities WHERE profile_id = ?").get(profile.id) as { fingerprint: string; json: string } | undefined;
      return row?.fingerprint === fingerprint(profile) ? JSON.parse(row.json) as ExecutionCapability : { profileId: profile.id, runner: profile.runner, state: "unavailable", detail: "Verify the installed worker image and its separate CLI login.", checkedAt: new Date().toISOString() };
    });
    const workers = (this.db.prepare("SELECT id FROM execution_workers WHERE state != 'stopped' OR id IN (SELECT id FROM execution_workers WHERE state = 'stopped' ORDER BY rowid DESC LIMIT 30) ORDER BY rowid DESC").all() as { id: string }[]).map(({ id }) => { const row = this.row(id)!; return { id: row.id, invocationId: row.invocationId, projectId: row.projectId, taskId: row.taskId, profileId: row.profileId, profile: row.profile, verification: row.verification, imageId: row.imageId, runtimeId: row.runtimeId, workerName: row.workerName, proxyName: row.proxyName, state: row.state, createdAt: row.createdAt, updatedAt: row.updatedAt, detail: row.detail }; });
    return { platform: process.platform, profiles, workers, host: { filesystemIsolated: false, networkIsolated: false, authentication: "host-cli" } };
  }
  async verify(profile: ExecutionProfile, signal?: AbortSignal): Promise<ExecutionCapability> {
    const existing = this.verifying.get(profile.id);
    if (existing) {
      const result = await existing.promise; signal?.throwIfAborted();
      if (existing.fingerprint !== fingerprint(profile)) throw new ResourceUnavailableError("Execution settings changed during another verification. Retry the saved profile.", false);
      return result;
    }
    signal?.throwIfAborted();
    const promise = this.verifyOwned(profile, signal).finally(() => { if (this.verifying.get(profile.id)?.promise === promise) this.verifying.delete(profile.id); });
    this.verifying.set(profile.id, { fingerprint: fingerprint(profile), promise }); return promise;
  }
  private async verifyOwned(profile: ExecutionProfile, signal?: AbortSignal): Promise<ExecutionCapability> {
    let result: ExecutionCapability = { profileId: profile.id, runner: profile.runner, state: "unavailable", authentication: "unavailable", detail: "Verification has not completed.", checkedAt: new Date().toISOString() };
    let probe: Awaited<ReturnType<ExecutionService["newWorker"]>> | undefined;
    const cwd = join(this.root, "probes", randomUUID());
    try {
      const { imageId, runtimeId } = await this.driver.inspectProfile(profile, signal); result.imageId = imageId; result.runtimeId = runtimeId;
      await mkdir(cwd, { recursive: true, mode: 0o700 });
      probe = await this.newWorker(profile, imageId, runtimeId, `execution-probe-${randomUUID()}`, cwd, true, signal);
      const output = await execInvocationProcess("node", ["-e", PROBE], { cwd, signal, timeoutMs: 20_000, maxOutputBytes: 4096 }, probe.execution);
      const checked = JSON.parse(output.stdout) as { version: string; chatgpt: boolean }; result.cliVersion = checked.version;
      if (checked.version !== WORKER_CLI_VERSION) throw new ResourceUnavailableError(`This profile requires ${WORKER_CLI_VERSION}. Rebuild the pinned worker image.`, false);
      if (!checked.chatgpt) throw new ResourceUnavailableError("The worker CLI is not signed in with ChatGPT. Use the documented device login in this account volume; host logins and API keys are never substituted.", false);
      result = { ...result, state: "verified", authentication: "chatgpt", detail: "Docker worker and Codex version/login checked. Workspace-only mounts and provider-only proxy are enforced on each launch. Provider model access still requires an explicit model test." };
    } catch (error) {
      if (signal?.aborted) throw error;
      result.detail = error instanceof ResourceUnavailableError ? error.message : "Docker worker verification failed. Check the local daemon, immutable image, account volume and service-user access.";
    } finally {
      if (probe) { try { await probe.finish(); } catch { result.state = "unavailable"; result.detail = "Probe cleanup is unresolved. Stop the owned worker before retrying."; } }
      if (!probe || this.db.prepare("SELECT 1 FROM execution_workers WHERE invocation_id LIKE 'execution-probe-%' AND state != 'stopped' AND json_extract(json, '$.cwd') = ?").get(cwd) === undefined) await rm(cwd, { recursive: true, force: true });
    }
    this.db.prepare("INSERT INTO execution_capabilities (profile_id, fingerprint, json) VALUES (?, ?, ?) ON CONFLICT(profile_id) DO UPDATE SET fingerprint = excluded.fingerprint, json = excluded.json").run(profile.id, fingerprint(profile), JSON.stringify(result));
    return result;
  }
  async check(model: ModelConfig, signal?: AbortSignal): Promise<string | null> {
    try {
      const profile = this.profile(model); if (!profile) return null;
      const status = await this.verify(profile, signal); return status.state === "verified" ? null : status.detail;
    } catch (error) { if (signal?.aborted) throw error; return error instanceof Error ? error.message : "Execution profile is unavailable."; }
  }
  async prepare(model: ModelConfig, invocationId: string, cwd: string, stage: string, signal?: AbortSignal, project?: Project, task?: Task) {
    const profile = this.profile(model); if (!profile) return undefined;
    if (project && this.db.prepare("SELECT 1 FROM execution_workers WHERE project_id = ? AND state = 'unresolved'").get(project.id)) throw new ExecutionUnsettledError();
    const root = await realpath(cwd);
    if (project) {
      const rollback = task?.prNumber ? repo.getRollbackJobForTask(this.db, task.id, task.prNumber) : undefined;
      const paths = [task?.worktreePath ?? project.localPath, ...(rollback?.projectId === project.id ? [rollback.worktreePath] : [])];
      const expected = await Promise.all(paths.map((path) => realpath(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; })));
      if (!expected.includes(root)) throw new ResourceUnavailableError("Worker path no longer matches its assigned project or task workspace.", false);
      for (const other of repo.getProjects(this.db)) {
        if (other.id !== project.id && within(root, await canonicalPath(other.localPath))) throw new ResourceUnavailableError("Worker workspace contains another project's clone. Use separate project directories.", false);
      }
    }
    const controlRoot = await canonicalPath(this.root);
    const forbidden = await Promise.all([this.root, resolve(ENV.dbPath), homedir(), resolve(process.cwd())].map(canonicalPath));
    if (forbidden.some((path) => within(root, path)) || within(controlRoot, root) && project) throw new ResourceUnavailableError("The worker workspace overlaps control-plane state, the server checkout or HOME. Use a separate project clone and place DB_PATH outside project workspaces.", false);
    const status = await this.verify(profile, signal);
    if (status.state !== "verified" || !status.imageId || !status.runtimeId) throw new ResourceUnavailableError(status.detail, false);
    return this.newWorker(profile, status.imageId, status.runtimeId, invocationId, cwd, !["author", "docs"].includes(stage), signal, project, task, status);
  }
  wrap(project: Project | undefined, model: ModelConfig, adapter: AgentAdapter): AgentAdapter {
    if (!model.executionProfileId) return adapter;
    // Freeze the chosen profile with this adapter, including across Settings edits.
    const snapshot = this.profile(model)!;
    return { runner: adapter.runner, run: async (options) => {
      if (!options.invocation) throw new ResourceUnavailableError("Isolated execution requires a durable invocation identity.", false);
      if (JSON.stringify(this.profile(model)) !== JSON.stringify(snapshot)) throw new ResourceUnavailableError("Execution profile changed before launch. Retry with current settings.", false);
      const task = options.invocation.taskId ? repo.getTask(this.db, options.invocation.taskId) ?? undefined : undefined;
      let temporary: string | undefined;
      if (!project) { temporary = join(this.root, "health", randomUUID()); await mkdir(temporary, { recursive: true, mode: 0o700 }); }
      const cwd = temporary ?? options.cwd;
      const prepared = await this.prepare(model, options.invocation.id, cwd, options.invocation.stage, options.signal, project, task);
      if (!prepared) throw new ResourceUnavailableError("Execution profile disappeared before launch.", false);
      let result; let failure: unknown; let failed = false;
      try { result = await adapter.run({ ...options, cwd, execution: prepared.execution, prompt: options.prompt + "\nExecution: /work is the assigned workspace. Host Git operations, dependency installation and gates are managed by Hoopedorc outside this worker. Edit files directly; do not commit, push or change Git metadata. Only approved model-provider network access is available.\n" }); }
      catch (error) { failure = error; failed = true; }
      try { await prepared.finish(); if (temporary) await rm(temporary, { recursive: true, force: true }); }
      catch (error) {
        const invocation = repo.getInvocation(this.db, options.invocation.id);
        if (result && invocation?.outcome === "running") persistInvocationEvent(this.db, { ...invocation, outcome: "failed", exitReason: "error", endedAt: new Date().toISOString(), costUsd: result.costUsd, tokensIn: result.tokensIn, tokensOut: result.tokensOut, tokensCached: result.tokensCached ?? 0 });
        throw error;
      }
      if (failed) throw failure;
      if (!result) throw new Error("Agent adapter returned no result.");
      return result;
    } };
  }
}
