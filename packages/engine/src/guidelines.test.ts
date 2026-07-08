import assert from "node:assert/strict";
import { test } from "node:test";
import { DOCS_GUIDELINES, buildEngineeringStandardsBlock, buildSkillsBlock } from "./guidelines.js";

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

// ── F29: docs guidelines ──

test("buildEngineeringStandardsBlock: docs section excluded by default", () => {
  const block = buildEngineeringStandardsBlock({ coding: "Write clean code." }, false);
  assert.doesNotMatch(block, /### Docs/);
});

test("buildEngineeringStandardsBlock: docs section included when includeDocs is true", () => {
  const block = buildEngineeringStandardsBlock({ coding: "Write clean code." }, false, true);
  assert.match(block, /### Docs/);
  assert.match(block, /Keep a Changelog shape/);
});

test("buildEngineeringStandardsBlock: docs section appears even with no Settings.guidelines at all", () => {
  // DOCS_GUIDELINES is a fixed engine constant, not operator-editable — it
  // must show up for a docs-role task even on a fresh install with no
  // guidelines configured at all.
  const block = buildEngineeringStandardsBlock(undefined, false, true);
  assert.match(block, /## Engineering standards/);
  assert.match(block, /### Docs/);
  assert.doesNotMatch(block, /### Coding/);
  assert.doesNotMatch(block, /### Security/);
});

test("DOCS_GUIDELINES covers README, CHANGELOG, and helper docs", () => {
  assert.match(DOCS_GUIDELINES, /README/);
  assert.match(DOCS_GUIDELINES, /CHANGELOG/i);
  assert.match(DOCS_GUIDELINES, /package\.json/);
});

// ── F34: skill hints ──

test("buildSkillsBlock: undefined/empty skillHints produces nothing", () => {
  assert.equal(buildSkillsBlock(undefined), "");
  assert.equal(buildSkillsBlock([]), "");
});

test("buildSkillsBlock: renders each hint as a bullet under a Skills header", () => {
  const block = buildSkillsBlock([
    "frontend-design-guidelines — read before building any UI component",
    "security-review — run before touching auth code",
  ]);
  assert.match(block, /## Skills/);
  assert.match(block, /- frontend-design-guidelines — read before building any UI component/);
  assert.match(block, /- security-review — run before touching auth code/);
});
