import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_MILESTONE_POLICY, type MilestonesResponse } from "@orc/types";
import { api } from "../api/client";
import { taskFixture } from "../test/fixtures";
import { MilestonesPanel } from "./MilestonesPanel";
vi.mock("../api/client", () => ({ api: vi.fn(), isAbortError: () => false }));
const apiMock = vi.mocked(api);
const task = { ...taskFixture, id: "outcome", title: "Integrated checkout", milestone: DEFAULT_MILESTONE_POLICY, acceptanceCriteria: ["Customer can complete checkout"], dependsOn: ["source"] };
const data: MilestonesResponse = { taskGeneration: 0, milestones: [{ task, verificationTask: task, contributors: [{ id: "source", title: "Checkout implementation", status: "done" }], state: "needs_attention", reason: "Missing integrated evidence", repairRounds: 0, calls: 1, observedCostUsd: 0, unknownSpendCalls: 0 }] };
beforeEach(() => { apiMock.mockReset(); });
it("shows loading, empty and failure with refresh", async () => {
  let resolve!: (value: MilestonesResponse) => void; apiMock.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  render(<MilestonesPanel projectId="p" />); expect(screen.getByRole("status")).toHaveTextContent("Loading milestone evidence");
  await act(async () => resolve({ taskGeneration: 0, milestones: [] })); expect(screen.getByText(/No milestone criteria/)).toBeVisible();
});
it("preserves confirmation after failure and saves exactly one repair draft on retry", async () => {
  let fail = true; let resolve!: (value: unknown) => void;
  apiMock.mockImplementation(async (route) => {
    if (route === "milestones") return data;
    if (route === "planChangeContext") return { revisionId: "revision", sessionVersion: 2, taskGeneration: 4 };
    if (fail) throw new Error("Planning work is preserved; finish it first");
    return new Promise((done) => { resolve = done; });
  });
  render(<MilestonesPanel projectId="p" />); fireEvent.click(await screen.findByRole("button", { name: "Prepare repair draft" }));
  expect(screen.getByRole("group", { name: "Confirm milestone repair" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Confirm repair draft" })); expect(await screen.findByRole("alert")).toHaveTextContent("Planning work is preserved");
  fail = false; fireEvent.click(screen.getByRole("button", { name: "Confirm repair draft" }));
  expect(await screen.findByRole("button", { name: "Preparing draft…" })).toBeDisabled();
  await act(async () => resolve({ tasks: [] }));
  expect(await screen.findByRole("status")).toHaveTextContent("Repair draft saved"); expect(screen.getByRole("link", { name: "Review repair in Plan" })).toHaveAttribute("href", "#/p/p/plan");
  expect(apiMock.mock.calls.filter(([route]) => route === "milestoneRepairDraft")).toHaveLength(2);
});
it("marks unavailable and stale evidence without implying acceptance and explains an exhausted budget", async () => {
  apiMock.mockResolvedValue({ milestones: [{ ...data.milestones[0], state: "stale", reason: "Repository advanced", repairUnavailableReason: "The approved repair-round limit is reached." }] });
  render(<MilestonesPanel projectId="p" />); expect(await screen.findByText("Repository advanced")).toBeVisible();
  expect(screen.getByRole("button", { name: "Prepare repair draft" })).toBeDisabled(); expect(screen.getByText(/round limit/)).toBeVisible();
  expect(screen.getByText("0 of 1 accepted")).toBeVisible(); expect(screen.getByText("No criterion evidence recorded.")).toBeVisible();
});
