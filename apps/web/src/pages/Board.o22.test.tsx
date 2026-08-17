import type { LogEvent, ServerEvent, Task, TaskStatus } from "@orc/types";
import { act, render, screen, waitFor } from "@testing-library/react";
import { Profiler, type ProfilerOnRenderCallback } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { ToastProvider } from "../hooks/useToast";
import { settingsFixture, taskFixture } from "../test/fixtures";
import { Board } from "./Board";

const counters = vi.hoisted(() => ({
  cardRenders: 0,
  estimateCalls: 0,
  boardCommits: 0,
  boardDurationMs: 0,
}));

const wsState = vi.hoisted(() => ({
  handler: undefined as ((event: ServerEvent) => void) | undefined,
}));

vi.mock("../api/client", () => ({ api: vi.fn() }));
vi.mock("../hooks/useWS", () => ({
  useWS: (_projectId: string, handler: (event: ServerEvent) => void) => {
    wsState.handler = handler;
  },
}));
vi.mock("../components/MissionControl", () => ({
  MissionControl: () => <div data-testid="mission-control" />,
}));
vi.mock("../components/AddTaskForm", () => ({ AddTaskForm: () => null }));
vi.mock("../components/TaskDrawer", () => ({ TaskDrawer: () => null }));
vi.mock("../components/TaskCard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/TaskCard")>();
  return {
    ...actual,
    TaskCard: (props: Parameters<typeof actual.TaskCard>[0]) => {
      counters.cardRenders += 1;
      return <actual.TaskCard {...props} />;
    },
  };
});

const apiMock = vi.mocked(api);

const LOG_BURST = 200;
const SAME_STATUS_UPDATES = 20;
const STATUS_CHANGES = 2;
const TASK_COUNT = 12;

function boardTask(
  id: string,
  title: string,
  status: TaskStatus,
): Task {
  return {
    ...taskFixture,
    id,
    projectId: "project-1",
    title,
    status,
    prNumber: undefined,
    attempts: status === "in_progress" ? 1 : 0,
  };
}

function representativeTasks(): Task[] {
  return [
    boardTask("run-a", "Author login form", "in_progress"),
    boardTask("run-b", "Review auth gates", "in_review"),
    boardTask("ready-1", "Add settings page", "ready"),
    boardTask("ready-2", "Wire notifications", "ready"),
    boardTask("ready-3", "Document API", "ready"),
    boardTask("backlog-1", "Later polish", "backlog"),
    boardTask("blocked-1", "Waiting on design", "blocked"),
    boardTask("changes-1", "Fix review notes", "changes_requested"),
    boardTask("done-1", "Scaffold app", "done"),
    boardTask("done-2", "Add CI", "done"),
    boardTask("failed-1", "Broken probe", "failed"),
    boardTask("backlog-2", "Optional docs", "backlog"),
  ];
}

function logLine(index: number, taskId: string): LogEvent {
  return {
    id: `log-${taskId}-${index}`,
    projectId: "project-1",
    runId: "run-a-1",
    taskId,
    ts: new Date(1_700_000_000_000 + index).toISOString(),
    level: "debug",
    source: "agent",
    message: `agent output ${index}`,
  };
}

function snapshot() {
  return {
    cardRenders: counters.cardRenders,
    estimateCalls: counters.estimateCalls,
    boardCommits: counters.boardCommits,
    boardDurationMs: Number(counters.boardDurationMs.toFixed(3)),
  };
}

