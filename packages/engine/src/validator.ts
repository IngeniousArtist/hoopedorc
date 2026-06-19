import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  GateResult,
  MergeDecision,
  ModelId,
  Project,
  Settings,
  Task,
} from "@orc/types";
import { pickAssignedModel } from "@orc/types";
import type { AgentAdapter } from "@orc/adapters";
import type { Validator } from "./index.js";

const MAX_DIFF_CHARS = 40_000;

export class ValidatorImpl implements Validator {
  constructor(
    private readonly adapterFactory: (modelId: ModelId) => AgentAdapter,
    private readonly settings: Settings,
  ) {}

  async review(
    project: Project,
    task: Task,
    gate: GateResult,
  ): Promise<MergeDecision> {
    const validatorModel =
      this.settings.routing.validatorByDifficulty[task.difficulty];

    const authorModel = pickAssignedModel(
      this.settings.routing,
      task.difficulty,
      task.role,
    );

    if (validatorModel === task.assignedModel) {
      throw new Error(
        `Validator model "${validatorModel}" is the same as the author model "${task.assignedModel}". ` +
          `Self-review is forbidden.`,
      );
    }

    if (validatorModel === authorModel) {
      throw new Error(
        `Validator model "${validatorModel}" matches the resolved author model "${authorModel}". ` +
          `Self-review is forbidden.`,
      );
    }

    const cwd = task.worktreePath ?? project.localPath;
    const diff = this.getDiff(project, cwd);
    const adapter = this.adapterFactory(validatorModel);
    const prompt = this.buildReviewPrompt(task, gate, diff);

    const result = await adapter.run({
      model: validatorModel,
      prompt,
      cwd,
      onLog: () => {},
    });

    const decision = this.parseDecision(
      result.summary ?? "",
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

  private getDiff(project: Project, cwd: string): string {
    try {
      const out = execSync(
        `git diff origin/${project.defaultBranch} HEAD`,
        { cwd, stdio: "pipe", encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
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
      taskId: task.id,
      runId: "",
      validatorModel: validatorModel as MergeDecision["validatorModel"],
      verdict,
      reasons,
      confidence,
      gate,
      ts: new Date().toISOString(),
    };
  }
}
