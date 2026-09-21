import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeSelectiveClaude, selectiveClaudeVersion, verifySelectiveClaudeAuth, type AgentAdapter, type SelectiveLaunch } from "@orc/adapters";
import type { ActivationManifest, ActivationRevision, ModelInvocation, Project, RunnerKind, Task } from "@orc/types";
import type { Db } from "./db/index";
import * as repo from "./db/repo";
import { LibraryStore } from "./library";
import { ActivationStore } from "./activation-store";
import type { PreviewManager } from "./previews";
import type { ReviewManager } from "./reviews";
import { openTaskBrowser } from "./activation-browser";

export interface ActivationInvocation {
  id: string; project: Project; task?: Task; stage: ModelInvocation["stage"]; runner: RunnerKind; cwd: string; signal?: AbortSignal;
}
export interface PreparedActivation { execution?: import("@orc/adapters").AgentExecution; launch?: SelectiveLaunch; instructions: string; accounting?: import("@orc/types").InvocationAccounting; close: () => Promise<void> }
const LIMITATION = "Repository CLAUDE.md and managed policy remain inherited. Selected skills are instruction snapshots; native skill catalogs, plugins and hooks are disabled. MCP tool names were observed before the model request; this CLI does not expose all tool schemas. This is context control, not filesystem isolation.";

