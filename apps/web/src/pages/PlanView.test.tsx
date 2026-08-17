import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, api } from "../api/client";
import { ToastProvider } from "../hooks/useToast";
import { projectFixture, settingsFixture } from "../test/fixtures";
import { PlanView } from "./PlanView";

const wsState = vi.hoisted(() => ({
  handler: undefined as
    | ((event: import("@orc/types").ServerEvent) => void)
    | undefined,
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: vi.fn(), apiUpload: vi.fn() };
});
vi.mock("../hooks/useWS", () => ({
  useWS: (
    _projectId: string,
    handler: (event: import("@orc/types").ServerEvent) => void,
  ) => {
    wsState.handler = handler;
  },
}));

const apiMock = vi.mocked(api);
const project = { ...projectFixture, status: "created" as const };
const revisionId = "11111111-1111-4111-8111-111111111111";
const reference = {
  canonicalUrl:
    "https://www.figma.com/design/File123/Login?node-id=10-20",
  fileKey: "File123",
  nodeId: "10:20",
  name: "Login desktop",
  fileName: "Product",
  width: 1440,
  height: 900,
  verifiedModel: "codex",
  verifiedRunner: "codex" as const,
  verifiedAt: "2026-07-23T12:00:00.000Z",
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
const visualDraft = {
  title: "Visual fidelity QA",
  description:
    `Run the real app and compare ${reference.canonicalUrl} in a browser.`,
  difficulty: "hard" as const,
  role: "frontend" as const,
  acceptanceCriteria: ["Capture and repair the verified screen."],
  dependsOn: [0],
  scopePaths: ["apps/web/**"],
  assignedModel: "codex",
};

function renderPlan() {
  render(
    <ToastProvider>
      <PlanView projectId={project.id} onDone={vi.fn()} />
    </ToastProvider>,
  );
}

function baseApi(key: string) {
  if (key === "getProject") return { project };
  if (key === "getSettings") return { settings: settingsFixture() };
  if (key === "listPlanAttachments") return { attachments: [] };
  if (key === "planSessionArchives") return { sessions: [] };
  throw new Error(`Unexpected API call: ${key}`);
}

describe("PlanView Figma verification", () => {
  beforeEach(() => {
    apiMock.mockReset();
    wsState.handler = undefined;
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
  });

  it("restores and shows verified frame identity, viewport, and runner", async () => {
    apiMock.mockImplementation(async (key) => {
      if (key === "planSession") {
        return {
          revisionId,
          messages: [],
          planCostUsd: 0.04,
          verifiedFigmaReferences: [reference],
        };
      }
      return baseApi(key);
    });
    renderPlan();

    expect(await screen.findByText("Verified Figma screens")).toBeVisible();
    expect(screen.getByRole("link", { name: "Login desktop" })).toHaveAttribute(
      "href",
      reference.canonicalUrl,
    );
    expect(screen.getByText(/node 10:20 · 1440×900/)).toBeVisible();
    expect(screen.getByText("codex / codex")).toBeVisible();
  });

  it("keeps the draft, explains a capability issue, and retries in the same session", async () => {
    let deconstructCalls = 0;
    apiMock.mockImplementation(async (key) => {
      if (key === "planSession") {
        return {
          revisionId,
          messages: [
            { role: "user", content: `Match ${reference.canonicalUrl}` },
            { role: "assistant", content: "Ready. [PLAN_COMPLETE]" },
          ],
          prd: "# Existing draft",
          draftTasks: [draft],
          agentsMd: "# Existing agents",
          planCostUsd: 0,
        };
      }
      if (key === "planSaveDraft") return { ok: true };
      if (key === "planDeconstruct") {
        deconstructCalls += 1;
        if (deconstructCalls === 1) {
          throw new ApiRequestError(
            "Figma auth required",
            409,
            "FIGMA_VERIFICATION_FAILED",
            {
              issue: {
                stage: "deconstruction",
                code: "figma_auth_required",
                model: "codex",
                runner: "codex",
                message: "The selected runner's Figma MCP needs authentication.",
                actions: [
                  "Fix or re-authenticate Figma MCP for this runner, then retry.",
                  "Select another model.",
                  "Attach screenshots.",
                ],
                nodeId: "10:20",
              },
              costUsd: 0.02,
            },
          );
        }
        return {
          prdMarkdown: "# Verified",
          agentsMd: "# Agents",
          tasks: [draft],
          costUsd: 0.04,
          verifiedFigmaReferences: [reference],
        };
      }
      return baseApi(key);
    });
    const user = userEvent.setup();
    renderPlan();

    expect(await screen.findByDisplayValue("Build login")).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Re-generate task table" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Figma verification needs attention",
    );
    expect(screen.getByDisplayValue("Build login")).toBeVisible();
    expect(screen.getByText("codex / codex")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Use attachments instead" }),
    ).toBeDisabled();

    await user.click(
      screen.getByRole("button", { name: "Retry verification" }),
    );
    expect(await screen.findByText("Verified Figma screens")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(deconstructCalls).toBe(2);
  });

  it("shows the generated visual task and preserves its role when the model is edited", async () => {
    let committedTasks: Array<Record<string, unknown>> = [];
    apiMock.mockImplementation(async (key, options) => {
      if (key === "getSettings") {
        const settings = settingsFixture();
        settings.models.push({
          ...settings.models[0]!,
          id: "glm",
          displayName: "GLM",
          runner: "opencode",
          opencodeModel: "zai-coding-plan/glm-5.2",
        });
        return { settings };
      }
      if (key === "planSession") {
        return {
          revisionId,
          messages: [],
          prd: "# Visual plan",
          draftTasks: [draft, visualDraft],
          planCostUsd: 0,
          verifiedFigmaReferences: [reference],
        };
      }
      if (key === "planSaveDraft") return { ok: true };
      if (key === "planCommit") {
        const body = options?.body as {
          revisionId: string;
          tasks: Array<Record<string, unknown>>;
        };
        expect(body.revisionId).toBe(revisionId);
        committedTasks = body.tasks;
        return {
          revisionId,
          project: { ...project, status: "planned" },
          tasks: [],
          prdMarkdown: "# Visual plan",
        };
      }
      return baseApi(key);
    });
    const user = userEvent.setup();
    renderPlan();

    expect(
      await screen.findByDisplayValue("Visual fidelity QA"),
    ).toBeVisible();
    await user.selectOptions(
      screen.getByLabelText("Assigned model for Visual fidelity QA"),
      "glm",
    );
    await user.click(
      screen.getByRole("button", { name: "Approve & Create Tasks" }),
    );

    await waitFor(() => expect(committedTasks).toHaveLength(2));
    expect(committedTasks[1]).toMatchObject({
      title: "Visual fidelity QA",
      role: "frontend",
      assignedModel: "glm",
    });
  });

  it("keeps explicit visual-QA removal through commit instead of re-adding it", async () => {
    let committedTasks: Array<Record<string, unknown>> = [];
    apiMock.mockImplementation(async (key, options) => {
      if (key === "planSession") {
        return {
          revisionId,
          messages: [],
          prd: "# Visual plan",
          draftTasks: [draft, visualDraft],
          planCostUsd: 0,
          verifiedFigmaReferences: [reference],
        };
      }
      if (key === "planSaveDraft") return { ok: true };
      if (key === "planCommit") {
        const body = options?.body as {
          revisionId: string;
          tasks: Array<Record<string, unknown>>;
        };
        expect(body.revisionId).toBe(revisionId);
        committedTasks = body.tasks;
        return {
          revisionId,
          project: { ...project, status: "planned" },
          tasks: [],
          prdMarkdown: "# Visual plan",
        };
      }
      return baseApi(key);
    });
    const user = userEvent.setup();
    renderPlan();

    expect(
      await screen.findByDisplayValue("Visual fidelity QA"),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Remove Visual fidelity QA" }),
    );
    expect(
      screen.queryByDisplayValue("Visual fidelity QA"),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Approve & Create Tasks" }),
    );

    await waitFor(() => expect(committedTasks).toHaveLength(1));
    expect(
      committedTasks.some((task) => task.title === "Visual fidelity QA"),
    ).toBe(false);
  });

  it("retries a lost commit response with the same server-issued revision", async () => {
    const submittedRevisions: string[] = [];
    let commitCalls = 0;
    apiMock.mockImplementation(async (key, options) => {
      if (key === "planSession") {
        return {
          revisionId,
          messages: [],
          prd: "# Retry plan",
          draftTasks: [draft],
          planCostUsd: 0,
        };
      }
      if (key === "planSaveDraft") return { ok: true };
      if (key === "planCommit") {
        commitCalls += 1;
        submittedRevisions.push(
          (options?.body as { revisionId: string }).revisionId,
        );
        if (commitCalls === 1) throw new Error("commit response was lost");
        return {
          revisionId,
          project: { ...project, status: "planned" },
          tasks: [],
          prdMarkdown: "# Retry plan",
        };
      }
      return baseApi(key);
    });
    const user = userEvent.setup();
    renderPlan();

    expect(await screen.findByDisplayValue("Build login")).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Approve & Create Tasks" }),
    );
    expect(await screen.findByText(/commit response was lost/)).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "Approve & Create Tasks" }),
    );
    expect(await screen.findByText("0 tasks created")).toBeVisible();
    expect(submittedRevisions).toEqual([revisionId, revisionId]);
  });

  it("unlocks planning from the authoritative project reconnect snapshot", async () => {
    const runningProject = { ...project, status: "running" as const };
    apiMock.mockImplementation(async (key) => {
      if (key === "getProject") return { project: runningProject };
      if (key === "planSession") {
        return {
          revisionId,
          messages: [],
          planCostUsd: 0,
        };
      }
      return baseApi(key);
    });
    renderPlan();

    expect(
      await screen.findByText(/Tasks are running — planning re-opens/),
    ).toBeVisible();
    act(() => {
      wsState.handler?.({
        type: "projects.snapshot",
        payload: { projects: [{ ...runningProject, status: "paused" }] },
      });
    });

    expect(await screen.findByLabelText("Planning message")).toBeVisible();
    expect(
      screen.queryByText(/Tasks are running — planning re-opens/),
    ).not.toBeInTheDocument();
  });

  it("does not let an older getProject response overwrite a newer reconnect status", async () => {
    const runningProject = { ...project, status: "running" as const };
    let resolveProject!: (value: { project: typeof runningProject }) => void;
    const projectRead = new Promise<{ project: typeof runningProject }>(
      (resolve) => {
        resolveProject = resolve;
      },
    );
    apiMock.mockImplementation(async (key) => {
      if (key === "getProject") return projectRead;
      if (key === "planSession") {
        return {
          revisionId,
          messages: [],
          planCostUsd: 0,
        };
      }
      return baseApi(key);
    });
    renderPlan();
    await waitFor(() => expect(wsState.handler).toBeDefined());

    act(() => {
      wsState.handler?.({
        type: "projects.snapshot",
        payload: { projects: [{ ...runningProject, status: "paused" }] },
      });
    });

    await act(async () => {
      resolveProject({ project: runningProject });
      await projectRead;
    });

    expect(await screen.findByLabelText("Planning message")).toBeVisible();
    expect(
      screen.queryByText(/Tasks are running — planning re-opens/),
    ).not.toBeInTheDocument();
  });
});
