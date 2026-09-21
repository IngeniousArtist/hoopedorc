import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Fastify from "fastify";
import { routingEvaluationExample, type EvaluateRoutingResponse } from "@orc/types";
import { initDb } from "./db/index";
import { evaluateRouting, parseRoutingBenchmark, routingSuggestion } from "./routing-evaluation-policy";
import { RoutingEvaluationStore } from "./routing-evaluation-store";
import { registerRoutingEvaluationRoutes } from "./routing-evaluation-routes";

function observed() {
  const data = routingEvaluationExample(); data.provenance = "observed";
  for (const item of data.cases) { item.outcomes.economy!.repairCostUsd = 0; item.outcomes.economy!.calls = 2; }
  return data;
}

test("VW18: replay accepts only eligible confident choices and records bounded static fallbacks", () => {
  const data = routingEvaluationExample(); const sample = data.cases[0]!;
  const response = sample.classification.response as { answers: { route: { choice: string; confidence: number; probabilities: Record<string, number> } } };
  assert.deepEqual(routingSuggestion(sample, data.policy), { model: "economy", reason: "accepted" });
  for (const status of ["unavailable", "timeout"] as const) assert.deepEqual(routingSuggestion({ ...sample, classification: { ...sample.classification, status } }, data.policy), { model: "strong", reason: status });
  assert.equal(routingSuggestion({ ...sample, classification: { ...sample.classification, response: "broken json" } }, data.policy).reason, "malformed");
  assert.equal(routingSuggestion({ ...sample, classification: { ...sample.classification, costUsd: null } }, data.policy).reason, "over_budget");
  assert.equal(routingSuggestion({ ...sample, classification: { ...sample.classification, durationMs: 2001 } }, data.policy).reason, "timeout");
  assert.equal(routingSuggestion({ ...sample, candidates: sample.candidates.map((candidate) => ({ ...candidate, eligible: candidate.id !== "economy" })) }, data.policy).reason, "ineligible");
  response.answers.route.confidence = 0.79; assert.equal(routingSuggestion(sample, data.policy).reason, "low_confidence");
  response.answers.route.confidence = 0.8; assert.equal(routingSuggestion(sample, data.policy).reason, "accepted");
  response.answers.route.choice = "not-eligible"; response.answers.route.probabilities = { "not-eligible": 1 }; assert.equal(routingSuggestion(sample, data.policy).reason, "ineligible");
  response.answers.route.choice = "economy"; response.answers.route.probabilities = { economy: 1 }; assert.equal(routingSuggestion(sample, data.policy).reason, "malformed");
});

test("VW18: downstream repairs, classifier overhead and bad outcomes defeat apparent savings", () => {
  assert.equal(evaluateRouting(parseRoutingBenchmark(routingEvaluationExample())).status, "insufficient_evidence");
  const data = observed(); const initial = evaluateRouting(parseRoutingBenchmark(data));
  assert.equal(initial.status, "candidate_for_pilot"); assert.equal(initial.liveRoutingEnabled, false); assert.equal(initial.comparedCases, 12); assert.equal(initial.proposed.calls, 36); assert.equal(initial.static.calls, 24); assert.equal(initial.proposed.tokens, 81320);
  for (const item of data.cases) item.outcomes.economy!.repairCostUsd = 2;
  const repaired = evaluateRouting(data); assert.equal(repaired.status, "keep_static"); assert.ok(repaired.proposed.costUsd > repaired.static.costUsd); assert.ok(repaired.proposed.repairCostUsd > 0);
  const failing = observed(); failing.cases[0]!.outcomes.economy!.acceptable = false; assert.equal(evaluateRouting(failing).status, "keep_static");
  const slow = observed(); for (const item of slow.cases) item.outcomes.economy!.durationMs = 100000; assert.equal(evaluateRouting(slow).status, "keep_static");
  const subscription = observed(); for (const item of subscription.cases) { item.classification.costUsd = 0; for (const outcome of Object.values(item.outcomes)) { outcome.initialCostUsd = 0; outcome.validationCostUsd = 0; outcome.repairCostUsd = 0; } } assert.equal(evaluateRouting(subscription).status, "keep_static");
  const missing = observed(); delete missing.cases[0]!.outcomes.economy; missing.cases[1]!.classification.costUsd = null; const partial = evaluateRouting(missing); assert.equal(partial.status, "insufficient_evidence"); assert.equal(partial.comparedCases, 10); assert.equal(partial.unknownClassifierCosts, 1);
  const calibration = observed(); calibration.cases[0]!.split = "calibration"; assert.equal(evaluateRouting(calibration).heldOutCases, 11); assert.equal(evaluateRouting(calibration).status, "insufficient_evidence");
});

