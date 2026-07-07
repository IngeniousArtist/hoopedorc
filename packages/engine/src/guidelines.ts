import type { Settings } from "@orc/types";

/**
 * F29: documentation standards for docs-role work (the standing "Project
 * documentation" task every project gets, and F30's per-task documenter).
 * A product opinion, not an operator-editable Settings field — three
 * editable textareas (F31) is already enough surface, and README/CHANGELOG
 * conventions aren't the kind of thing that varies per operator the way
 * coding/UX/security house rules do.
 */
export const DOCS_GUIDELINES = `- README: lead with what the project does and who it's for, in plain language. Then a quickstart with the exact commands — verified against package.json, never invented — a real usage example, a configuration table, and troubleshooting.
- No fabricated badges, links, or claims about features that don't exist yet; check the actual code before asserting anything.
- CHANGELOG: Keep a Changelog shape (\`## [version] - date\`, grouped Added/Changed/Fixed), newest first; entries describe user-visible behavior, not commit messages.
- Helper docs (docs/**): only when a topic outgrows the README (API reference, architecture). Say when each doc was last true; cross-link instead of duplicating content.`;

/**
 * F31: renders Settings.guidelines (plus F29's fixed docs guidelines) into
 * a "## Engineering standards" prompt block — coding + security always
 * included, ux only when `includeUx` (the task looks UI-flavored:
 * `task.role === "frontend"`), docs only when `includeDocs`
 * (`task.role === "docs"`) — both kept exactly that simple. Used by both
 * `orchestrator.ts`'s author prompt and `validator.ts`'s review prompt
 * (kept in its own module, not either of theirs, so neither has to import
 * from the other) — the author is told the standards up front, and the
 * validator grades against the exact same text, so "meets the standards"
 * is a checkable claim rather than vibes. Returns "" when there's nothing
 * to say — a fresh install with all three Settings fields blank (or
 * Settings.guidelines entirely unset) and a non-docs task leaves the
 * prompt byte-identical to before this feature existed.
 */
export function buildEngineeringStandardsBlock(
  guidelines: Settings["guidelines"] | undefined,
  includeUx: boolean,
  includeDocs = false,
): string {
  const sections: string[] = [];
  if (guidelines?.coding?.trim()) sections.push(`### Coding\n${guidelines.coding.trim()}`);
  if (includeUx && guidelines?.ux?.trim()) sections.push(`### UX\n${guidelines.ux.trim()}`);
  if (guidelines?.security?.trim()) sections.push(`### Security\n${guidelines.security.trim()}`);
  if (includeDocs) sections.push(`### Docs\n${DOCS_GUIDELINES}`);
  if (sections.length === 0) return "";
  return `\n## Engineering standards\n${sections.join("\n\n")}\n`;
}
