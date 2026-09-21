import type { PlanningOperation, PlanOperationResponse } from "@orc/types";
import { api, ApiRequestError } from "../api/client";

export function planningActive(operation: PlanningOperation | null | undefined): boolean {
  return !!operation && ["queued", "running", "cancelling"].includes(operation.state);
}

export function planningResult(operation: PlanningOperation) {
  if (operation.state === "succeeded" && operation.result) return operation.result;
  const error = operation.error;
  throw new ApiRequestError(error?.message ?? "Planning did not complete.", error?.status ?? 409, error?.code, error?.details);
}

/** A failed status read is a connection problem, never evidence that work stopped. */
export async function followPlanningOperation(
  initial: PlanningOperation,
  current: () => boolean,
  update: (operation: PlanningOperation) => void,
  disconnected: (message: string | null) => void,
): Promise<PlanningOperation> {
  let operation = initial;
  update(operation);
  while (planningActive(operation)) {
    await new Promise((resolve) => setTimeout(resolve, 750));
    if (!current()) throw new DOMException("View changed", "AbortError");
    try {
      const response = await api<PlanOperationResponse>("planOperation", { params: { id: operation.projectId, operationId: operation.id } });
      if (!current()) throw new DOMException("View changed", "AbortError");
      operation = response.operation;
      disconnected(null);
      update(operation);
    } catch (error) {
      if (!current()) throw new DOMException("View changed", "AbortError");
      // Deletion/expired identity is terminal for observation, not for the CLI.
      if (error instanceof ApiRequestError && error.status === 404) throw error;
      disconnected("Connection lost. Planning may still be running; reconnecting to its saved status…");
    }
  }
  return operation;
}
