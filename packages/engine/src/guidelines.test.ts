import assert from "node:assert/strict";
import { test } from "node:test";
import { buildEngineeringStandardsBlock } from "./guidelines.js";

test("buildEngineeringStandardsBlock: undefined guidelines produces nothing", () => {
  assert.equal(buildEngineeringStandardsBlock(undefined, false), "");
  assert.equal(buildEngineeringStandardsBlock(undefined, true), "");
});

test("buildEngineeringStandardsBlock: all fields blank/whitespace-only produces nothing", () => {
  assert.equal(buildEngineeringStandardsBlock({}, true), "");
  assert.equal(
    buildEngineeringStandardsBlock({ coding: "", ux: "   ", security: undefined }, true),
    "",
  );
});

test("buildEngineeringStandardsBlock: coding + security always included, ux excluded when includeUx is false", () => {
  const block = buildEngineeringStandardsBlock(
    {
      coding: "Write clean code.",
      ux: "Be accessible.",
      security: "Never hardcode secrets.",
    },
    false,
  );
  assert.match(block, /## Engineering standards/);
  assert.match(block, /### Coding\nWrite clean code\./);
  assert.match(block, /### Security\nNever hardcode secrets\./);
  assert.doesNotMatch(block, /### UX/);
});

test("buildEngineeringStandardsBlock: ux included when includeUx is true", () => {
  const block = buildEngineeringStandardsBlock(
    {
      coding: "Write clean code.",
      ux: "Be accessible.",
      security: "Never hardcode secrets.",
    },
    true,
  );
  assert.match(block, /### UX\nBe accessible\./);
});

test("buildEngineeringStandardsBlock: only the configured fields appear", () => {
  const block = buildEngineeringStandardsBlock({ security: "Validate input." }, true);
  assert.match(block, /### Security/);
  assert.doesNotMatch(block, /### Coding/);
  assert.doesNotMatch(block, /### UX/);
});

test("buildEngineeringStandardsBlock: field text is trimmed", () => {
  const block = buildEngineeringStandardsBlock({ coding: "  Keep it simple.  \n" }, false);
  assert.match(block, /### Coding\nKeep it simple\./);
});
