import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type {
  GateResult,
  MergeDecision,
  ModelId,
  Project,
  Settings,
  Task,
} from "@orc/types";
import type { AgentAdapter } from "@orc/adapters";
import type { Validator } from "./index.js";

const pexecFile = promisify(execFile);

const MAX_DIFF_CHARS = 40_000;

/** Thrown when the configured validator would review its own author's work. */
export class SelfReviewError extends Error {}

/** Reports what a validation run cost so the caller can record it. */
export type ValidatorCostSink = (
  model: ModelId,
  taskId: string,
  costUsd: number,
  tokensIn: number,
  tokensOut: number,
) => void;

export class ValidatorImpl implements Validator {
  constructor(
    private readonly adapterFactory: (modelId: ModelId) => AgentAdapter,
    private readonly settings: Settings,
    /** Optional: record validator spend (validation runs aren't author runs,
     *  so they have no run row — without this their cost is untracked). */
    private readonly onCost?: ValidatorCostSink,
  ) {}

  async review(
    project: Project,
    task: Task,
    gate: GateResult,
    authorModel: ModelId,
    onLog: (line: string) => void = () => {},
  ): Promise<MergeDecision> {
    const validatorModel =
      this.settings.routing.validatorByDifficulty[task.difficulty];

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
    const diff = await this.getDiff(project, cwd);
    const adapter = this.adapterFactory(validatorModel);
    const prompt = this.buildReviewPrompt(task, gate, diff);

    const result = await adapter.run({
      model: validatorModel,
      prompt,
      cwd,
      onLog,
    });

    if (result.costUsd > 0) {
      this.onCost?.(
        validatorModel,
        task.id,
        result.costUsd,
        result.tokensIn,
        result.tokensOut,
      );
    }

    const decision = this.parseDecision(
      result.summary ?? "",
      project,
      task,
      gate,
      validatorModel,
    );

    // Enforce the confidence threshold: a low-confidence approval is escalated
    // to a human rather than auto-merged.
    if (
      decision.verdict === "approve" &&
      decision.confidence < this.settings.confidenceThreshold
    ) {
      decision.verdict = "escalate";
      decision.reasons = [
        `Validator confidence ${decision.confidence} is below threshold ${this.settings.confidenceThreshold}.`,
        ...decision.reasons,
      ];
    }

    return decision;
  }

  private async getDiff(project: Project, cwd: string): Promise<string> {
    try {
      // Three-dot (merge-base) diff so the reviewer sees only this task's own
      // changes, not files that advanced on main since the branch was created.
      // Argument array, no shell — project.defaultBranch is HTTP-supplied.
      const { stdout: out } = await pexecFile(
        "git",
        ["diff", `origin/${project.defaultBranch}...HEAD`],
        { cwd, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
      );
      return out.length > MAX_DIFF_CHARS
        ? out.slice(0, MAX_DIFF_CHARS) + "\n... (diff truncated)"
        : out;
    } catch {
      return "(could not compute diff)";
    }
  }

  private buildReviewPrompt(task: Task, gate: GateResult, diff: string): string {
    return `You are a code reviewer. Grade the implementation of this task against its acceptance criteria, using the diff below as the primary evidence.

## Task
**Title:** ${task.title}
**Description:** ${task.description}

## Acceptance Criteria
${task.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}

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
\`\`\`diff
${diff}
\`\`\`

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