export class ActivationService {
  readonly store: ActivationStore;
  private browser?: { previews: PreviewManager; reviews: ReviewManager };
  private readonly checked = new Map<string, number>();
  constructor(private readonly db: Db) { this.store = new ActivationStore(db); }
  setBrowser(previews: PreviewManager, reviews: ReviewManager) { this.browser = { previews, reviews }; }
  /** Pure eligibility first: no model call, no attempt and no workspace mutation. */
  async check(project: Project, task: Task, runner: RunnerKind, signal?: AbortSignal): Promise<string | null> {
    try {
      project = repo.getProject(this.db, project.id) ?? project;
      const revision = this.store.resolve(project.id, task.description);
      if (revision.policy.mode === "inherit") return null;
      if (runner !== "claude-code") throw new Error(`Selective activation is not verified for ${runner}. Use a verified Claude profile or explicitly choose inherited activation.`);
      await selectiveClaudeVersion(signal);
      this.skills(revision);
      if (revision.policy.browser) {
        if (!this.browser) throw new Error("Task browser service is unavailable.");
        const capability = this.browser.reviews.capability(); if (!capability.available) throw new Error(capability.reason);
        if (!project.config?.preview) throw new Error("This policy requires a browser. Save a preview profile in Workspaces first.");
      }
      const key = JSON.stringify([project.id, task.id, task.runGeneration, revision.revision, runner]);
      if ((this.checked.get(key) ?? 0) < Date.now() - 10_000) {
        // Missing MCPs refuse before an author attempt. The actual invocation
        // repeats discovery against its exact cwd, then snapshots the result.
        const prepared = await this.prepare({ id: `preflight-${randomUUID()}`, project, task, stage: "health", runner, cwd: task.worktreePath ?? project.localPath, signal }, revision);
        await prepared.close();
        for (const [cacheKey, time] of this.checked) if (time < Date.now() - 10_000) this.checked.delete(cacheKey);
        this.checked.set(key, Date.now());
      }
      return null;
    } catch (error) { return error instanceof Error ? error.message : "Activation is unavailable."; }
  }
  private skills(revision: ActivationRevision) {
    const selected = new LibraryStore(this.db).resolve(revision.projectId, revision.policy.skills);
    if (selected.some((skill) => skill.kind !== "skill")) throw new Error("A selected activation entry is not a Skill.");
    return selected;
  }
  async prepare(invocation: ActivationInvocation, revision = this.store.resolve(invocation.project.id, invocation.task?.description)): Promise<PreparedActivation> {
    const manifest: ActivationManifest = { id: invocation.id, projectId: invocation.project.id, taskId: invocation.task?.id, stage: invocation.stage, runner: invocation.runner, revision: revision.revision, createdAt: new Date().toISOString(), state: "refused", skills: [], servers: [], browser: "disabled", detail: "Activation initialization did not complete." };
    // Persist a refusal before crossing any process boundary; a crash leaves a
    // truthful incomplete receipt rather than an invented successful manifest.
    this.store.manifest(manifest);
    let directory: string | undefined; let bridge: Awaited<ReturnType<typeof openTaskBrowser>> | undefined;
    const close = async () => { try { await bridge?.close(); } finally { if (directory) await rm(directory, { recursive: true, force: true }); } };
    try {
      if (revision.policy.mode === "inherit") {
        manifest.state = "inherited"; manifest.detail = "CLI-owned configuration is inherited. Hoopedorc does not claim to disable skills, plugins, instructions or MCPs in this mode."; this.store.manifest(manifest);
        return { instructions: "", close };
      }
      if (invocation.runner !== "claude-code") throw new Error(`Selective activation is not verified for ${invocation.runner}. Choose inherited mode or a verified Claude profile.`);
      manifest.cliVersion = await selectiveClaudeVersion(invocation.signal);
      const skills = this.skills(revision);
      manifest.skills = skills.map(({ id, revision, contentSha }) => ({ id, revision, contentSha }));
      const mcpServers: Record<string, unknown> = Object.fromEntries(revision.policy.mcps.filter((mcp) => mcp.enabled).map((mcp) => [mcp.id, mcp.transport]));
      if (revision.policy.browser) {
        if (invocation.task && (invocation.stage === "author" || invocation.stage === "validator")) {
          if (!this.browser) throw new Error("Task browser service is unavailable.");
          const capability = this.browser.reviews.capability(); if (!capability.available) throw new Error(capability.reason);
          bridge = await openTaskBrowser(this.db, this.browser.previews, this.browser.reviews, invocation.project, invocation.task, invocation.signal);
          mcpServers["hoop-browser"] = bridge.config; manifest.browser = "task-scoped";
        } else manifest.browser = "unavailable-outside-task";
      }
      directory = await mkdtemp(join(tmpdir(), "hoop-activation-"));
      const launch = { mcpConfigPath: join(directory, "mcp.json") };
      await writeFile(launch.mcpConfigPath, JSON.stringify({ mcpServers }), { mode: 0o600 });
      await verifySelectiveClaudeAuth(launch, invocation.signal);
      manifest.servers = await probeSelectiveClaude(invocation.cwd, launch, Object.keys(mcpServers), invocation.signal);
      manifest.state = "verified"; manifest.detail = LIMITATION; this.store.manifest(manifest);
      const instructions = "\n## Invocation activation\n" + LIMITATION + "\n" + skills.map((skill) => `\n### Selected skill: ${skill.title} (${skill.id}@${skill.revision})\n${skill.content}\n`).join("") + (manifest.browser === "task-scoped" ? "\nUse hoop-browser for task preview checks. Save code first; browser evidence never bypasses required gates.\n" : manifest.browser === "unavailable-outside-task" ? "\nThe project browser selection applies only to author/reviewer task workspaces; no task browser is granted to this planning or documentation call.\n" : "");
      return { launch, instructions, close };
    } catch (error) {
      manifest.detail = error instanceof Error ? error.message : "Activation refused."; this.store.manifest(manifest);
      await close(); throw error;
    }
  }
  wrap(project: Project, adapter: AgentAdapter): AgentAdapter {
    return { runner: adapter.runner, run: async (options) => {
      const task = options.invocation?.taskId ? repo.getTask(this.db, options.invocation.taskId) ?? undefined : undefined;
      if (options.invocation && !task) throw new Error("Invocation task is no longer available.");
      if (task && task.projectId !== project.id) throw new Error("Invocation task belongs to another project.");
      const owner = repo.getProject(this.db, project.id);
      if (!owner) throw new Error("Invocation project is no longer available.");
      const prepared = await this.prepare({ id: options.invocation?.id ?? `activation-${randomUUID()}`, project: owner, task, stage: options.invocation?.stage ?? "author", runner: adapter.runner, cwd: options.cwd, signal: options.signal });
      let result;
      try { result = await adapter.run({ ...options, activation: prepared.launch, prompt: options.prompt + prepared.instructions }); }
      catch (error) { await prepared.close(); throw error; }
      try { await prepared.close(); }
      catch {
        // Cleanup failure blocks success but must never erase billed usage.
        const detail = "Invocation capability cleanup failed. Inspect active browser checks before retrying.";
        options.onLog(detail + "\n");
        return { ...result, ok: false, exitReason: "error" as const, summary: `${result.summary ?? ""}\n${detail}` };
      }
      return result;
    } };
  }
}
