import type { ServerEvent, Task } from "@orc/types";
import { render, screen, waitFor, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { ToastProvider } from "../hooks/useToast";
import { settingsFixture, taskFixture } from "../test/fixtures";
import { Board } from "./Board";

const wsState = vi.hoisted(() => ({
  handler: undefined as ((event: ServerEvent) => void) | undefined,
  handlers: new Map<string, (event: ServerEvent) => void>(),
}));

vi.mock("../api/client", () => ({ api: vi.fn() }));
vi.mock("../hooks/useWS", () => ({
  useWS: (
    projectId: string,
    handler: (event: ServerEvent) => void,
  ) => {
    wsState.handler = handler;
    wsState.handlers.set(projectId, handler);
  },
}));
vi.mock("../components/BoardSummary", () => ({
  BoardSummary: ({ tasks, costUsd }: { tasks: Task[]; costUsd: number }) => (
    <div data-testid="board-summary">
      <span data-testid="board-cost">{costUsd.toFixed(4)}</span>
      {tasks.map((task) => (
        <span key={task.id} data-testid="board-task">
          {task.title}
        </span>
      ))}
    </div>
  ),
}));
vi.mock("../components/MissionControl", () => ({ MissionControl: () => null }));
vi.mock("../components/AddTaskForm", () => ({ AddTaskForm: () => null }));
vi.mock("../components/TaskDrawer", () => ({ TaskDrawer: () => null }));
vi.mock("../components/TaskCard", () => ({
  TaskCard: ({ task }: { task: Task }) => (
    <div data-testid="task-card">{task.title}</div>
  ),
}));

const apiMock = vi.mocked(api);

function renderBoard(projectId = "project-1") {
  return render(
    <ToastProvider>
      <Board projectId={projectId} />
    </ToastProvider>,
  );
}

function task(id: string, title: string): Task {
  return {
    ...taskFixture,
    id,
    projectId: "project-1",
    title,
    status: "ready",
  };
}

describe("Board authoritative WebSocket state", () => {
  beforeEach(() => {
    apiMock.mockReset();
    wsState.handler = undefined;
    wsState.handlers.clear();
    apiMock.mockImplementation(async (key) => {
      if (key === "listTasks") return { tasks: [task("initial", "Initial task")] };
      if (key === "getSettings") return { settings: settingsFixture() };
      if (key === "costAnalytics") {
        return { totalUsd: 1, budgetUsd: undefined };
      }
      if (key === "estimatePlan") return { tasks: [] };
      throw new Error(`Unexpected API call: ${String(key)}`);
    });
  });

  it("inserts an unknown task.updated into the board", async () => {
    renderBoard();
    await screen.findByTestId("board-summary");
    const created = task("external", "Created elsewhere");

    act(() => {
      wsState.handler?.({ type: "task.updated", payload: created });
    });

    expect((await screen.findAllByText("Created elsewhere")).length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("board-task")).toHaveLength(2);
  });

  it("merges a WS task received while the REST list is still in flight", async () => {
    let resolveTasks!: (value: { tasks: Task[] }) => void;
    const tasksResponse = new Promise<{ tasks: Task[] }>((resolve) => {
      resolveTasks = resolve;
    });
    apiMock.mockImplementation(async (key) => {
      if (key === "listTasks") return tasksResponse;
      if (key === "getSettings") return { settings: settingsFixture() };
      if (key === "costAnalytics") return { totalUsd: 1, budgetUsd: undefined };
      if (key === "estimatePlan") return { tasks: [] };
      throw new Error(`Unexpected API call: ${String(key)}`);
    });

    renderBoard();
    const created = task("in-flight", "Created during list request");
    act(() => {
      wsState.handler?.({ type: "task.updated", payload: created });
    });
    resolveTasks({ tasks: [task("initial", "Initial task")] });
    await act(async () => {
      await tasksResponse;
    });

    await waitFor(() => {
      expect(screen.getAllByTestId("board-task")).toHaveLength(2);
      expect(screen.getAllByText("Created during list request").length).toBeGreaterThan(0);
    });
  });

  it("does not merge a stale project's WS event or REST response after switching", async () => {
    let resolveProjectOne!: (value: { tasks: Task[] }) => void;
    let resolveProjectTwo!: (value: { tasks: Task[] }) => void;
    const projectOneTasks = new Promise<{ tasks: Task[] }>((resolve) => {
      resolveProjectOne = resolve;
    });
    const projectTwoTasks = new Promise<{ tasks: Task[] }>((resolve) => {
      resolveProjectTwo = resolve;
    });
    apiMock.mockImplementation(async (key, options) => {
      const id = (options as { params?: { id?: string }} | undefined)?.params?.id;
      if (key === "listTasks") return id === "project-1" ? projectOneTasks : projectTwoTasks;
      if (key === "getSettings") return { settings: settingsFixture() };
      if (key === "costAnalytics") return { totalUsd: 1, budgetUsd: undefined };
      if (key === "estimatePlan") return { tasks: [] };
      throw new Error(`Unexpected API call: ${String(key)}`);
    });

    const view = renderBoard("project-1");
    const oldHandler = wsState.handlers.get("project-1")!;
    view.rerender(
      <ToastProvider>
        <Board projectId="project-2" />
      </ToastProvider>,
    );
    const newHandler = wsState.handlers.get("project-2")!;
    const stale = task("stale", "Stale project task");
    const current = task("current", "Current project task");
    current.projectId = "project-2";
    act(() => {
      oldHandler({ type: "task.updated", payload: stale });
      newHandler({ type: "task.updated", payload: current });
    });
    resolveProjectOne({ tasks: [stale] });
    resolveProjectTwo({ tasks: [current] });
    await act(async () => {
      await Promise.all([projectOneTasks, projectTwoTasks]);
    });

    await waitFor(() => {
      expect(screen.getAllByText("Current project task").length).toBeGreaterThan(0);
      expect(screen.queryAllByText("Stale project task")).toHaveLength(0);
    });
  });

  it("does not let stale A state overwrite fresh A data after an A-B-A switch", async () => {
    let resolveProjectB!: (value: { tasks: Task[] }) => void;
    let resolveProjectAReturn!: (value: { tasks: Task[] }) => void;
    let projectACalls = 0;
    const projectBTasks = new Promise<{ tasks: Task[] }>((resolve) => {
      resolveProjectB = resolve;
    });
    const projectAReturnTasks = new Promise<{ tasks: Task[] }>((resolve) => {
      resolveProjectAReturn = resolve;
    });
    const staleA = task("shared", "A stale row");
    const freshA = task("shared", "A fresh row");
    apiMock.mockImplementation(async (key, options) => {
      const id = (options as { params?: { id?: string }} | undefined)?.params?.id;
      if (key === "listTasks") {
        if (id === "project-1") {
          projectACalls++;
          return projectACalls === 1
            ? { tasks: [staleA] }
            : projectAReturnTasks;
        }
        return projectBTasks;
      }
      if (key === "getSettings") return { settings: settingsFixture() };
      if (key === "costAnalytics") return { totalUsd: 1, budgetUsd: undefined };
      if (key === "estimatePlan") return { tasks: [] };
      throw new Error(`Unexpected API call: ${String(key)}`);
    });

    const view = renderBoard("project-1");
    await screen.findAllByText("A stale row");

    view.rerender(
      <ToastProvider>
        <Board projectId="project-2" />
      </ToastProvider>,
    );
    view.rerender(
      <ToastProvider>
        <Board projectId="project-1" />
      </ToastProvider>,
    );
    resolveProjectAReturn({ tasks: [freshA] });
    await act(async () => {
      await projectAReturnTasks;
    });

    await waitFor(() => {
      expect(screen.getAllByText("A fresh row").length).toBeGreaterThan(0);
      expect(screen.queryAllByText("A stale row")).toHaveLength(0);
    });
    // Resolve the abandoned B request so this test leaves no hanging promise.
    resolveProjectB({ tasks: [] });
  });

  it("keeps snapshot and deltas authoritative over an older REST cost seed", async () => {
    let resolveCost!: (value: { totalUsd: number; budgetUsd?: number }) => void;
    const costResponse = new Promise<{ totalUsd: number; budgetUsd?: number }>(
      (resolve) => {
        resolveCost = resolve;
      },
    );
    apiMock.mockImplementation(async (key) => {
      if (key === "listTasks") return { tasks: [task("initial", "Initial task")] };
      if (key === "getSettings") return { settings: settingsFixture() };
      if (key === "costAnalytics") return costResponse;
      if (key === "estimatePlan") return { tasks: [] };
      throw new Error(`Unexpected API call: ${String(key)}`);
    });

    renderBoard();
    expect(wsState.handler).toBeDefined();

    act(() => {
      wsState.handler?.({
        type: "cost.snapshot",
        payload: { projectId: "project-1", totalUsd: 5 },
      });
      wsState.handler?.({
        type: "cost.updated",
        payload: {
          id: "cost-1",
          projectId: "project-1",
          model: "deepseek-flash",
          costUsd: 0.25,
          tokensIn: 1,
          tokensOut: 1,
          tokensCached: 0,
          ts: "2026-08-11T00:00:00.000Z",
        },
      });
    });
    resolveCost({ totalUsd: 1 });
    await act(async () => {
      await costResponse;
    });

    await waitFor(() => {
      expect(screen.getAllByTestId("board-task")[0]).toHaveTextContent("Initial task");
      expect(screen.getByTestId("board-cost")).toHaveTextContent("5.2500");
    });
  });
});
