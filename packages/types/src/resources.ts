import type { InvocationStage, ModelId } from "./domain";

export interface AccountPool {
  id: string;
  name: string;
  billing: "subscription" | "metered";
  maxConcurrent: number;
  /** Slots withheld from non-review calls; must be less than maxConcurrent. */
  reviewSlots: number;
  quota?: { windowHours: number; maxCalls?: number; maxCostUsd?: number };
}
export interface InvocationAccounting {
  poolId?: string;
  billing: "subscription" | "metered";
  /** Omitted means retain the CLI's reported cost. Missing rates are zero. */
  pricing?: { input: number; cached: number; output: number };
}
export interface ResourceReservation {
  id: string;
  projectId?: string;
  taskId?: string;
  model: ModelId;
  stage: InvocationStage;
  poolId: string;
  state: "reserved" | "active" | "unresolved" | "released";
  createdAt: string;
  updatedAt: string;
}
export interface PoolResourceStatus {
  pool: AccountPool;
  models: ModelId[];
  active: number;
  reserved: number;
  unresolved: number;
  authorSlotsAvailable: number;
  observedCalls: number;
  meteredCostUsd: number;
  tokens: number;
  unknownSpendCalls: number;
  windowHours: number;
  cooldownUntil?: string;
  reason?: string;
}
export interface ResourcesResponse {
  pools: PoolResourceStatus[];
  unresolved: ResourceReservation[];
  unpooledModels: ModelId[];
  providerAllowance: "unknown";
}
export interface RecoverResourceRequest {
  requestId: string;
  expectedUpdatedAt: string;
  confirmWorkerStopped: true;
}
export interface RecoverResourceResponse { reservation: ResourceReservation }
