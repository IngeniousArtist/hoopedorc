import { test } from "node:test";
import assert from "node:assert/strict";
import { manualCostUsd } from "./pricing";

test("returns null when no manual price is set (keep the CLI-reported cost)", () => {
  assert.equal(manualCostUsd(undefined, 1000, 1000), null);
  assert.equal(manualCostUsd({}, 1000, 1000), null);
});

test("recomputes cost from tokens using the three per-1M prices", () => {
  const cfg = {
    costPerMInputUsd: 3,
    costPerMCachedInputUsd: 0.3,
    costPerMOutputUsd: 15,
  };
  // 1M fresh in + 2M cached + 0.5M out = 3 + 0.6 + 7.5
  const cost = manualCostUsd(cfg, 1_000_000, 500_000, 2_000_000);
  assert.ok(cost != null && Math.abs(cost - 11.1) < 1e-9);
});

test("unset fields count as $0 so partial pricing still applies", () => {
  const cost = manualCostUsd({ costPerMOutputUsd: 10 }, 1_000_000, 100_000);
  assert.ok(cost != null && Math.abs(cost - 1) < 1e-9);
});

test("zero tokens with pricing set gives $0, not null", () => {
  assert.equal(manualCostUsd({ costPerMInputUsd: 3 }, 0, 0, 0), 0);
});
