import { randomUUID } from "node:crypto";
import type { PlanChatResponse, PlanDeconstructRequest, PlanDeconstructResponse, PlanningOperation } from "@orc/types";
import type { Db } from "./db/index";
import * as repo from "./db/repo";

const ACTIVE = "('queued', 'running', 'cancelling')";
export const planningOperationActive = (operation: PlanningOperation | null): boolean =>
  !!operation && ["queued", "running", "cancelling"].includes(operation.state);

export class PlanningOperationError extends Error {
  constructor(message: string, readonly status = 409, readonly code = "PLANNING_CONFLICT", readonly details?: unknown) {
    super(message);
  }
}

export function getPlanningOperation(db: Db, projectId: string, id: string): PlanningOperation | null {
  const row = db.prepare("SELECT * FROM planning_operations WHERE project_id = ? AND id = ?").get(projectId, id) as {
    id: string; project_id: string; revision_id: string; kind: PlanningOperation["kind"];
    state: PlanningOperation["state"]; input_json: string; retry_of: string | null;
    created_at: string; started_at: string | null; ended_at: string | null;
    result_json: string | null; error_json: string | null;
  } | undefined;
  if (!row) return null;
  return {
    id: row.id, projectId: row.project_id, revisionId: row.revision_id,
    kind: row.kind, state: row.state,
    input: JSON.parse(row.input_json) as PlanDeconstructRequest,
    retryOf: row.retry_of ? row.retry_of : undefined,
    createdAt: row.created_at, startedAt: row.started_at ? row.started_at : undefined,
    endedAt: row.ended_at ? row.ended_at : undefined,
    result: row.result_json ? JSON.parse(row.result_json) as PlanningOperation["result"] : undefined,
    error: row.error_json ? JSON.parse(row.error_json) as PlanningOperation["error"] : undefined,
    invocationIds: (db.prepare("SELECT invocation_id FROM planning_operation_invocations WHERE operation_id = ? ORDER BY rowid").all(id) as { invocation_id: string }[]).map((r) => r.invocation_id),
  };
}

export function activePlanningOperation(db: Db, projectId: string): PlanningOperation | null {
  const row = db.prepare(`SELECT id FROM planning_operations WHERE project_id = ? AND state IN ${ACTIVE}`).get(projectId) as { id: string } | undefined;
  return row ? getPlanningOperation(db, projectId, row.id) : null;
}

export function latestPlanningOperation(db: Db, projectId: string, revisionId: string): PlanningOperation | null {
  const row = db.prepare("SELECT id FROM planning_operations WHERE project_id = ? AND revision_id = ? ORDER BY rowid DESC LIMIT 1").get(projectId, revisionId) as { id: string } | undefined;
  return row ? getPlanningOperation(db, projectId, row.id) : null;
}

export interface PlanningExecutionResult {
  result: PlanChatResponse | PlanDeconstructResponse;
  update: repo.PlanningSessionUpdate;
  /** Best-effort human-readable archive; the DB result/transcript is authoritative. */
  archive?: () => void;
}

interface Dependencies {
  db: Db;
  controllers: Set<AbortController>;
  own: (label: string, operation: () => Promise<void>) => void;
  execute: (operation: PlanningOperation, signal: AbortSignal) => Promise<PlanningExecutionResult>;
  onUpdate: (operation: PlanningOperation) => void;
  error: (error: unknown, kind?: PlanningOperation["kind"]) => NonNullable<PlanningOperation["error"]>;
  warn: (message: string) => void;
}

/** SQLite owns identity/finalization; these handles own only the current process. */
export class PlanningOperations {
  private readonly running = new Map<string, { controller: AbortController; settled: Promise<void> }>();
  constructor(private readonly deps: Dependencies) {}

  start(projectId: string, kind: PlanningOperation["kind"], request: PlanDeconstructRequest, retryOf?: string): PlanningOperation {
    const { db } = this.deps;
    const id = request.operationId ?? randomUUID();
    const operation = db.transaction(() => {
      const existing = getPlanningOperation(db, projectId, id);
      const input = {
        revisionId: request.revisionId,
        messages: request.messages,
        ...(kind === "deconstruct" ? { figmaVerification: request.figmaVerification ?? "live" } : {}),
      };
      if (existing) {
        if (existing.kind !== kind || existing.retryOf !== retryOf || JSON.stringify({
          revisionId: existing.input.revisionId, messages: existing.input.messages,
          ...(kind === "deconstruct" ? { figmaVerification: existing.input.figmaVerification } : {}),
        }) !== JSON.stringify(input) || (request.sessionVersion !== undefined && request.sessionVersion !== existing.input.sessionVersion)) {
          throw new PlanningOperationError("This operation id belongs to a different planning request.");
        }
        return { value: existing, created: false };
      }
      const current = repo.getPlanningSession(db, projectId);
      if (current.revisionId !== request.revisionId || (request.sessionVersion !== undefined && current.sessionVersion !== request.sessionVersion)) {
        throw new PlanningOperationError("The planning session changed. Reload it before retrying this edit.", 409, "PLANNING_STALE");
      }
      if (repo.getPlanningCommitReceipt(db, projectId, request.revisionId)?.state === "pending") {
        throw new PlanningOperationError("Planning approval is pending persistence. Finish its existing commit before starting another operation.");
      }
      if (activePlanningOperation(db, projectId)) throw new PlanningOperationError("Planning is already active for this project. Reopen Plan to follow it.", 409, "PLANNING_ACTIVE");
      db.prepare(`INSERT INTO planning_operations (id, project_id, revision_id, kind, state, input_json, retry_of, created_at)
        VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`).run(id, projectId, request.revisionId, kind,
        JSON.stringify({ ...input, sessionVersion: current.sessionVersion }), retryOf ?? null, new Date().toISOString());
      return { value: getPlanningOperation(db, projectId, id)!, created: true };
    })();
    if (operation.created) {
      this.publish(operation.value);
      const controller = new AbortController();
      this.deps.controllers.add(controller);
      // Defer execution one microtask so ownership exists before any callback.
      const settled = Promise.resolve().then(() => this.execute(operation.value, controller)).finally(() => {
        this.running.delete(id);
        this.deps.controllers.delete(controller);
      });
      this.running.set(id, { controller, settled });
      this.deps.own(`planning ${id}`, () => settled);
    }
    return operation.value;
  }

