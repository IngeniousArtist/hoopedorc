import type { GateResult, MergeDecision, Task } from "./domain";

/** Approved limits apply to verification and all appended repair work together. */
export interface MilestonePolicy {
  maxRepairRounds: number;
  maxInvocations: number;
  maxDurationMinutes: number;
  maxCostUsd: number;
}
export const DEFAULT_MILESTONE_POLICY: MilestonePolicy = {
  maxRepairRounds: 2, maxInvocations: 12, maxDurationMinutes: 120, maxCostUsd: 10,
};
export interface MilestoneRepair { milestoneId: string; round: number }
export interface CriterionEvidence { criterion: string; passed: boolean; evidence: string }
export interface MilestoneProof {
  headSha: string;
  /** Exact criteria and dependency state reviewed, independent of task timestamps. */
  criteria: string[];
  dependencies: { id: string; runGeneration: number; attempts: number; status: Task["status"] }[];
  environment: string;
  checkedAt: string;
}
export interface MilestoneOutcome {
  task: Task;
  verificationTask: Task;
  contributors: Pick<Task, "id" | "title" | "status">[];
  state: "pending" | "checking" | "accepted" | "needs_attention" | "stale" | "unavailable";
  reason: string;
  decision?: MergeDecision;
  currentHead?: string;
  repairRounds: number;
  calls: number;
  observedCostUsd: number;
  unknownSpendCalls: number;
  startedAt?: string;
  deadline?: string;
  repairUnavailableReason?: string;
}
export function validMilestonePolicy(value: unknown): value is MilestonePolicy {
  if (!value || typeof value !== "object") return false;
  const p = value as MilestonePolicy;
  return Number.isInteger(p.maxRepairRounds) && p.maxRepairRounds >= 0 && p.maxRepairRounds <= 5 &&
    Number.isInteger(p.maxInvocations) && p.maxInvocations >= 1 && p.maxInvocations <= 100 &&
    Number.isInteger(p.maxDurationMinutes) && p.maxDurationMinutes >= 1 && p.maxDurationMinutes <= 1440 &&
    Number.isFinite(p.maxCostUsd) && p.maxCostUsd > 0 && p.maxCostUsd <= 1000;
}
export function milestoneGatesPassed(gate: GateResult): boolean {
  return gate.typecheck && gate.lint && gate.build && gate.tests && gate.noConflicts && gate.inScope &&
    gate.vacuous === false && gate.executed?.includes("tests") === true;
}
export function completeCriterionEvidence(criteria: string[], evidence?: CriterionEvidence[]): boolean {
  return criteria.length > 0 && evidence?.length === criteria.length && criteria.every((criterion, index) => {
    const item = evidence[index];
    return item?.criterion === criterion && item.passed === true && typeof item.evidence === "string" && item.evidence.trim().length > 0;
  });
}
