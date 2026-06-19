import { randomUUID } from "node:crypto";
import type { GateResult, MergeDecision, Project, Settings, Task } from "@orc/types";
import { pickAssignedModel } from "@orc/types";
import type { AgentAdapter } from "@orc/adapters";
import type { Validator } from "./index.js";

export class ValidatorImpl implements Validator {
  constructor(
    private readonly adapterFactory: (
      modelId: string,
    ) => AgentAdapter,
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

    const adapter = this.adapterFactory(validatorModel);
    const prompt = this.buildReviewPrompt(task, gate);

    const result = await adapter.run({
      model: validatorModel,
      prompt,
      cwd: project.localPath,
      onLog: () => {},
    });

    return this.parseDecision(result.summary ?? "", task, gate, validatorModel);
  }

  private buildReviewPrompt(task: Task, gate: GateResult): string {
    return `You are a code reviewer. Grade the implementation of this task against its acceptance criteria.

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
