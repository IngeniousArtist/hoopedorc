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

describe("CostView request ownership", () => {
  beforeEach(() => {
    apiMock.mockReset();
    wsState.handler = undefined;
  });

  it("ignores an older project fetch after a project switch", async () => {
    let resolveA!: (value: CostAnalyticsResponse) => void;
    const analyticsA = new Promise<CostAnalyticsResponse>((resolve) => {
      resolveA = resolve;
    });
    apiMock.mockImplementation(async (key, options) => {
      if (key === "estimatePlan") return emptyEstimate;
      if (key === "costAnalytics") {
        return options?.params?.id === "cost-b" ? analytics(5) : analyticsA;
      }
      throw new Error(`Unexpected API call: ${key}`);
    });

    const { rerender } = render(<CostView projectId="cost-a" />);
    await waitFor(() => expect(apiMock).toHaveBeenCalled());
    rerender(<CostView projectId="cost-b" />);
    expect(await screen.findByText("$5.00")).toBeVisible();

    await act(async () => {
      resolveA(analytics(1));
      await analyticsA;
    });

    expect(screen.getByText("$5.00")).toBeVisible();
    expect(screen.queryByText("$1.00")).not.toBeInTheDocument();
  });

  it("does not publish an older in-flight fetch after a newer snapshot refresh", async () => {
    let resolveInitial!: (value: CostAnalyticsResponse) => void;
    const initial = new Promise<CostAnalyticsResponse>((resolve) => {
      resolveInitial = resolve;
    });
    let analyticsCalls = 0;
    apiMock.mockImplementation(async (key) => {
      if (key === "estimatePlan") return emptyEstimate;
      if (key === "costAnalytics") {
        analyticsCalls += 1;
        return analyticsCalls === 1 ? initial : analytics(5);
      }
      throw new Error(`Unexpected API call: ${key}`);
    });

    render(<CostView projectId={projectFixture.id} />);
    await waitFor(() => expect(analyticsCalls).toBe(1));
    act(() => {
      wsState.handler?.({
        type: "cost.snapshot",
        payload: { projectId: projectFixture.id, totalUsd: 5 },
      });
    });
    expect(await screen.findByText("$5.00")).toBeVisible();

    await act(async () => {
      resolveInitial(analytics(1));
      await initial;
    });

    expect(screen.getByText("$5.00")).toBeVisible();
    expect(screen.queryByText("$1.00")).not.toBeInTheDocument();
  });

  it("does not show an abort error after unmount or project change", async () => {
    apiMock.mockImplementation(async (key, options) => {
      if (key === "estimatePlan") return emptyEstimate;
      if (key === "costAnalytics") {
        if (options?.params?.id === "cost-abort-a") {
          return new Promise((_resolve, reject) => {
            const signal = options?.signal;
            if (signal?.aborted) {
              reject(new DOMException("The operation was aborted.", "AbortError"));
              return;
            }
            signal?.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          });
        }
        return analytics(5);
      }
      throw new Error(`Unexpected API call: ${key}`);
    });

    const { rerender } = render(<CostView projectId="cost-abort-a" />);
    await waitFor(() => expect(apiMock).toHaveBeenCalled());
    rerender(<CostView projectId="cost-abort-b" />);

    expect(await screen.findByText("$5.00")).toBeVisible();
    expect(screen.queryByText(/aborted/i)).not.toBeInTheDocument();
  });
});
