import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, api } from "../api/client";
import { ToastProvider } from "../hooks/useToast";
import { projectFixture, settingsFixture } from "../test/fixtures";
import { PlanView } from "./PlanView";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: vi.fn(), apiUpload: vi.fn() };
});
vi.mock("../hooks/useWS", () => ({ useWS: () => {} }));

type ApiOptions = { params?: Record<string, string>; body?: unknown } | undefined;

const apiMock = vi.mocked(api);
const project = { ...projectFixture, status: "paused" as const };
const revisionId = "11111111-1111-4111-8111-111111111111";
const inspection = {
  state: "existing" as const,
  inspectedAt: "2026-09-21T10:00:00.000Z",
  branch: "main",
  commit: "abcdef0123456789abcdef0123456789abcdef01",
  trackedFileCount: 12,
  stack: ["node", "typescript"],
  packageScripts: ["build", "test"],
};
const draft = {
  title: "Build login",
  description: "Implement login.",
  difficulty: "medium" as const,
  acceptanceCriteria: ["Login works."],
  dependsOn: [],
  scopePaths: ["apps/web/**"],
  assignedModel: "codex",
};

function baseApi(key: string, options: ApiOptions) {
  void options;
  if (key === "getProject") return { project };
  if (key === "getSettings") return { settings: settingsFixture() };
  if (key === "listPlanAttachments") return { attachments: [] };
  if (key === "planSessionArchives") return { sessions: [] };
  throw new Error(`Unexpected API call: ${key}`);
}

function renderPlan() {
  render(
    <ToastProvider>
      <PlanView projectId={project.id} onDone={vi.fn()} saveDebounceMs={0} />
    </ToastProvider>,
  );
}

describe("VW03: PlanView shows what planning is grounded on", () => {
  beforeEach(() => {
    apiMock.mockReset();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
  });

  it("restores the recorded repository inspection and updates it from a chat turn", async () => {
    apiMock.mockImplementation(async (key, options) => {
      if (key === "planSession") {
        return { revisionId, messages: [], planCostUsd: 0, repository: inspection };
      }
      if (key === "planChat") {
        return {
          reply: "Noted. [PLAN_COMPLETE]",
          costUsd: 0,
          repository: { ...inspection, state: "empty", stack: [], packageScripts: undefined },
        };
      }
      return baseApi(key, options);
    });
    renderPlan();

    const line = await screen.findByTestId("repository-inspection");
    expect(line).toHaveTextContent(
      "Planning against the existing codebase · main @ abcdef0 · node, typescript · npm scripts: build, test",
    );
    expect(line).toHaveAttribute("title", "Inspected 2026-09-21T10:00:00.000Z");

    await userEvent.type(screen.getByLabelText("Planning message"), "Start over");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Noted.")).toBeVisible();
    expect(screen.getByTestId("repository-inspection")).toHaveTextContent(
      "Empty repository — the first task will scaffold it · main @ abcdef0",
    );
  });

  it("does not show a repository line when nothing was inspected yet", async () => {
    apiMock.mockImplementation(async (key, options) => {
      if (key === "planSession") return { revisionId, messages: [], planCostUsd: 0 };
      return baseApi(key, options);
    });
    renderPlan();
    expect(await screen.findByLabelText("Planning message")).toBeVisible();
    expect(screen.queryByTestId("repository-inspection")).not.toBeInTheDocument();
  });

  it("surfaces an unavailable repository as the failed turn's error with retry", async () => {
    let chatCalls = 0;
    apiMock.mockImplementation(async (key, options) => {
      if (key === "planSession") return { revisionId, messages: [], planCostUsd: 0 };
      if (key === "planChat") {
        chatCalls += 1;
        if (chatCalls === 1) {
          throw new ApiRequestError(
            "the project repository could not be reached or read (fetch: offline); planning did not run — fix access to the repository and retry",
            503,
            "REPOSITORY_UNAVAILABLE",
          );
        }
        return { reply: "Back online. [PLAN_COMPLETE]", costUsd: 0, repository: inspection };
      }
      return baseApi(key, options);
    });
    renderPlan();

    await userEvent.type(await screen.findByLabelText("Planning message"), "Add tests");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be reached or read/);
    expect(screen.getByTestId("pending-turn")).toHaveTextContent("Add tests");
    expect(screen.queryByTestId("repository-inspection")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Retry send" }));
    expect(await screen.findByText("Back online.")).toBeVisible();
    expect(screen.getByTestId("repository-inspection")).toHaveTextContent("main @ abcdef0");
    expect(chatCalls).toBe(2);
  });

  it("refuses a drifted commit with a disclosure, keeps the draft, and approves only when acknowledged", async () => {
    const commitBodies: Array<{ acknowledgeRepositoryDrift?: boolean; tasks: Array<{ title: string }> }> = [];
    apiMock.mockImplementation(async (key, options) => {
      if (key === "planSession") {
        return {
          revisionId,
          messages: [],
          prd: "# Plan",
          draftTasks: [draft],
          planCostUsd: 0,
          repository: inspection,
        };
      }
      if (key === "planSaveDraft") return { ok: true };
      if (key === "planCommit") {
        const body = options?.body as { acknowledgeRepositoryDrift?: boolean; tasks: Array<{ title: string }> };
        commitBodies.push(body);
        if (!body.acknowledgeRepositoryDrift) {
          throw new ApiRequestError(
            "the repository moved from abcdef0 to 9876543 since this plan was drafted — re-generate the task table against the current code, or approve anyway to apply the plan as drafted",
            409,
            "REPOSITORY_DRIFT",
            {
              plannedCommit: inspection.commit,
              currentCommit: "9876543210fedcba9876543210fedcba98765432",
            },
          );
        }
        return {
          revisionId,
          project: { ...project, status: "planned" },
          tasks: [{ title: "Build login" }],
          prdMarkdown: "# Plan",
        };
      }
      return baseApi(key, options);
    });
    renderPlan();

    expect(await screen.findByDisplayValue("Build login")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Approve & Create Tasks" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The repository changed since this plan was drafted");
    expect(alert).toHaveTextContent("Planned against abcdef0; the clone is now at 9876543");
    expect(alert).toHaveTextContent("Nothing was committed");
    expect(screen.getByDisplayValue("Build login")).toBeVisible();
    expect(screen.queryByText(/Error/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Re-generate task table" })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "Approve anyway" }));
    expect(await screen.findByText("1 tasks created")).toBeVisible();
    expect(commitBodies.map((body) => body.acknowledgeRepositoryDrift)).toEqual([undefined, true]);
    expect(commitBodies[1]?.tasks[0]?.title).toBe("Build login");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
