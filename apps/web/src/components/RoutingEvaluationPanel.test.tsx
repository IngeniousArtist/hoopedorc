import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { routingEvaluationExample, type RoutingEvaluationRecord } from "@orc/types";
import { RoutingEvaluationPanel } from "./RoutingEvaluationPanel";
import { api } from "../api/client";
vi.mock("../api/client", () => ({ api: vi.fn() }));
beforeEach(() => { vi.resetAllMocks(); sessionStorage.clear(); });
const record: RoutingEvaluationRecord = { id: "record", datasetHash: "hash", createdAt: "2026-09-21T12:00:00Z", dataset: routingEvaluationExample(), report: { evaluatorVersion: 1, status: "insufficient_evidence", reasons: ["Synthetic examples cannot establish efficacy."], heldOutCases: 12, comparedCases: 12, classifierModels: ["jev-example"], classifierCostUsd: 0.012, unknownClassifierCosts: 0, static: { costUsd: 6, repairCostUsd: 0, tokens: 96000, calls: 24, durationMs: 720000, unacceptable: 0 }, proposed: { costUsd: 6.012, repairCostUsd: 2.4, tokens: 81320, calls: 44, durationMs: 562400, unacceptable: 0 }, assignments: [], cases: [], liveRoutingEnabled: false } };

it("VW18: evaluation preserves input/request identity through failure, reload and retry", async () => {
  let fail!: (value: Error) => void;
  vi.mocked(api).mockImplementation((key) => key === "routingEvaluations" ? Promise.resolve({ evaluations: [] }) : new Promise((_, reject) => { fail = reject; }));
  const view = render(<RoutingEvaluationPanel active />);
  expect(await screen.findByText(/No saved evaluations/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Load synthetic example" }));
  const original = (screen.getByLabelText("Recorded routing dataset") as HTMLTextAreaElement).value;
  fireEvent.click(screen.getByRole("button", { name: "Evaluate and save report" }));
  expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();
  const first = vi.mocked(api).mock.calls.find(([key]) => key === "evaluateRouting")!;
  fail(new Error("Response lost")); expect(await screen.findByRole("alert")).toHaveTextContent("Response lost");
  expect(screen.getByLabelText("Recorded routing dataset")).toHaveValue(original);
  view.unmount(); vi.mocked(api).mockImplementation((key) => Promise.resolve(key === "routingEvaluations" ? { evaluations: [] } : { evaluation: record }));
  render(<RoutingEvaluationPanel active />); expect(screen.getByLabelText("Recorded routing dataset")).toHaveValue(original);
  fireEvent.click(screen.getByRole("button", { name: "Evaluate and save report" })); expect(await screen.findByText("More evidence needed")).toBeVisible();
  const calls = vi.mocked(api).mock.calls.filter(([key]) => key === "evaluateRouting"); expect(calls[1]?.[1]?.body).toEqual(first[1]?.body);
  expect(screen.getByText(/Automatic Jev routing: off/)).toBeVisible();
});

it("VW18: malformed input and replacement confirmation preserve drafts; unavailable history can retry", async () => {
  vi.mocked(api).mockRejectedValueOnce(new Error("History unavailable"));
  render(<RoutingEvaluationPanel active />); expect(await screen.findByRole("alert")).toHaveTextContent("History unavailable");
  vi.mocked(api).mockResolvedValue({ evaluations: [] }); fireEvent.click(screen.getByRole("button", { name: "Refresh reports" })); await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  fireEvent.change(screen.getByLabelText("Recorded routing dataset"), { target: { value: "bad JSON" } }); fireEvent.click(screen.getByRole("button", { name: "Evaluate and save report" })); expect(screen.getByRole("alert")).toHaveTextContent("valid JSON");
  fireEvent.click(screen.getByRole("button", { name: "Load synthetic example" })); expect(screen.getByRole("dialog")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" })); expect(screen.getByLabelText("Recorded routing dataset")).toHaveValue("bad JSON");
  expect(vi.mocked(api).mock.calls.every(([key]) => key === "routingEvaluations")).toBe(true);
});
