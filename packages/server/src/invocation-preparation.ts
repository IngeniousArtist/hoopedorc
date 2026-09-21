import type { ExecutionService } from "./execution";
import type { ActivationRevision, ModelConfig } from "@orc/types";
import type { ActivationInvocation, ActivationService, PreparedActivation } from "./activation";
import type { ResourceManager } from "./resources";

/** One project invocation boundary: admission, capabilities, then the caller's
 * durable ledger start and model process. Every failure settles unstarted work. */
export async function prepareProjectInvocation(resources: ResourceManager, activation: ActivationService, invocation: ActivationInvocation, model: ModelConfig, revision: ActivationRevision, execution?: ExecutionService): Promise<PreparedActivation> {
  const accounting = await resources.acquire({ id: invocation.id, model: model.id, modelConfig: model, stage: invocation.stage, projectId: invocation.project.id, taskId: invocation.task?.id }, invocation.signal);
  try {
    const prepared = await activation.prepare(invocation, revision);
    try {
      const worker = await execution?.prepare(model, invocation.id, invocation.cwd, invocation.stage, invocation.signal, invocation.project, invocation.task);
      return { ...prepared, execution: worker?.execution, accounting, close: async () => { try { await worker?.finish(); } finally { try { await prepared.close(); } finally { resources.releaseUnstarted(invocation.id); } } } };
    } catch (error) { await prepared.close(); throw error; }
  } catch (error) { resources.releaseUnstarted(invocation.id); throw error; }
}
