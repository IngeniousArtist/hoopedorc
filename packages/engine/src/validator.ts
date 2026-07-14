import { randomUUID } from "node:crypto";
import type {
  GateResult,
  MergeDecision,
  ModelId,
  Project,
  Settings,
  Task,
} from "@orc/types";
import { execManagedProcess, type AgentAdapter } from "@orc/adapters";
import { buildEngineeringStandardsBlock } from "./guidelines.js";
import type { GitAcquisition, Validator } from "./index.js";

const MAX_VALIDATOR_DIFF_BYTES = 512 * 1024;

/**
 * S8: a fixed block always included in the review prompt (unlike
 * buildEngineeringStandardsBlock's operator-editable text) — the same
 * safety floor orchestrator.ts's detectDestructiveChanges enforces
 * mechanically, restated here as a second, model-judgment layer since the
 * mechanical detector's pattern list can't catch everything.
 */
const DESTRUCTIVE_CHANGES_BLOCK = `
## Destructive & dangerous changes
Before deciding your verdict, check the diff for any of the following — regardless of whether the
gates passed:
- Deleting directories or many files unrelated to what this task asked for.
- Destructive database migrations or data-wipe operations (dropping tables/databases, truncating,
  unconditional bulk deletes).
- Bulk deletion of user or production data — accounts, subscriptions, records.
- Disabling authentication, authorization, or other safety checks.
- Secrets or credentials committed into the code.
If you find any of these and the task did NOT explicitly require it, use verdict "escalate"
(never "approve") and name exactly what you found in "reasons".
`;

/** Thrown when the configured validator would review its own author's work. */
export class SelfReviewError extends Error {}

/** Reports what a validation run cost so the caller can record it. */
export type ValidatorCostSink = (
  model: ModelId,
  taskId: string,
  costUsd: number,
  tokensIn: number,
  tokensOut: number,
  tokensCached?: number,
) => void;

export class ValidatorImpl implements Validator {
  constructor(
    private readonly adapterFactory: (modelId: ModelId) => AgentAdapter,
    private readonly settingsSource: Settings | (() => Settings),
    /** Optional: record validator spend (validation runs aren't author runs,
     *  so they have no run row — without this their cost is untracked). */
    private readonly onCost?: ValidatorCostSink,
  ) {}

  private settings(): Settings {
    return typeof this.settingsSource === "function"
      ? this.settingsSource()
      : this.settingsSource;
  }

  async review(
    project: Project,
    task: Task,
    gate: GateResult,
    authorModel: ModelId,
    onLog: (line: string) => void = () => {},
    signal?: AbortSignal,
  ): Promise<MergeDecision> {
    // Model/runner/effort are resolved once immediately before this call and
    // remain stable while it is in flight. A later review sees new routing.
    const attemptSettings = this.settings();
    const validatorModel =
      attemptSettings.routing.validatorByDifficulty[task.difficulty];
    const validatorConfig = attemptSettings.models.find(
      (model) => model.id === validatorModel,
    );
    if (!validatorConfig?.enabled) {
      throw new Error(
        `Validator model "${validatorModel}" is ${validatorConfig ? "disabled" : "not configured"}.`,
      );
    }

    // Checked against authorModel (whoever actually produced this attempt —
    // may be a fallback model, not task.assignedModel) rather than re-deriving
    // from settings, which would miss a collision introduced by mid-task
    // fallback escalation.
    if (validatorModel === authorModel) {
      throw new SelfReviewError(
        `Validator model "${validatorModel}" is the same as the author model "${authorModel}". ` +
          `Self-review is forbidden.`,
      );
    }

    const cwd = task.worktreePath ?? project.localPath;
    const diff = await this.getDiff(project, cwd, signal);
    const adapter = this.adapterFactory(validatorModel);
    const prompt = this.buildReviewPrompt(task, gate, diff, attemptSettings);

    const result = await adapter.run({
      model: validatorModel,
      prompt,
      cwd,
      onLog,
      signal,
    });

    // Reported when there's anything to bill: a positive CLI-reported cost
    // OR token counts that manual per-model pricing could turn into one (an
    // opencode CLI with a stale/zero price still reports real tokens).
    if (result.costUsd > 0 || result.tokensIn + result.tokensOut > 0) {
      this.onCost?.(
        validatorModel,
        task.id,
        result.costUsd,
        result.tokensIn,
        result.tokensOut,
        result.tokensCached ?? 0,
      );
    }

    const decision = this.parseDecision(
      result.summary ?? "",
      project,
      task,
      gate,
      validatorModel,
    );

    if (!diff.ok || diff.truncated) {
      decision.verdict = "escalate";
      decision.confidence = 0;
      decision.reasons = [
        `Validator could not acquire a complete diff; human review is required${diff.error ? `: ${diff.error.slice(0, 300)}` : "."}`,
        ...decision.reasons,
      ];
    }

    // Enforce the confidence threshold: a low-confidence approval is escalated
    // to a human rather than auto-merged.
    const liveSettings = this.settings();
    if (
      decision.verdict === "approve" &&
      decision.confidence < liveSettings.confidenceThreshold
    ) {
      decision.verdict = "escalate";
      decision.reasons = [
        `Validator confidence ${decision.confidence} is below threshold ${liveSettings.confidenceThreshold}.`,
        ...decision.reasons,
      ];
    }

    return decision;
  }

