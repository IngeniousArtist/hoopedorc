import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DOCS_GUIDELINES,
  buildAgentsMdBlock,
  buildEngineeringStandardsBlock,
  buildSkillsBlock,
  buildTaskHandoffBlock,
} from "./guidelines.js";

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

// ── F51: lean task handoff ──

test("buildTaskHandoffBlock: ordinary descriptions produce no prompt noise", () => {
  assert.equal(buildTaskHandoffBlock("Implement the endpoint and its tests."), "");
  assert.equal(buildTaskHandoffBlock("Relevant references: docs/spec.md"), "");
});

test("buildTaskHandoffBlock: reference and capability headings add only their applicable instructions", () => {
  const references = buildTaskHandoffBlock(
    "Implement login.\n\n### Relevant references\n- docs/PRD.md — Login",
  );
  assert.match(references, /## Task handoff/);
  assert.match(references, /Open and inspect every item under `Relevant references`/);
  assert.doesNotMatch(references, /Required skills\/capabilities/);

  const capabilities = buildTaskHandoffBlock(
    "Implement login.\n\n### Required skills/capabilities\n- browser verification — test login",
  );
  assert.match(capabilities, /## Task handoff/);
  assert.match(capabilities, /Use each applicable item under `Required skills\/capabilities`/);
  assert.doesNotMatch(capabilities, /Open and inspect every item/);

  const both = buildTaskHandoffBlock(
    [
      "Implement login.",
      "### Relevant references",
      "- docs/PRD.md — Login",
      "### Required skills/capabilities",
      "- browser verification — test login",
    ].join("\n"),
  );
  assert.match(both, /Open and inspect every item/);
  assert.match(both, /if one is unavailable/);
});

// ── F38: AGENTS.md nudge ──

test("buildAgentsMdBlock: no AGENTS.md at the worktree root produces nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "hoopedorc-agentsmd-"));
  try {
    assert.equal(buildAgentsMdBlock(dir), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildAgentsMdBlock: a real AGENTS.md at the worktree root produces the nudge", () => {
  const dir = mkdtempSync(join(tmpdir(), "hoopedorc-agentsmd-"));
  try {
    writeFileSync(join(dir, "AGENTS.md"), "# Project context\n");
    const block = buildAgentsMdBlock(dir);
    assert.match(block, /## Project context/);
    assert.match(block, /Read AGENTS\.md at the repo root before starting/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
