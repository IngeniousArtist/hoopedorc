import type { Difficulty } from "./domain";

/** Recorded data only. Evaluating never invokes a provider or changes routing. */
export interface RoutingBenchmark {
  version: 1;
  name: string;
  provenance: "synthetic" | "observed";
  /** Explain collection, independent review, and how held-out tasks were reserved. */
  methodology: string;
  policy: { minConfidence: number; maxClassifierCostUsd: number; maxClassifierLatencyMs: number };
  cases: RoutingBenchmarkCase[];
}
export interface RoutingBenchmarkCase {
  id: string;
  brief: string;
  category: "frontend" | "backend" | "docs" | "operations";
  difficulty: Difficulty;
  split: "calibration" | "held_out";
  candidates: { id: string; eligible: boolean }[];
  staticModel: string;
  classification: {
    status: "ok" | "unavailable" | "timeout";
    /** Original Jev response. Invalid responses exercise static fallback. */
    response?: unknown;
    costUsd: number | null;
    durationMs: number;
    /** Measured token overhead, including failed requests; null means unknown. */
    tokens: number | null;
    evidence: string;
  };
  outcomes: Record<string, RoutingBenchmarkOutcome>;
}
export interface RoutingBenchmarkOutcome {
  /** Costs are disjoint; repair includes every repair call/check. */
  initialCostUsd: number | null;
  validationCostUsd: number | null;
  repairCostUsd: number | null;
  tokens: number | null;
  calls: number | null;
  durationMs: number | null;
  acceptable: boolean | null;
  evidence: string;
}
export type RoutingFallbackReason = "accepted" | "unavailable" | "timeout" | "over_budget" | "malformed" | "low_confidence" | "ineligible";
export interface RoutingEvaluationCase {
  id: string;
  selectedModel: string;
  staticModel: string;
  reason: RoutingFallbackReason;
  complete: boolean;
  staticCostUsd?: number;
  proposedCostUsd?: number;
}
export interface RoutingEvaluationTotals {
  costUsd: number;
  repairCostUsd: number;
  tokens: number;
  calls: number;
  durationMs: number;
  unacceptable: number;
}
export interface RoutingEvaluationReport {
  evaluatorVersion: 1;
  status: "insufficient_evidence" | "keep_static" | "candidate_for_pilot";
  reasons: string[];
  heldOutCases: number;
  comparedCases: number;
  classifierModels: string[];
  classifierCostUsd: number;
  /** Counts cases with missing classifier cost; never treated as free. */
  unknownClassifierCosts: number;
  static: RoutingEvaluationTotals;
  proposed: RoutingEvaluationTotals;
  assignments: { model: string; static: number; proposed: number }[];
  cases: RoutingEvaluationCase[];
  liveRoutingEnabled: false;
}
export interface RoutingEvaluationRecord {
  id: string;
  createdAt: string;
  datasetHash: string;
  dataset: RoutingBenchmark;
  report: RoutingEvaluationReport;
}
export interface RoutingEvaluationSummary {
  id: string;
  name: string;
  createdAt: string;
  provenance: RoutingBenchmark["provenance"];
  status: RoutingEvaluationReport["status"];
}