  private async getDiff(
    project: Project,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<GitAcquisition<string>> {
    try {
      // Three-dot (merge-base) diff so the reviewer sees only this task's own
      // changes, not files that advanced on main since the branch was created.
      // Argument array, no shell — project.defaultBranch is HTTP-supplied.
      const { stdout: out } = await execManagedProcess(
        "git",
        ["diff", `origin/${project.defaultBranch}...HEAD`],
        { cwd, signal, maxOutputBytes: MAX_VALIDATOR_DIFF_BYTES },
      );
      return {
        ok: true,
        value: out,
        byteCount: Buffer.byteLength(out),
        truncated: false,
      };
    } catch (err) {
      if (signal?.aborted) throw err;
      const processError = err as {
        stdout?: string;
        outputLimitExceeded?: boolean;
      };
      const output = processError.stdout ?? "";
      return {
        ok: false,
        value: output,
        error: err instanceof Error ? err.message : String(err),
        byteCount: Buffer.byteLength(output),
        truncated: processError.outputLimitExceeded === true,
      };
    }
  }

  private buildReviewPrompt(
    task: Task,
    gate: GateResult,
    diff: GitAcquisition<string>,
    settings: Settings,
  ): string {
    // F31: the same text buildAuthorPrompt gave the author, so "meets the
    // standards" is checkable on both sides rather than the validator
    // grading against criteria the author was never told about.
    const standards = buildEngineeringStandardsBlock(
      settings.guidelines,
      task.role === "frontend",
      task.role === "docs",
    );
    return `You are a code reviewer. Grade the implementation of this task against its acceptance criteria, using the diff below as the primary evidence.

## Task
**Title:** ${task.title}
**Description:** ${task.description}

## Acceptance Criteria
${task.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}
${standards}
## Gate Results
| Gate | Status | Details |
|------|--------|---------|
| typecheck | ${gate.typecheck ? "PASS" : "FAIL"} | ${gate.details.typecheck ?? ""} |
| lint | ${gate.lint ? "PASS" : "FAIL"} | ${gate.details.lint ?? ""} |
| build | ${gate.build ? "PASS" : "FAIL"} | ${gate.details.build ?? ""} |
| tests | ${gate.tests ? "PASS" : "FAIL"} | ${gate.details.tests ?? ""} |
| noConflicts | ${gate.noConflicts ? "PASS" : "FAIL"} | ${gate.details.noConflicts ?? ""} |
| inScope | ${gate.inScope ? "PASS" : "FAIL"} | ${gate.details.inScope ?? ""} |

## Diff (vs default branch)
${
  !diff.ok || diff.truncated
    ? `WARNING: Diff acquisition is incomplete (${diff.error ?? "output limit reached"}). You must escalate for human review.\n`
    : ""
}
\`\`\`diff
${diff.value || "(no diff content available)"}
\`\`\`
${
  standards
    ? `\nIf the diff clearly violates the Engineering standards above, name it in "reasons" and lean toward "request_changes" for a substantive violation — but don't nitpick style choices those standards don't mention.\n`
    : ""
}
${DESTRUCTIVE_CHANGES_BLOCK}
Respond with ONLY a JSON object (no markdown, no explanation):
{
  "verdict": "approve" | "request_changes" | "escalate",
  "reasons": ["reason 1", "reason 2"],
  "confidence": 0.0 to 1.0
}`;
  }

  private parseDecision(
    raw: string,
    project: Project,
    task: Task,
    gate: GateResult,
    validatorModel: string,
  ): MergeDecision {
    let verdict: MergeDecision["verdict"] = "escalate";
    let reasons: string[] = ["could not parse validator output"];
    let confidence = 0;

    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as {
          verdict?: string;
          reasons?: string[];
          confidence?: number;
        };
        if (
          parsed.verdict === "approve" ||
          parsed.verdict === "request_changes" ||
          parsed.verdict === "escalate"
        ) {
          verdict = parsed.verdict;
        }
        if (Array.isArray(parsed.reasons) && parsed.reasons.length > 0) {
          reasons = parsed.reasons;
        }
        if (typeof parsed.confidence === "number") {
          confidence = Math.max(0, Math.min(1, parsed.confidence));
        }
      } else {
        reasons = [raw.trim().slice(0, 500)];
      }
    } catch {
      reasons = [raw.trim().slice(0, 500)];
    }

    return {
      id: randomUUID(),
      projectId: project.id,
      taskId: task.id,
      runId: `run-${task.id}-${task.attempts}`,
      validatorModel: validatorModel as MergeDecision["validatorModel"],
      verdict,
      reasons,
      confidence,
      gate,
      ts: new Date().toISOString(),
    };
  }
}
