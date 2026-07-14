import { existsSync } from "node:fs";
import { join } from "node:path";
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
 * S8: a fixed, non-operator-editable safety floor appended to EVERY author
 * prompt unconditionally — unlike Settings.guidelines (F31), this isn't a
 * house-style preference the operator can blank out; it's the same
 * non-bypassable line orchestrator.ts's detectDestructiveChanges enforces
 * mechanically after the fact, restated here so the author is told up
 * front instead of only finding out once its PR gets held for approval.
 */
export const SAFETY_GUARDRAILS_BLOCK = `
## Safety
- Never delete files or directories unrelated to this task.
- Never write destructive database migrations, data-wipe scripts, or bulk deletions of records
  unless the task explicitly requires it.
- Prefer additive changes over deletions or rewrites when both accomplish the task.
- Never touch credentials, secrets, or auth/authorization checks unless the task explicitly asks
  you to.
`;

/**
 * B33: tells the author it's in a dedicated git worktree, not a shared
 * directory. Root cause: an "Author produced no changes in the worktree"
 * failure was previously undiagnosable — it could mean a weak model ran
 * out of steps, or the agent genuinely wrote somewhere else (this fixed a
 * real instance of the latter for opencode's `--attach` path — see
 * `OpenCodeAdapter`). This prompt line doesn't fix that class of bug on
 * its own, but gives every model the context to avoid writing outside its
 * assigned directory in the first place.
 */
export const WORKING_DIRECTORY_BLOCK = `
## Working Directory
Implement all changes in the current working directory — it is a dedicated git worktree for
this task. Never \`cd\` elsewhere or write files using an absolute path outside it. Before
finishing, run \`git status\` and confirm the files you created/modified actually appear.
`;

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

/**
 * F34: renders a project's `ProjectConfig.skillHints` into a "## Skills"
 * author-prompt block — a nudge, not a mechanism. Claude Code discovers
 * skills on its own (user-level `~/.claude/skills/` or the target repo's own
 * `.claude/skills/`) but only *uses* one reliably when the task at hand is
 * explicitly pointed at it; other runners have no skills concept at all, so
 * for them this just reads as ordinary instructions (harmless, often still
 * useful). Returns "" when there are no hints — an unset/empty project
 * leaves the author prompt byte-identical to before this feature existed.
 */
export function buildSkillsBlock(skillHints: string[] | undefined): string {
  if (!skillHints || skillHints.length === 0) return "";
  return (
    `\n## Skills\nThe following skills are available in this environment; invoke each ` +
    `when its condition applies:\n${skillHints.map((h) => `- ${h}`).join("\n")}\n`
  );
}

/**
 * F38: nudges the author to read a generated AGENTS.md at the repo root
 * before starting, when one exists. codex/opencode discover AGENTS.md
 * natively and Claude Code sees it via a committed CLAUDE.md `@AGENTS.md`
 * import — this line is a belt-and-suspenders reminder for whichever runner
 * needs prompting to actually read it, F34-skills-style. Returns "" for a
 * project with no AGENTS.md at all (e.g. one planned before F38, or one
 * whose planning never ran through deconstruct) — an unchanged prompt.
 */
export function buildAgentsMdBlock(worktreePath: string): string {
  if (!existsSync(join(worktreePath, "AGENTS.md"))) return "";
  return (
    `\n## Project context\nRead AGENTS.md at the repo root before starting — it defines ` +
    `this project's structure and conventions.\n`
  );
}
