import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { PlanningOperation } from "@orc/types";
import { api, ApiRequestError } from "../api/client";
import { ToastProvider } from "../hooks/useToast";
import { projectFixture, settingsFixture } from "../test/fixtures";
import { PlanView } from "./PlanView";

vi.mock("../api/client", async (original) => ({ ...await original<typeof import("../api/client")>(), api: vi.fn(), apiUpload: vi.fn() }));
vi.mock("../hooks/useWS", () => ({ useWS: () => {} }));
const apiMock = vi.mocked(api);
const project = { ...projectFixture, status: "paused" as const };
const revisionId = "11111111-1111-4111-8111-111111111111";
const active: PlanningOperation = {
  id: "22222222-2222-4222-8222-222222222222", projectId: project.id, revisionId,
  kind: "chat", state: "running", input: { revisionId, sessionVersion: 0, messages: [{ role: "user", content: "Keep working while I leave" }] },
  createdAt: "2026-09-21T00:00:00Z", invocationIds: ["call-1"],
};
function base(key: string) {
  if (key === "getProject") return { project };
  if (key === "getSettings") return { settings: settingsFixture() };
  if (key === "listPlanAttachments") return { attachments: [] };
  if (key === "planSessionArchives") return { sessions: [] };
  throw new Error(`Unexpected ${key}`);
}
function view() { return <ToastProvider><PlanView projectId={project.id} onDone={vi.fn()} saveDebounceMs={0} /></ToastProvider>; }
beforeEach(() => {
  apiMock.mockReset();
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});

it("restores active work on mount, labels a status outage, and adopts the saved reply without resubmitting", async () => {
  let operation = active;
  let reads = 0;
  apiMock.mockImplementation(async (key) => {
    if (key === "planSession") return { revisionId, sessionVersion: operation.state === "succeeded" ? 1 : 0,
      operation, messages: operation.state === "succeeded" ? [...active.input.messages, { role: "assistant", content: "Recovered reply [PLAN_COMPLETE]" }] : [], planCostUsd: 0 };
    if (key === "planOperation") {
      if (++reads === 1) throw new Error("offline");
      operation = { ...active, state: "succeeded", result: { reply: "Recovered reply [PLAN_COMPLETE]", costUsd: 0, sessionVersion: 1 } };
      return { operation };
    }
    return base(key);
  });
  const rendered = render(view());
  expect(await screen.findByText("Planning reply: running")).toBeVisible();
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  expect(await screen.findByRole("alert", {}, { timeout: 2_000 })).toHaveTextContent("Planning may still be running");
  expect(await screen.findByText("Recovered reply", {}, { timeout: 3_000 })).toBeVisible();
  expect(screen.getByText("Planning reply: succeeded")).toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(apiMock.mock.calls.some(([key]) => key === "planChat")).toBe(false);
  rendered.unmount();
});

it("confirms cancellation and restores an interrupted retry without creating a second chat submission", async () => {
  let operation = active;
  apiMock.mockImplementation(async (key) => {
    if (key === "planSession") return { revisionId, sessionVersion: 0, operation, messages: [], planCostUsd: 0 };
    if (key === "planOperation") return { operation };
    if (key === "planOperationCancel") { operation = { ...active, state: "cancelled", error: { message: "Planning cancelled", status: 409 } }; return { operation }; }
    if (key === "planOperationRetry") { operation = { ...active, id: "retry-id", retryOf: active.id }; return { operation }; }
    return base(key);
  });
  const rendered = render(view());
  await userEvent.click(await screen.findByRole("button", { name: "Cancel planning" }));
  expect(apiMock.mock.calls.some(([key]) => key === "planOperationCancel")).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "Confirm cancellation" }));
  expect(await screen.findByText("Planning reply: cancelled")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Retry planning" }));
  expect(await screen.findByText("Planning reply: running")).toBeVisible();
  expect(apiMock.mock.calls.filter(([key]) => key === "planOperationRetry")).toHaveLength(1);
  expect(apiMock.mock.calls.some(([key]) => key === "planChat")).toBe(false);
  rendered.unmount();
  await act(async () => {});
});

it("brief edits include the observed version and survive a stale-session refusal", async () => {
  apiMock.mockImplementation(async (key) => {
    if (key === "planSession") return { revisionId, sessionVersion: 7, messages: [], planCostUsd: 0, prd: "Original brief", draftTasks: [{ title: "A task", description: "Build it", difficulty: "medium", acceptanceCriteria: [], dependsOn: [], scopePaths: ["src/**"], assignedModel: "codex" }] };
    if (key === "planSaveDraft") throw new ApiRequestError("The planning session changed in another tab", 409, "PLANNING_STALE");
    return base(key);
  });
  render(view());
  fireEvent.change(await screen.findByLabelText("Planning brief"), { target: { value: "My edited brief" } });
  await waitFor(() => expect(screen.getByTestId("draft-save-status")).toHaveTextContent("Save failed"));
  expect(screen.getByLabelText("Planning brief")).toHaveValue("My edited brief");
  const saved = apiMock.mock.calls.find(([key]) => key === "planSaveDraft");
  expect(saved?.[1]?.body).toMatchObject({ sessionVersion: 7, prdMarkdown: "My edited brief" });
});
