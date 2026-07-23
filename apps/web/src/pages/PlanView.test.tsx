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
vi.mock("../hooks/useWS", () => ({ useWS: vi.fn() }));

const apiMock = vi.mocked(api);
const project = { ...projectFixture, status: "created" as const };
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
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
  });

  it("restores and shows verified frame identity, viewport, and runner", async () => {
    apiMock.mockImplementation(async (key) => {
      if (key === "planSession") {
        return {
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
});
