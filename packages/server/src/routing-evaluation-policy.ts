import type { RoutingBenchmark, RoutingBenchmarkCase, RoutingBenchmarkOutcome, RoutingEvaluationReport, RoutingEvaluationTotals, RoutingFallbackReason } from "@orc/types";
export class RoutingEvaluationError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
const fail = (message: string): never => { throw new RoutingEvaluationError(message); };
function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail(`${field} must be an object.`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], field: string) { if (Object.keys(value).some((key) => !allowed.includes(key))) fail(`${field} has unknown fields.`); }
function text(value: unknown, field: string, max = 500): string { if (typeof value !== "string" || value.length > max || value.includes("\0")) return fail(`${field} must be text of at most ${max} characters.`); return value; }
function id(value: unknown, field: string) { const result = text(value, field, 100); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)) fail(`${field} must be a safe identifier.`); return result; }
function number(value: unknown, field: string, max = 1_000_000): number { if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) return fail(`${field} must be between 0 and ${max}.`); return value; }
function count(value: unknown, field: string): number { const result = number(value, field, 1e12); if (!Number.isSafeInteger(result)) fail(`${field} must be an integer.`); return result; }
function nullable(value: unknown, field: string, parse = number): number | null { return value === null ? null : parse(value, field); }
function choice<T extends string>(value: unknown, choices: readonly T[], field: string): T { if (!choices.includes(value as T)) return fail(`${field} must be one of ${choices.join(", ")}.`); return value as T; }
function boolean(value: unknown, field: string): boolean { if (typeof value !== "boolean") return fail(`${field} must be true or false.`); return value; }
function outcome(value: unknown, field: string): RoutingBenchmarkOutcome {
  const raw = object(value, field); keys(raw, ["initialCostUsd", "validationCostUsd", "repairCostUsd", "tokens", "calls", "durationMs", "acceptable", "evidence"], field);
  return { initialCostUsd: nullable(raw.initialCostUsd, `${field}.initialCostUsd`), validationCostUsd: nullable(raw.validationCostUsd, `${field}.validationCostUsd`), repairCostUsd: nullable(raw.repairCostUsd, `${field}.repairCostUsd`), tokens: nullable(raw.tokens, `${field}.tokens`, count), calls: nullable(raw.calls, `${field}.calls`, count), durationMs: nullable(raw.durationMs, `${field}.durationMs`, count), acceptable: raw.acceptable === null ? null : boolean(raw.acceptable, `${field}.acceptable`), evidence: text(raw.evidence, `${field}.evidence`) };
}
export function parseRoutingBenchmark(value: unknown): RoutingBenchmark {
  const stack = [{ value, depth: 0 }]; let nodes = 0;
  while (stack.length) {
    const next = stack.pop()!;
    if (++nodes > 20_000 || next.depth > 24) fail("Dataset exceeds structural limits (24 levels / 20000 values).");
    if (next.value && typeof next.value === "object") for (const child of Object.values(next.value as Record<string, unknown>)) stack.push({ value: child, depth: next.depth + 1 });
  }
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > 512_000) fail("Dataset exceeds 512 KB.");
  const raw = object(value, "dataset"); keys(raw, ["version", "name", "provenance", "methodology", "policy", "cases"], "dataset");
  if (raw.version !== 1) fail("Use dataset version 1.");
  const policy = object(raw.policy, "policy"); keys(policy, ["minConfidence", "maxClassifierCostUsd", "maxClassifierLatencyMs"], "policy");
  if (!Array.isArray(raw.cases) || !raw.cases.length || raw.cases.length > 100) fail("Use 1–100 recorded cases.");
  const ids = new Set<string>();
  const cases = (raw.cases as unknown[]).map((value, index): RoutingBenchmarkCase => {
    const field = `cases[${index}]`; const item = object(value, field);
    keys(item, ["id", "brief", "category", "difficulty", "split", "candidates", "staticModel", "classification", "outcomes"], field);
    const caseId = id(item.id, `${field}.id`); if (ids.has(caseId)) fail("Case IDs must be unique."); ids.add(caseId);
    if (!Array.isArray(item.candidates) || !item.candidates.length || item.candidates.length > 12) fail(`${field} requires 1–12 candidate snapshots.`);
    const candidateIds = new Set<string>();
    const candidates = (item.candidates as unknown[]).map((value) => { const candidate = object(value, "candidate"); keys(candidate, ["id", "eligible"], "candidate"); const model = id(candidate.id, "candidate.id"); if (candidateIds.has(model)) fail("Candidate IDs must be unique."); candidateIds.add(model); return { id: model, eligible: boolean(candidate.eligible, "candidate.eligible") }; });
    const staticModel = id(item.staticModel, `${field}.staticModel`); if (!candidates.some((candidate) => candidate.id === staticModel && candidate.eligible)) fail(`${field} requires an eligible static fallback.`);
    const classified = object(item.classification, `${field}.classification`); keys(classified, ["status", "response", "costUsd", "durationMs", "tokens", "evidence"], "classification");
    const outcomes = object(item.outcomes, `${field}.outcomes`);
    if (Object.keys(outcomes).some((model) => !candidateIds.has(model))) fail(`${field} has an outcome for an unknown candidate.`);
    return { id: caseId, brief: text(item.brief, `${field}.brief`, 4000), category: choice(item.category, ["frontend", "backend", "docs", "operations"], `${field}.category`), difficulty: choice(item.difficulty, ["easy", "medium", "hard"], `${field}.difficulty`), split: choice(item.split, ["calibration", "held_out"], `${field}.split`), candidates, staticModel,
      classification: { status: choice(classified.status, ["ok", "unavailable", "timeout"], "classification.status"), response: classified.response, costUsd: nullable(classified.costUsd, "classification.costUsd"), durationMs: count(classified.durationMs, "classification.durationMs"), tokens: nullable(classified.tokens, "classification.tokens", count), evidence: text(classified.evidence, "classification.evidence") },
      outcomes: Object.fromEntries(Object.entries(outcomes).map(([model, value]) => [model, outcome(value, `${field}.outcomes.${model}`)])) };
  });
  return { version: 1, name: text(raw.name, "name", 120), provenance: choice(raw.provenance, ["synthetic", "observed"], "provenance"), methodology: text(raw.methodology, "methodology", 4000), policy: { minConfidence: number(policy.minConfidence, "minConfidence", 1), maxClassifierCostUsd: number(policy.maxClassifierCostUsd, "maxClassifierCostUsd", 10), maxClassifierLatencyMs: number(policy.maxClassifierLatencyMs, "maxClassifierLatencyMs", 60_000) }, cases };
}

