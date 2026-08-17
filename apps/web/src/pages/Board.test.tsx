import type { LogEvent, ModelId, ServerEvent, Task } from "@orc/types";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { TASK_LOG_LIMIT } from "../lib/taskLogs";
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
vi.mock("../components/AddTaskForm", () => ({
  AddTaskForm: ({
    tasks,
    onCreated,
  }: {
    tasks: Task[];
    onCreated: (task: Task) => void;
  }) => (
    <button type="button" onClick={() => tasks[0] && onCreated(tasks[0])}>
      Complete add
    </button>
  ),
}));
vi.mock("../components/TaskDrawer", () => ({
  TaskDrawer: ({
    task,
    logs,
    logsOmittedOlder,
    onRetry,
    onModelChange,
  }: {
    task: Task;
    logs?: Array<{ id: string; message: string }>;
    logsOmittedOlder?: boolean;
    onRetry: () => void | Promise<void>;
    onModelChange: (model: ModelId) => void | Promise<void>;
  }) => (
    <div data-testid="task-drawer">
      <span data-testid="drawer-model">{task.assignedModel}</span>
      {logsOmittedOlder ? (
        <span>Showing latest 1,000 lines. Older lines were omitted.</span>
      ) : null}
      {(logs ?? []).map((entry) => (
        <div key={entry.id} data-testid="drawer-log">
          {entry.message}
        </div>
      ))}
      <button type="button" onClick={() => void onRetry()}>
        Retry task
      </button>
      <button
        type="button"
        onClick={() => void onModelChange("deepseek-flash")}
      >
        Change model
      </button>
    </div>
  ),
}));
vi.mock("../components/TaskCard", () => ({
  TaskCard: ({
    task,
    estimate,
    onClick,
  }: {
    task: Task;
    estimate?: { expectedUsd: number };
    onClick?: () => void;
  }) => (
    <button
      type="button"
      data-testid="task-card"
      data-model={task.assignedModel}
      data-status={task.status}
      onClick={onClick}
    >
      {task.title}
      {estimate ? (
        <span data-testid="task-estimate">{estimate.expectedUsd}</span>
      ) : null}
    </button>
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

function renderKeyedBoard(projectId: string) {
  return render(
    <ToastProvider>
      <Board key={projectId} projectId={projectId} />
    </ToastProvider>,
  );
}

function keyedBoard(projectId: string) {
  return (
    <ToastProvider>
      <Board key={projectId} projectId={projectId} />
    </ToastProvider>
  );
}

function task(id: string, title: string, projectId = "project-1"): Task {
  return {
    ...taskFixture,
    id,
    projectId,
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

  it("does not duplicate a task when its WebSocket event precedes add completion", async () => {
    renderBoard();
    await screen.findAllByText("Initial task");
    const created = task("external", "Created elsewhere");

    act(() => {
      wsState.handler?.({ type: "task.updated", payload: created });
    });
    fireEvent.click(screen.getByRole("button", { name: "+ Add task" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete add" }));

    await waitFor(() => {
      expect(screen.getAllByTestId("board-task")).toHaveLength(2);
      expect(screen.getAllByText("Created elsewhere")).toHaveLength(2);
    });
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

  it("keeps a local model mutation newer than a snapshot when the initial REST list resolves", async () => {
    let resolveTasks!: (value: { tasks: Task[] }) => void;
    let resolveUpdate!: (value: { task: Task }) => void;
    const tasksResponse = new Promise<{ tasks: Task[] }>((resolve) => {
      resolveTasks = resolve;
    });
    const updateResponse = new Promise<{ task: Task }>((resolve) => {
      resolveUpdate = resolve;
    });
    const snapshot = task("shared", "Snapshot task");
    const optimistic = { ...snapshot, assignedModel: "deepseek-flash" };
    apiMock.mockImplementation(async (key) => {
      if (key === "listTasks") return tasksResponse;
      if (key === "getSettings") return { settings: settingsFixture() };
      if (key === "costAnalytics") return { totalUsd: 1, budgetUsd: undefined };
      if (key === "estimatePlan") return { tasks: [] };
      if (key === "updateTask") return updateResponse;
      throw new Error(`Unexpected API call: ${String(key)}`);
    });

    renderBoard();
    act(() => {
      wsState.handler?.({ type: "task.updated", payload: snapshot });
    });
    fireEvent.click(await screen.findByRole("button", { name: "Snapshot task" }));
    fireEvent.click(screen.getByRole("button", { name: "Change model" }));
    await waitFor(() => {
      expect(screen.getByTestId("drawer-model")).toHaveTextContent(
        "deepseek-flash",
      );
    });

    resolveTasks({ tasks: [{ ...snapshot, title: "Older REST task" }] });
    await act(async () => {
      await tasksResponse;
    });
    expect(screen.getByTestId("drawer-model")).toHaveTextContent(
      "deepseek-flash",
    );
    expect(screen.queryByText("Older REST task")).not.toBeInTheDocument();

    resolveUpdate({ task: optimistic });
    await act(async () => {
      await updateResponse;
    });
  });

  it("keeps a recorded failure rollback newer than the initial REST list", async () => {
    let resolveTasks!: (value: { tasks: Task[] }) => void;
    const tasksResponse = new Promise<{ tasks: Task[] }>((resolve) => {
      resolveTasks = resolve;
    });
    const snapshot = task("shared", "Snapshot task");
    apiMock.mockImplementation(async (key) => {
      if (key === "listTasks") return tasksResponse;
      if (key === "getSettings") return { settings: settingsFixture() };
      if (key === "costAnalytics") return { totalUsd: 1, budgetUsd: undefined };
      if (key === "estimatePlan") return { tasks: [] };
      if (key === "updateTask") throw new Error("model change refused");
      throw new Error(`Unexpected API call: ${String(key)}`);
    });

    renderBoard();
    act(() => {
      wsState.handler?.({ type: "task.updated", payload: snapshot });
    });
    fireEvent.click(await screen.findByRole("button", { name: "Snapshot task" }));
    fireEvent.click(screen.getByRole("button", { name: "Change model" }));
    await waitFor(() => {
      expect(screen.getByTestId("drawer-model")).toHaveTextContent("codex");
      expect(screen.getByRole("status")).toHaveTextContent(
        "model change refused",
      );
    });

    resolveTasks({ tasks: [{ ...snapshot, title: "Older REST task" }] });
    await act(async () => {
      await tasksResponse;
    });
    expect(screen.getByTestId("drawer-model")).toHaveTextContent("codex");
    expect(screen.queryByText("Older REST task")).not.toBeInTheDocument();
  });

  it("keeps a WebSocket task newer than local optimism, REST, and a delayed mutation response", async () => {
    let resolveTasks!: (value: { tasks: Task[] }) => void;
    let resolveUpdate!: (value: { task: Task }) => void;
    const tasksResponse = new Promise<{ tasks: Task[] }>((resolve) => {
      resolveTasks = resolve;
    });
    const updateResponse = new Promise<{ task: Task }>((resolve) => {
      resolveUpdate = resolve;
    });
    const snapshot = task("shared", "Snapshot task");
    apiMock.mockImplementation(async (key) => {
      if (key === "listTasks") return tasksResponse;
      if (key === "getSettings") return { settings: settingsFixture() };
      if (key === "costAnalytics") return { totalUsd: 1, budgetUsd: undefined };
      if (key === "estimatePlan") return { tasks: [] };
      if (key === "updateTask") return updateResponse;
      throw new Error(`Unexpected API call: ${String(key)}`);
    });

    renderBoard();
    act(() => {
      wsState.handler?.({ type: "task.updated", payload: snapshot });
    });
    fireEvent.click(await screen.findByRole("button", { name: "Snapshot task" }));
    fireEvent.click(screen.getByRole("button", { name: "Change model" }));
    const websocketTask = {
      ...snapshot,
      title: "Newer WebSocket task",
      assignedModel: "claude",
    };
    act(() => {
      wsState.handler?.({ type: "task.updated", payload: websocketTask });
    });

    resolveTasks({ tasks: [{ ...snapshot, title: "Older REST task" }] });
    await act(async () => {
      await tasksResponse;
    });

    await waitFor(() => {
      expect(screen.getByTestId("drawer-model")).toHaveTextContent("claude");
      expect(screen.getAllByText("Newer WebSocket task").length).toBeGreaterThan(0);
      expect(screen.queryByText("Older REST task")).not.toBeInTheDocument();
    });

    resolveUpdate({
      task: {
        ...snapshot,
        title: "Stale HTTP response",
        assignedModel: "deepseek-flash",
      },
    });
    await act(async () => {
      await updateResponse;
    });
    expect(screen.getByTestId("drawer-model")).toHaveTextContent("claude");
    expect(screen.getAllByText("Newer WebSocket task").length).toBeGreaterThan(0);
    expect(screen.queryByText("Stale HTTP response")).not.toBeInTheDocument();
  });

  it("does not let an older mutation failure roll back a newer WebSocket task", async () => {
    let rejectUpdate!: (error: Error) => void;
    const updateResponse = new Promise<{ task: Task }>((_resolve, reject) => {
      rejectUpdate = reject;
    });
    const original = task("shared", "Original task");
    apiMock.mockImplementation(async (key) => {
      if (key === "listTasks") return { tasks: [original] };
      if (key === "getSettings") return { settings: settingsFixture() };
      if (key === "costAnalytics") return { totalUsd: 1, budgetUsd: undefined };
      if (key === "estimatePlan") return { tasks: [] };
      if (key === "updateTask") return updateResponse;
      throw new Error(`Unexpected API call: ${String(key)}`);
    });

    renderBoard();
    fireEvent.click(await screen.findByRole("button", { name: "Original task" }));
    fireEvent.click(screen.getByRole("button", { name: "Change model" }));
    const websocketTask = {
      ...original,
      title: "WebSocket won",
      assignedModel: "claude" as const,
    };
    act(() => {
      wsState.handler?.({ type: "task.updated", payload: websocketTask });
    });

    rejectUpdate(new Error("older model change refused"));
    await act(async () => {
      await updateResponse.catch(() => undefined);
    });

    expect(screen.getByTestId("drawer-model")).toHaveTextContent("claude");
    expect(screen.getAllByText("WebSocket won").length).toBeGreaterThan(0);
    expect(screen.getByRole("status")).toHaveTextContent(
      "older model change refused",
    );
  });

  it("does not show a stale success toast after a keyed project switch", async () => {
    let resolveRetry!: (value: { task: Task }) => void;
    const retryResponse = new Promise<{ task: Task }>((resolve) => {
      resolveRetry = resolve;
    });
    apiMock.mockImplementation(async (key, options) => {
      const id = (options as { params?: { id?: string } } | undefined)?.params?.id;
      if (key === "listTasks") {
        return id === "project-1"
          ? { tasks: [task("project-1-task", "Project one task")] }
          : { tasks: [task("project-2-task", "Project two task", "project-2")] };
      }
      if (key === "getSettings") return { settings: settingsFixture() };
      if (key === "costAnalytics") return { totalUsd: 1, budgetUsd: undefined };
      if (key === "estimatePlan") return { tasks: [] };
      if (key === "retryTask") return retryResponse;
      throw new Error(`Unexpected API call: ${String(key)}`);
    });

    const view = renderKeyedBoard("project-1");
    fireEvent.click(await screen.findByRole("button", { name: "Project one task" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry task" }));
    view.rerender(keyedBoard("project-2"));
    await screen.findByRole("button", { name: "Project two task" });

    resolveRetry({
      task: { ...task("project-1-task", "Project one task"), status: "ready" },
    });
    await act(async () => {
      await retryResponse;
    });
    expect(screen.queryByText("Retry queued with priority.")).not.toBeInTheDocument();
  });

  it("does not show a stale refusal toast after a keyed project switch", async () => {
    let rejectRetry!: (error: Error) => void;
    const retryResponse = new Promise<{ task: Task }>((_resolve, reject) => {
      rejectRetry = reject;
    });
    apiMock.mockImplementation(async (key, options) => {
      const id = (options as { params?: { id?: string } } | undefined)?.params?.id;
      if (key === "listTasks") {
        return id === "project-1"
          ? { tasks: [task("project-1-task", "Project one task")] }
          : { tasks: [task("project-2-task", "Project two task", "project-2")] };
      }
      if (key === "getSettings") return { settings: settingsFixture() };
      if (key === "costAnalytics") return { totalUsd: 1, budgetUsd: undefined };
      if (key === "estimatePlan") return { tasks: [] };
      if (key === "retryTask") return retryResponse;
      throw new Error(`Unexpected API call: ${String(key)}`);
    });

    const view = renderKeyedBoard("project-1");
    fireEvent.click(await screen.findByRole("button", { name: "Project one task" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry task" }));
    view.rerender(keyedBoard("project-2"));
    await screen.findByRole("button", { name: "Project two task" });

    rejectRetry(new Error("retry refused for old project"));
    await act(async () => {
      await retryResponse.catch(() => undefined);
    });
    expect(
      screen.queryByText("Error: retry refused for old project"),
    ).not.toBeInTheDocument();
  });
});

describe("Board estimate request ownership", () => {
  beforeEach(() => {
    apiMock.mockReset();
    wsState.handler = undefined;
    wsState.handlers.clear();
  });

  it("does not let an older estimate response overwrite a newer one", async () => {
    const ready = task("initial", "Initial task");
    let resolveFirst!: (value: { tasks: Array<{ taskId: string; expectedUsd: number; highUsd: number; title: string; model: string; validatorModel: string; hasHistory: boolean }> }) => void;
    const firstEstimate = new Promise<{
      tasks: Array<{
        taskId: string;
        expectedUsd: number;
        highUsd: number;
        title: string;
        model: string;
        validatorModel: string;
        hasHistory: boolean;
      }>;
    }>((resolve) => {
      resolveFirst = resolve;
    });
    let estimateCalls = 0;
    apiMock.mockImplementation(async (key) => {
      if (key === "listTasks") return { tasks: [ready] };
      if (key === "getSettings") return { settings: settingsFixture() };
      if (key === "costAnalytics") return { totalUsd: 1, budgetUsd: undefined };
      if (key === "estimatePlan") {
        estimateCalls += 1;
        return estimateCalls === 1
          ? firstEstimate
          : {
              tasks: [
                {
                  taskId: ready.id,
                  title: ready.title,
                  model: "codex",
                  validatorModel: "codex",
                  expectedUsd: 9,
                  highUsd: 12,
                  hasHistory: true,
                },
              ],
            };
      }
      throw new Error(`Unexpected API call: ${String(key)}`);
    });

    renderBoard();
    await screen.findByRole("button", { name: "Initial task" });
    await waitFor(() => expect(estimateCalls).toBe(1));

    act(() => {
      wsState.handler?.({
        type: "task.updated",
        payload: { ...ready, assignedModel: "deepseek-flash" },
      });
    });
    await waitFor(() => expect(estimateCalls).toBe(2));
    expect(await screen.findByTestId("task-estimate")).toHaveTextContent("9");

    await act(async () => {
      resolveFirst({
        tasks: [
          {
            taskId: ready.id,
            title: ready.title,
            model: "codex",
            validatorModel: "codex",
            expectedUsd: 1,
            highUsd: 2,
            hasHistory: true,
          },
        ],
      });
      await firstEstimate;
    });

    expect(screen.getByTestId("task-estimate")).toHaveTextContent("9");
  });
});

describe("Board bounded task logs", () => {
  function logLine(index: number, taskId: string): LogEvent {
    return {
      id: `log-${taskId}-${index}`,
      projectId: "project-1",
      runId: "run-1",
      taskId,
      ts: new Date(1_700_000_000_000 + index * 1000).toISOString(),
      level: "info",
      source: "engine",
      message: `${taskId} line ${index}`,
    };
  }

  beforeEach(() => {
    apiMock.mockReset();
    wsState.handler = undefined;
    wsState.handlers.clear();
  });

  it("keeps the newest 1,000 initial rows and a later streamed burst", async () => {
    const ready = task("initial", "Initial task");
    apiMock.mockImplementation(async (key) => {
      if (key === "listTasks") return { tasks: [ready] };
      if (key === "getSettings") return { settings: settingsFixture() };
      if (key === "costAnalytics") return { totalUsd: 1, budgetUsd: undefined };
      if (key === "estimatePlan") return { tasks: [] };
      if (key === "taskLogs") {
        return {
          logs: Array.from({ length: TASK_LOG_LIMIT + 1 }, (_, i) =>
            logLine(i, ready.id),
          ),
        };
      }
      throw new Error(`Unexpected API call: ${String(key)}`);
    });

    renderBoard();
    fireEvent.click(await screen.findByRole("button", { name: "Initial task" }));
    await waitFor(() => expect(screen.getAllByTestId("drawer-log")).toHaveLength(TASK_LOG_LIMIT));
    expect(screen.getByText("Showing latest 1,000 lines. Older lines were omitted.")).toBeVisible();
    expect(screen.queryByText("initial line 0")).not.toBeInTheDocument();
    expect(screen.getByText(`initial line ${TASK_LOG_LIMIT}`)).toBeVisible();

    act(() => {
      wsState.handler?.({
        type: "log",
        payload: logLine(TASK_LOG_LIMIT + 1, ready.id),
      });
      wsState.handler?.({
        type: "log",
        payload: logLine(TASK_LOG_LIMIT + 1, ready.id),
      });
    });

    expect(screen.getAllByTestId("drawer-log")).toHaveLength(TASK_LOG_LIMIT);
    expect(screen.queryByText("initial line 1")).not.toBeInTheDocument();
    expect(screen.getByText(`initial line ${TASK_LOG_LIMIT + 1}`)).toBeVisible();
  });

  it("does not mix rows or omission state when switching tasks", async () => {
    const first = task("task-a", "Task A");
    const second = task("task-b", "Task B");
    apiMock.mockImplementation(async (key, options) => {
      const id = options?.params?.id;
      if (key === "listTasks") return { tasks: [first, second] };
      if (key === "getSettings") return { settings: settingsFixture() };
      if (key === "costAnalytics") return { totalUsd: 1, budgetUsd: undefined };
      if (key === "estimatePlan") return { tasks: [] };
      if (key === "taskLogs") {
        return {
          logs:
            id === first.id
              ? Array.from({ length: TASK_LOG_LIMIT + 1 }, (_, i) =>
                  logLine(i, first.id),
                )
              : [logLine(1, second.id), logLine(2, second.id)],
        };
      }
      throw new Error(`Unexpected API call: ${String(key)}`);
    });

    renderBoard();
    fireEvent.click(await screen.findByRole("button", { name: "Task A" }));
    await screen.findByText("Showing latest 1,000 lines. Older lines were omitted.");
    fireEvent.click(screen.getByRole("button", { name: "Task B" }));

    expect(await screen.findByText("task-b line 1")).toBeVisible();
    expect(screen.getByText("task-b line 2")).toBeVisible();
    expect(screen.queryByText(/task-a line/)).not.toBeInTheDocument();
    expect(
      screen.queryByText("Showing latest 1,000 lines. Older lines were omitted."),
    ).not.toBeInTheDocument();
  });
});
