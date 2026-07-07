import type { Settings } from "@orc/types";

/**
 * F31: renders Settings.guidelines into a "## Engineering standards" prompt
 * block — coding + security always included, ux only when `includeUx` (the
 * task looks UI-flavored: `task.role === "frontend"`, kept exactly that
 * simple). Used by both `orchestrator.ts`'s author prompt and
 * `validator.ts`'s review prompt (kept in its own module, not either of
 * theirs, so neither has to import from the other) — the author is told the
 * standards up front, and the validator grades against the exact same text,
 * so "meets the standards" is a checkable claim rather than vibes. Returns
 * "" when there's nothing to say — a fresh install with all three fields
 * blank (or Settings.guidelines entirely unset) leaves every prompt
 * byte-identical to before this feature existed.
 */
export function buildEngineeringStandardsBlock(
  guidelines: Settings["guidelines"] | undefined,
  includeUx: boolean,
): string {
  if (!guidelines) return "";
  const sections: string[] = [];
  if (guidelines.coding?.trim()) sections.push(`### Coding\n${guidelines.coding.trim()}`);
  if (includeUx && guidelines.ux?.trim()) sections.push(`### UX\n${guidelines.ux.trim()}`);
  if (guidelines.security?.trim()) sections.push(`### Security\n${guidelines.security.trim()}`);
  if (sections.length === 0) return "";
  return `\n## Engineering standards\n${sections.join("\n\n")}\n`;
}
