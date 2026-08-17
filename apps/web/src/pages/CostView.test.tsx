import type { CostAnalyticsResponse, EstimateResponse, ServerEvent } from "@orc/types";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { projectFixture } from "../test/fixtures";
import { CostView } from "./CostView";

const wsState = vi.hoisted(() => ({
  handler: undefined as ((event: ServerEvent) => void) | undefined,
}));

vi.mock("../api/client", () => ({ api: vi.fn() }));
vi.mock("../hooks/useWS", () => ({
  useWS: (_projectId: string, handler: (event: ServerEvent) => void) => {
    wsState.handler = handler;
  },
}));

const apiMock = vi.mocked(api);

function analytics(totalUsd: number): CostAnalyticsResponse {
  return {
    totalUsd,
    totalTokensIn: 0,
    totalTokensOut: 0,
    byModel: [],
    daily: [],
    byTask: [],
    completedTasks: 0,
    avgCostPerCompletedTask: 0,
  };
}

const emptyEstimate: EstimateResponse = {
  tasks: [],
  totalExpectedUsd: 0,
  totalHighUsd: 0,
  confidence: "low",
  note: "No remaining tasks.",
};

describe("CostView reconnect catch-up", () => {
  beforeEach(() => {
    apiMock.mockReset();
    wsState.handler = undefined;
  });

  it("refetches spend from the authoritative cost snapshot after reconnect", async () => {
    apiMock.mockImplementation(async (key) => {
      if (key === "costAnalytics") return analytics(1);
      if (key === "estimatePlan") return emptyEstimate;
      throw new Error(`Unexpected API call: ${key}`);
    });
    render(<CostView projectId={projectFixture.id} />);

    expect(await screen.findByText("$1.00")).toBeVisible();
    expect(screen.getByText("Total spend")).toBeVisible();
    expect(apiMock).toHaveBeenCalledTimes(2);

    apiMock.mockImplementation(async (key) => {
      if (key === "costAnalytics") return analytics(5);
      if (key === "estimatePlan") return emptyEstimate;
      throw new Error(`Unexpected API call: ${key}`);
    });
    act(() => {
      wsState.handler?.({
        type: "cost.snapshot",
        payload: { projectId: projectFixture.id, totalUsd: 5 },
      });
    });

    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(4));
    expect(await screen.findByText("$5.00")).toBeVisible();
    expect(screen.queryByText("$1.00")).not.toBeInTheDocument();
  });
});