test("VW18: strict imports refuse unsafe/missing values instead of converting them to zero", () => {
  const data = observed();
  assert.throws(() => parseRoutingBenchmark({ ...data, execute: "anything" }), /unknown fields/);
  assert.throws(() => parseRoutingBenchmark({ ...data, cases: [...data.cases, data.cases[0]] }), /unique/);
  data.cases[0]!.outcomes.economy!.initialCostUsd = -1; assert.throws(() => parseRoutingBenchmark(data), /between/);
  data.cases[0]!.outcomes.economy!.initialCostUsd = null; assert.equal(evaluateRouting(parseRoutingBenchmark(data)).status, "insufficient_evidence");
  data.cases[0]!.candidates[1]!.eligible = false; assert.throws(() => parseRoutingBenchmark(data), /eligible static fallback/);
  assert.throws(() => parseRoutingBenchmark({ ...observed(), methodology: "a".repeat(512001) }), /512 KB/);
  const nested = observed(); let depth: unknown = "leaf"; for (let i = 0; i < 30; i++) depth = { nested: depth }; nested.cases[0]!.classification.response = depth; assert.throws(() => parseRoutingBenchmark(nested), /structural limits/);
});

test("VW18: transactional reports survive retries/restart without mutating settings or billing", async () => {
  const root = mkdtempSync(join(tmpdir(), "vw18-eval-")); const path = join(root, "state.sqlite"); let db = initDb(path); const dataset = routingEvaluationExample(); const requestId = randomUUID();
  try {
    let store = new RoutingEvaluationStore(db); const first = store.evaluate({ requestId, dataset }); assert.equal(store.evaluate({ dataset: { ...dataset, policy: { maxClassifierLatencyMs: 2000, maxClassifierCostUsd: 0.01, minConfidence: 0.8 } }, requestId }).id, first.id);
    assert.throws(() => store.evaluate({ requestId, dataset: { ...dataset, name: "different" } }), /different input/);
    db.close(); db = initDb(path); store = new RoutingEvaluationStore(db); assert.deepEqual(store.evaluate({ requestId, dataset }), first); assert.equal(store.list().length, 1); assert.equal((db.prepare("SELECT COUNT(*) AS count FROM model_invocations").get() as { count: number }).count, 0);
    const app = Fastify(); registerRoutingEvaluationRoutes(app, db);
    try {
      assert.equal((await app.inject({ method: "POST", url: "/api/routing/evaluations", payload: { requestId, dataset } })).statusCode, 200);
      const detail = await app.inject({ url: `/api/routing/evaluations/${requestId}` }); assert.equal(detail.json<EvaluateRoutingResponse>().evaluation.datasetHash, first.datasetHash);
      assert.equal((await app.inject({ url: "/api/routing/evaluations/missing" })).statusCode, 404);
      assert.equal((await app.inject({ method: "POST", url: "/api/routing/evaluations", payload: { requestId: randomUUID(), dataset: { invalid: true } } })).statusCode, 400);
      assert.equal((await app.inject({ method: "POST", url: "/api/routing/evaluations", payload: { data: "a".repeat(550001) } })).statusCode, 413);
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM settings").get() as { count: number }).count, 0);
    } finally { await app.close(); }
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
