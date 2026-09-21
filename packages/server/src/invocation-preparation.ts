import type { ActivationRevision, ModelConfig } from "@orc/types";
import type { ActivationInvocation, ActivationService, PreparedActivation } from "./activation";
import type { ResourceManager } from "./resources";

/** One project invocation boundary: admission, capabilities, then the caller's
 * durable ledger start and model process. Every failure settles unstarted work. */
export async function prepareProjectInvocation(resources: ResourceManager, activation: ActivationService, invocation: ActivationInvocation, model: ModelConfig, revision: ActivationRevision): Promise<PreparedActivation> {
  const accounting = await resources.acquire({ id: invocation.id, model: model.id, modelConfig: model, stage: invocation.stage, projectId: invocation.project.id, taskId: invocation.task?.id }, invocation.signal);
  try {
    const prepared = await activation.prepare(invocation, revision);
    return { ...prepared, accounting, close: async () => { try { await prepared.close(); } finally { resources.releaseUnstarted(invocation.id); } } };
  } catch (error) { resources.releaseUnstarted(invocation.id); throw error; }
}
