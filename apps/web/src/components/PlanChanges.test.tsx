import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { PlanChangeContextResponse, PlanChangeReview, ReviewPlanChangesRequest } from "@orc/types";
import { api, ApiRequestError } from "../api/client";
import { taskFixture } from "../test/fixtures";
import { PlanChanges } from "./PlanChanges";

vi.mock("../api/client", async (original) => ({ ...await original<typeof import("../api/client")>(), api: vi.fn() }));
const apiMock = vi.mocked(api);
const task = { ...taskFixture, id: "pending", status: "ready" as const, attempts: 0, branch: undefined, worktreePath: undefined, prNumber: undefined };
const draft: ReviewPlanChangesRequest = { revisionId: "rev", sessionVersion: 2, taskGeneration: 4, prdMarkdown: "# Revised", tasks: [
  { title: "Revised task", description: "Build it", difficulty: "medium", assignedModel: "codex", acceptanceCriteria: ["Works"], scopePaths: ["src/**"], dependsOn: [], existingDependsOn: [] },
] };
const review: PlanChangeReview = { id: "review", projectId: task.projectId, state: "reviewed", createdAt: "now", input: draft,
  previousPrd: "# Existing", changes: [{ before: task, after: { ...task, title: "Revised task" } }], retainedTasks: [] };
const context: PlanChangeContextResponse = { revisionId: "rev", sessionVersion: 2, taskGeneration: 4, tasks: [task], executionActive: false, latestReview: null };
const applied = vi.fn();
function view() { return <PlanChanges projectId={task.projectId} draftTitles={["Revised task"]} prepareDraft={async () => draft} onApplied={applied} onApplying={vi.fn()} disabled={false} />; }
beforeEach(() => { apiMock.mockReset(); applied.mockReset(); });

it("shows loading/errors, preserves a prepared comparison, and confirms exact apply with no duplicate submission", async () => {
  let reads = 0;
  let finish!: (value: unknown) => void;
  apiMock.mockImplementation(async (key) => {
    if (key === "planChangeContext") { if (++reads === 1) throw new Error("offline"); return context; }
    if (key === "reviewPlanChanges") return { review };
    if (key === "applyPlanChanges") return new Promise((resolve) => { finish = resolve; });
    throw new Error(key);
  });
  render(view());
  await userEvent.click(screen.getByRole("button", { name: "Review plan changes" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("offline");
  await userEvent.click(screen.getByRole("button", { name: "Refresh task state" }));
  await userEvent.selectOptions(await screen.findByLabelText("Apply task 1 as"), "pending");
  await userEvent.click(screen.getByRole("button", { name: "Prepare change comparison" }));
  expect(await screen.findByText("0 added · 1 revised · 0 retained")).toBeVisible();
  expect(apiMock.mock.calls.find(([key]) => key === "reviewPlanChanges")?.[1]?.body).toMatchObject({ tasks: [{ existingTaskId: "pending" }], taskGeneration: 4, sessionVersion: 2 });
  await userEvent.click(screen.getByRole("button", { name: "Apply reviewed changes" }));
  expect(apiMock.mock.calls.some(([key]) => key === "applyPlanChanges")).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "Confirm apply" }));
  expect(screen.getByRole("status")).toHaveTextContent("Applying");
  expect(screen.getByRole("button", { name: "Apply reviewed changes" })).toBeDisabled();
  finish({ tasks: [task] });
  await waitFor(() => expect(applied).toHaveBeenCalledTimes(1));
  expect(apiMock.mock.calls.filter(([key]) => key === "applyPlanChanges")).toHaveLength(1);
  expect(apiMock.mock.calls.find(([key]) => key === "applyPlanChanges")?.[1]?.body).toEqual({ reviewId: "review" });
});

it("requires pause confirmation while execution is active, then refuses a stale comparison", async () => {
  let paused = false;
  apiMock.mockImplementation(async (key) => {
    if (key === "planChangeContext") return { ...context, latestReview: review, executionActive: !paused, taskGeneration: paused ? 5 : 4 };
    if (key === "pauseProject") { paused = true; return {}; }
    throw new Error(key);
  });
  render(view());
  await userEvent.click(screen.getByRole("button", { name: "Review plan changes" }));
  expect(await screen.findByRole("button", { name: "Apply reviewed changes" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Pause to apply changes" }));
  expect(apiMock.mock.calls.some(([key]) => key === "pauseProject")).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "Confirm pause" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Tasks changed");
  expect(screen.getByRole("button", { name: "Apply reviewed changes" })).toBeDisabled();
});

it("restores pending persistence and retries its saved review after a stale/read refusal", async () => {
  apiMock.mockImplementation(async (key) => {
    if (key === "planChangeContext") return { ...context, latestReview: { ...review, state: "applying" } };
    if (key === "applyPlanChanges") throw new ApiRequestError("push unavailable", 502);
    throw new Error(key);
  });
  render(view());
  await userEvent.click(screen.getByRole("button", { name: "Review plan changes" }));
  expect(await screen.findByText(/Application is pending persistence/)).toBeVisible();
  expect(screen.queryByLabelText("Apply task 1 as")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry reviewed application" }));
  await userEvent.click(screen.getByRole("button", { name: "Confirm apply" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("push unavailable");
  expect(screen.getByText("0 added · 1 revised · 0 retained")).toBeVisible();
});
