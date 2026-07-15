import type { HealthResponse, ModelConfig, Notification, Project, Settings, Task } from "@orc/types";

export const modelFixture: ModelConfig = {
  id: "codex",
  displayName: "Codex",
  runner: "codex",
  codexModel: "gpt-5.2-codex",
  roles: ["planner", "frontend", "validator"],
  enabled: true,
  maxConcurrent: 1,
};

export function settingsFixture(): Settings {
  return {
    models: [{ ...modelFixture, roles: [...modelFixture.roles] }],
    routing: {
      planner: "codex",
      byDifficulty: { easy: "codex", medium: "codex", hard: "codex" },
      byRole: {},
      validatorByDifficulty: { easy: "codex", medium: "codex", hard: "codex" },
    },
    mergePolicy: "hard_gate_flag_risky",
    riskyChangeRules: {
      dbSchema: true,
      newDependencies: true,
      authOrSecrets: true,
      outOfScopeEdits: true,
      destructiveChanges: true,
    },
    allowVacuousGates: false,
    onboardedAt: "2026-07-15T00:00:00.000Z",
    confidenceThreshold: 0.8,
    guidelines: { coding: "Test code.", ux: "Test UX.", security: "Test security." },
    sandboxGates: "auto",
    holdWhileAwaitingApproval: false,
    telegram: { enabled: false, digest: "terminal", modelAlerts: true },
  };
}

export const healthFixture: HealthResponse = {
  ok: true,
  mock: true,
  version: "0.6.0",
  state: "running",
  degraded: [],
  dependencies: {
    docker: { available: false, required: false, detail: "Optional in tests" },
    telegram: { enabled: false, running: false, state: "disabled" },
  },
};

export const projectFixture: Project = {
  id: "proj-test",
  name: "Test project",
  repoUrl: "https://github.com/example/test",
  defaultBranch: "main",
  localPath: "/tmp/test-project",
  status: "running",
  createdAt: "2026-07-15T00:00:00.000Z",
  updatedAt: "2026-07-15T00:00:00.000Z",
};

export const taskFixture: Task = {
  id: "task-test",
  projectId: projectFixture.id,
  title: "Failed test task",
  description: "A task used by the frontend suite.",
  difficulty: "medium",
  status: "failed",
  dependsOn: [],
  acceptanceCriteria: ["Can be retried"],
  assignedModel: modelFixture.id,
  scopePaths: ["apps/web/**"],
  attempts: 1,
  maxAttempts: 3,
  prNumber: 42,
  createdAt: "2026-07-15T00:00:00.000Z",
  updatedAt: "2026-07-15T00:00:00.000Z",
};

export const notificationFixture: Notification = {
  id: "notification-test",
  projectId: projectFixture.id,
  taskId: taskFixture.id,
  severity: "action_required",
  title: "Approval needed: Failed test task",
  message: "A risky change needs an explicit decision.",
  requiresApproval: true,
  options: ["approve", "reject"],
  createdAt: "2026-07-15T00:00:00.000Z",
};