describe("O22 Board live-run rendering", () => {
  const frames: FrameRequestCallback[] = [];

  beforeEach(() => {
    counters.cardRenders = 0;
    counters.estimateCalls = 0;
    counters.boardCommits = 0;
    counters.boardDurationMs = 0;
    wsState.handler = undefined;
    frames.length = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
      if (handle === frames.length) frames.pop();
    });
    apiMock.mockReset();
    apiMock.mockImplementation(async (key) => {
      if (key === "listTasks") return { tasks: representativeTasks() };
      if (key === "getSettings") return { settings: settingsFixture() };
      if (key === "costAnalytics") return { totalUsd: 1.25, budgetUsd: 20 };
      if (key === "estimatePlan") {
        counters.estimateCalls += 1;
        return { tasks: [] };
      }
      throw new Error(`Unexpected API call: ${String(key)}`);
    });
  });

  it("records board/card renders and estimate fetches for a fixed live-run burst", async () => {
    const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
      counters.boardCommits += 1;
      counters.boardDurationMs += actualDuration;
    };
    render(
      <ToastProvider>
        <Profiler id="o22-board" onRender={onRender}>
          <Board projectId="project-1" />
        </Profiler>
      </ToastProvider>,
    );

    await screen.findByText("Author login form");
    await waitFor(() => expect(counters.estimateCalls).toBe(1));
    frames.length = 0;
    const afterLoad = snapshot();

    for (let index = 0; index < LOG_BURST; index++) {
      act(() => {
        wsState.handler?.({
          type: "log",
          payload: logLine(index, "run-a"),
        });
      });
    }
    const beforeActivityFlush = snapshot();
    act(() => {
      const queued = frames.splice(0);
      for (const frame of queued) frame(0);
    });
    const afterLogs = snapshot();

    const running = representativeTasks().find((task) => task.id === "run-a")!;
    for (let index = 0; index < SAME_STATUS_UPDATES; index++) {
      act(() => {
        wsState.handler?.({
          type: "task.updated",
          payload: {
            ...running,
            updatedAt: new Date(1_700_000_100_000 + index).toISOString(),
            attempts: 1,
          },
        });
      });
    }
    const afterSameStatus = snapshot();

    let current = running;
    for (let index = 0; index < STATUS_CHANGES; index++) {
      current = {
        ...current,
        status: index === 0 ? "in_review" : "done",
        updatedAt: new Date(1_700_000_200_000 + index).toISOString(),
      };
      act(() => {
        wsState.handler?.({ type: "task.updated", payload: current });
      });
    }
    const afterStatusChanges = snapshot();

    const queuedBeforeFlush =
      beforeActivityFlush.boardCommits - afterLoad.boardCommits;
    const logBoardCommits = afterLogs.boardCommits - afterLoad.boardCommits;
    const logCardRenders = afterLogs.cardRenders - afterLoad.cardRenders;
    const sameStatusEstimates =
      afterSameStatus.estimateCalls - afterLogs.estimateCalls;
    const statusChangeEstimates =
      afterStatusChanges.estimateCalls - afterSameStatus.estimateCalls;

    const report = {
      tasks: TASK_COUNT,
      logBurst: LOG_BURST,
      sameStatusUpdates: SAME_STATUS_UPDATES,
      statusChanges: STATUS_CHANGES,
      afterLoad,
      queuedBeforeFlush,
      logBoardCommits,
      logCardRenders,
      logDurationMs: Number(
        (afterLogs.boardDurationMs - afterLoad.boardDurationMs).toFixed(3),
      ),
      sameStatusEstimates,
      statusChangeEstimates,
      totalEstimates: afterStatusChanges.estimateCalls,
      host: "jsdom",
    };
    process.stdout.write(`O22 Board live-run measurement ${JSON.stringify(report)}\n`);

    const commitsBeforeClock = counters.boardCommits;
    vi.useFakeTimers();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    vi.useRealTimers();
    expect(counters.boardCommits).toBe(commitsBeforeClock);

    expect(screen.getByText("Author login form")).toBeVisible();
    expect(queuedBeforeFlush).toBe(0);
    expect(logBoardCommits).toBe(1);
    expect(logCardRenders).toBe(TASK_COUNT);
    expect(sameStatusEstimates).toBe(0);
    expect(statusChangeEstimates).toBe(STATUS_CHANGES);
  });
});