  retry(projectId: string, id: string): PlanningOperation {
    const { db } = this.deps;
    const previous = getPlanningOperation(db, projectId, id);
    if (!previous) throw new PlanningOperationError("Planning operation not found.", 404);
    const child = db.prepare("SELECT id FROM planning_operations WHERE retry_of = ?").get(id) as { id: string } | undefined;
    if (child) return getPlanningOperation(db, projectId, child.id)!;
    if (!["failed", "interrupted", "cancelled"].includes(previous.state)) {
      throw new PlanningOperationError("Only failed, interrupted, or cancelled planning can be retried.");
    }
    return this.start(projectId, previous.kind, previous.input, id);
  }

  async wait(projectId: string, id: string): Promise<PlanningOperation> {
    await this.running.get(id)?.settled;
    return getPlanningOperation(this.deps.db, projectId, id)!;
  }

  cancel(projectId: string, id: string): PlanningOperation {
    const operation = getPlanningOperation(this.deps.db, projectId, id);
    if (!operation) throw new PlanningOperationError("Planning operation not found.", 404);
    if (planningOperationActive(operation)) {
      this.deps.db.prepare(`UPDATE planning_operations SET state = 'cancelling' WHERE id = ? AND state IN ${ACTIVE}`).run(id);
      this.running.get(id)?.controller.abort();
      const current = getPlanningOperation(this.deps.db, projectId, id)!;
      this.publish(current);
      return current;
    }
    return operation;
  }

  async stop(): Promise<void> {
    for (const { controller } of this.running.values()) controller.abort();
    await Promise.allSettled([...this.running.values()].map((work) => work.settled));
  }

  private publish(operation: PlanningOperation): void {
    try { this.deps.onUpdate(operation); }
    catch { this.deps.warn(`Could not broadcast planning status ${operation.id}; REST remains authoritative.`); }
  }

  private async execute(operation: PlanningOperation, controller: AbortController): Promise<void> {
    const { db } = this.deps;
    try {
      if (controller.signal.aborted) throw new Error("Planning interrupted.");
      db.prepare("UPDATE planning_operations SET state = 'running', started_at = ? WHERE id = ? AND state = 'queued'").run(new Date().toISOString(), operation.id);
      this.publish(getPlanningOperation(db, operation.projectId, operation.id)!);
      const completed = await this.deps.execute(operation, controller.signal);
      if (controller.signal.aborted) throw new Error("Planning interrupted.");
      db.transaction(() => {
        if (!repo.savePlanningSessionForRevision(db, operation.projectId, operation.revisionId, completed.update, operation.input.sessionVersion)) {
          throw new PlanningOperationError("The planning session changed before completion. Its newer contents were preserved.", 409, "PLANNING_STALE");
        }
        const result = { ...completed.result, sessionVersion: repo.getPlanningSession(db, operation.projectId).sessionVersion };
        const finalized = db.prepare("UPDATE planning_operations SET state = 'succeeded', result_json = ?, ended_at = ? WHERE id = ? AND state = 'running'")
          .run(JSON.stringify(result), new Date().toISOString(), operation.id);
        if (finalized.changes !== 1) throw new PlanningOperationError("Planning no longer owns this result.");
      })();
      try { completed.archive?.(); } catch { this.deps.warn(`Could not archive planning ${operation.id}; its result is saved in SQLite.`); }
    } catch (error) {
      const current = getPlanningOperation(db, operation.projectId, operation.id)!;
      const cancelled = current.state === "cancelling";
      const state = cancelled ? "cancelled" : controller.signal.aborted ? "interrupted" : "failed";
      const failure = cancelled || controller.signal.aborted
        ? { message: cancelled ? "Planning cancelled. Your previous draft is unchanged." : "Planning was interrupted. Retry starts a new model attempt.", status: 409, code: cancelled ? "PLANNING_CANCELLED" : "PLANNING_INTERRUPTED" }
        : this.deps.error(error, operation.kind);
      db.prepare(`UPDATE planning_operations SET state = ?, error_json = ?, ended_at = ? WHERE id = ? AND state IN ${ACTIVE}`)
        .run(state, JSON.stringify(failure), new Date().toISOString(), operation.id);
    }
    this.publish(getPlanningOperation(db, operation.projectId, operation.id)!);
  }
}