/** Pure bounded policy for replay; no network, prompt execution or task mutation. */
export function routingSuggestion(item: RoutingBenchmarkCase, policy: RoutingBenchmark["policy"]): { model: string; reason: RoutingFallbackReason } {
  const fallback = (reason: RoutingFallbackReason) => ({ model: item.staticModel, reason });
  const call = item.classification;
  if (call.status !== "ok") return fallback(call.status);
  if (call.durationMs > policy.maxClassifierLatencyMs) return fallback("timeout");
  if (call.costUsd === null || call.costUsd > policy.maxClassifierCostUsd) return fallback("over_budget");
  try {
    const response = object(call.response, "response");
    if (typeof response.model !== "string" || !/^jev-[A-Za-z0-9._-]{1,80}$/.test(response.model)) return fallback("malformed");
    const answer = object(object(response.answers, "answers").route, "route");
    const probabilities = object(answer.probabilities, "probabilities");
    const usage = object(response.usage, "usage");
    count(usage.input_tokens, "input_tokens"); count(usage.output_tokens, "output_tokens");
    if (answer.type !== "choice" || typeof answer.choice !== "string" || typeof answer.confidence !== "number" || answer.confidence < 0 || answer.confidence > 1 || !Number.isFinite(answer.confidence) || !Object.hasOwn(probabilities, answer.choice)) return fallback("malformed");
    const values = Object.values(probabilities); if (!values.length || values.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)) return fallback("malformed");
    const sum = (values as number[]).reduce((sum, value) => sum + value, 0); if (Math.abs(sum - 1) > 0.01) return fallback("malformed");
    if (!item.candidates.some((candidate) => candidate.id === answer.choice && candidate.eligible)) return fallback("ineligible");
    if (Object.keys(probabilities).length !== item.candidates.filter((candidate) => candidate.eligible).length || Object.keys(probabilities).some((key) => !item.candidates.some((candidate) => candidate.id === key && candidate.eligible))) return fallback("malformed");
    if (answer.confidence < policy.minConfidence) return fallback("low_confidence");
    return { model: answer.choice, reason: "accepted" };
  } catch (error) { if (!(error instanceof RoutingEvaluationError)) throw error; return fallback("malformed"); }
}
const emptyTotals = (): RoutingEvaluationTotals => ({ costUsd: 0, repairCostUsd: 0, tokens: 0, calls: 0, durationMs: 0, unacceptable: 0 });
type CompleteOutcome = { [K in keyof RoutingBenchmarkOutcome]: NonNullable<RoutingBenchmarkOutcome[K]> };
function complete(value: RoutingBenchmarkOutcome | undefined): value is CompleteOutcome { return !!value && Object.values(value).every((value) => value !== null) && !!value.evidence.trim(); }
function add(total: RoutingEvaluationTotals, value: CompleteOutcome) { total.costUsd += value.initialCostUsd + value.validationCostUsd + value.repairCostUsd; total.repairCostUsd += value.repairCostUsd; total.tokens += value.tokens; total.calls += value.calls; total.durationMs += value.durationMs; total.unacceptable += value.acceptable ? 0 : 1; }
export function evaluateRouting(dataset: RoutingBenchmark): RoutingEvaluationReport {
  const report: RoutingEvaluationReport = { evaluatorVersion: 1, status: "insufficient_evidence", reasons: [], heldOutCases: 0, comparedCases: 0, classifierModels: [], classifierCostUsd: 0, unknownClassifierCosts: 0, static: emptyTotals(), proposed: emptyTotals(), assignments: [], cases: [], liveRoutingEnabled: false };
  const assignments = new Map<string, { model: string; static: number; proposed: number }>();
  let unknownVersion = false;
  const heldOut = dataset.cases.filter((item) => item.split === "held_out"); report.heldOutCases = heldOut.length;
  for (const item of heldOut) {
    const suggestion = routingSuggestion(item, dataset.policy); const call = item.classification;
    const responseModel = call.response && typeof call.response === "object" && "model" in call.response ? call.response.model : undefined;
    if (typeof responseModel === "string" && /^jev-[A-Za-z0-9._-]{1,80}$/.test(responseModel)) {
      if (!report.classifierModels.includes(responseModel)) report.classifierModels.push(responseModel);
    } else if (call.status === "ok") unknownVersion = true;
    const baseline = Object.hasOwn(item.outcomes, item.staticModel) ? item.outcomes[item.staticModel] : undefined;
    const proposed = Object.hasOwn(item.outcomes, suggestion.model) ? item.outcomes[suggestion.model] : undefined;
    const row = { id: item.id, selectedModel: suggestion.model, staticModel: item.staticModel, reason: suggestion.reason, complete: false } as RoutingEvaluationReport["cases"][number];
    if (call.costUsd === null) report.unknownClassifierCosts++; else report.classifierCostUsd += call.costUsd;
    for (const [model, key] of [[item.staticModel, "static"], [suggestion.model, "proposed"]] as const) { const counts = assignments.get(model) ?? { model, static: 0, proposed: 0 }; counts[key]++; assignments.set(model, counts); }
    if (complete(baseline) && complete(proposed) && call.costUsd !== null && call.tokens !== null && call.evidence.trim()) {
      row.complete = true; report.comparedCases++; add(report.static, baseline); add(report.proposed, proposed);
      report.proposed.costUsd += call.costUsd; report.proposed.tokens += call.tokens; report.proposed.calls++; report.proposed.durationMs += call.durationMs;
      row.staticCostUsd = baseline.initialCostUsd + baseline.validationCostUsd + baseline.repairCostUsd;
      row.proposedCostUsd = proposed.initialCostUsd + proposed.validationCostUsd + proposed.repairCostUsd + call.costUsd;
    }
    report.cases.push(row);
  }
  report.assignments = [...assignments.values()];
  if (dataset.provenance !== "observed") report.reasons.push("Synthetic examples demonstrate policy only; they cannot establish Jev efficacy.");
  if (unknownVersion || report.classifierModels.length !== 1 || report.classifierModels.includes("jev-latest")) report.reasons.push("Use one pinned Jev response version for the held-out comparison.");
  if (!dataset.methodology.trim()) report.reasons.push("Describe collection, independent outcome review and how the held-out set was reserved.");
  if (heldOut.length < 12 || new Set(heldOut.map((item) => item.difficulty)).size < 3 || new Set(heldOut.map((item) => item.category)).size < 3) report.reasons.push("Use at least 12 held-out cases spanning all difficulties and at least three task categories.");
  if (report.comparedCases !== heldOut.length) report.reasons.push("Some cases lack matched outcomes, reviewed evidence, classifier cost or token usage. Partial totals are not a complete comparison.");
  if (report.reasons.length) return report;
  report.status = "keep_static";
  if (report.proposed.unacceptable > 0) report.reasons.push("The proposed allocation has unacceptable outcomes; price savings cannot approve it.");
  if (report.proposed.costUsd >= report.static.costUsd - 1e-9) report.reasons.push("No observed dollar savings after classification, validation and repair costs (zero subscription cost is not unused quota).");
  if (report.proposed.durationMs > report.static.durationMs) report.reasons.push("Total observed latency increased after classifier overhead.");
  if (!report.reasons.length) { report.status = "candidate_for_pilot"; report.reasons.push("Imported observations support a separately authorized, bounded live pilot. This is not statistical certification or an automatic routing change."); }
  return report;
}
