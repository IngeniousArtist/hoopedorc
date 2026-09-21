import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { modelFixture, taskFixture } from "../test/fixtures";
import { TaskDrawer } from "./TaskDrawer";

vi.mock("../api/client", () => ({ api: vi.fn() }));

describe("task recovery controls", () => {
  it("offers retry for a failed task and invokes the shared action", async () => {
    vi.mocked(api).mockImplementation(async (key) => {
      if (key === "listTaskRuns") return { runs: [] };
      if (key === "taskDecisions") return { decisions: [] };
      throw new Error(`Unexpected API call: ${key}`);
    });
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <TaskDrawer
        task={taskFixture}
        models={[modelFixture]}
        repoUrl="https://github.com/example/test"
        logs={[]}
        logsLoading={false}
        diff={null}
        actionBusy={false}
        onClose={vi.fn()}
        onViewDiff={vi.fn()}
        onRetry={onRetry}
        onRollback={vi.fn()}
        onModelChange={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "↻ Retry task" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("exposes modal drawer semantics and returns focus after Escape", async () => {
    vi.mocked(api).mockImplementation(async (key) => {
      if (key === "listTaskRuns") return { runs: [] };
      if (key === "taskDecisions") return { decisions: [] };
      throw new Error(`Unexpected API call: ${key}`);
    });
    const user = userEvent.setup();

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open task drawer
          </button>
          {open && (
            <TaskDrawer
              task={taskFixture}
              models={[modelFixture]}
              repoUrl="https://github.com/example/test"
              logs={[]}
              logsLoading={false}
              diff={null}
              actionBusy={false}
              onClose={() => setOpen(false)}
              onViewDiff={vi.fn()}
              onRetry={vi.fn()}
              onRollback={vi.fn()}
              onModelChange={vi.fn()}
            />
          )}
        </>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open task drawer" });
    await user.click(trigger);

    expect(screen.getByRole("dialog", { name: taskFixture.title })).toBeVisible();
    expect(screen.getByRole("button", { name: "Close task drawer" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});


function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function drawerProps(overrides: Partial<Parameters<typeof TaskDrawer>[0]> = {}) {
  return {
    task: taskFixture,
    models: [modelFixture],
    repoUrl: "https://github.com/example/test",
    logs: [],
    logsLoading: false,
    diff: null,
    actionBusy: false,
    onClose: vi.fn(),
    onViewDiff: vi.fn(),
    onRetry: vi.fn(),
    onRollback: vi.fn(),
    onModelChange: vi.fn(),
    ...overrides,
  };
}

describe("VW04 task inspector history states", () => {
  beforeEach(() => {
    // The Logs tab auto-follows by scrolling; jsdom elements lack scrollTo.
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
  });

  it("shows loading, then a failed attempts read with retry, never 'No runs yet' for a failure", async () => {
    const user = userEvent.setup();
    let runsCalls = 0;
    vi.mocked(api).mockImplementation(async (key) => {
      if (key === "listTaskRuns") {
        runsCalls += 1;
        if (runsCalls === 1) throw new Error("runs read failed");
        return { runs: [] };
      }
      if (key === "taskDecisions") return { decisions: [] };
      throw new Error(`Unexpected API call: ${key}`);
    });
    render(<TaskDrawer {...drawerProps()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading attempts…");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load attempts: runs read failed");
    expect(screen.queryByText("No runs yet.")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No runs yet.")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(runsCalls).toBe(2);
  });

  it("keeps review history failures distinct from 'No reviews yet'", async () => {
    const user = userEvent.setup();
    vi.mocked(api).mockImplementation(async (key) => {
      if (key === "listTaskRuns") return { runs: [] };
      if (key === "taskDecisions") throw new Error("decisions unavailable");
      throw new Error(`Unexpected API call: ${key}`);
    });
    render(<TaskDrawer {...drawerProps()} />);
    await user.click(screen.getByRole("button", { name: "Review" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load review history: decisions unavailable",
    );
    expect(screen.queryByText("No gate result yet.")).not.toBeInTheDocument();
    expect(screen.queryByText("No reviews yet.")).not.toBeInTheDocument();
    expect(screen.getByText("Unavailable until the review history loads.")).toBeVisible();
  });

  it("does not let a slow read for the previous task populate the newly opened task", async () => {
    const first = { ...taskFixture, id: "task-a", title: "Task A" };
    const second = { ...taskFixture, id: "task-b", title: "Task B" };
    const slow = deferred<{ runs: Array<Record<string, unknown>> }>();
    vi.mocked(api).mockImplementation(async (key, options) => {
      const id = options?.params?.id;
      if (key === "listTaskRuns") {
        if (id === "task-a") return slow.promise;
        return {
          runs: [
            {
              id: "run-b",
              taskId: "task-b",
              projectId: "proj-test",
              model: modelFixture.id,
              status: "completed",
              startedAt: "2026-09-21T10:00:00.000Z",
              endedAt: "2026-09-21T10:00:05.000Z",
              costUsd: 0.01,
              tokensIn: 0,
              tokensOut: 0,
              exitReason: "completed",
            },
          ],
        };
      }
      if (key === "taskDecisions") return { decisions: [] };
      throw new Error(`Unexpected API call: ${key}`);
    });
    const { rerender } = render(<TaskDrawer {...drawerProps({ task: first })} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading attempts…");
    rerender(<TaskDrawer {...drawerProps({ task: second })} />);
    await waitFor(() => expect(screen.getByText(/completed/)).toBeVisible());

    await act(async () => {
      slow.resolve({
        runs: [
          {
            id: "run-a",
            taskId: "task-a",
            projectId: "proj-test",
            model: modelFixture.id,
            status: "failed",
            startedAt: "2026-09-21T09:00:00.000Z",
            endedAt: "2026-09-21T09:00:05.000Z",
            costUsd: 0.5,
            tokensIn: 0,
            tokensOut: 0,
            exitReason: "error",
          },
        ],
      });
      await slow.promise;
    });
    expect(screen.queryByText(/error$/)).not.toBeInTheDocument();
    expect(screen.getByText(/completed/)).toBeVisible();
  });

  it("labels the close control as Back for phones under the same accessible name", async () => {
    vi.mocked(api).mockImplementation(async (key) => {
      if (key === "listTaskRuns") return { runs: [] };
      if (key === "taskDecisions") return { decisions: [] };
      throw new Error(`Unexpected API call: ${key}`);
    });
    render(
      <TaskDrawer
        {...drawerProps({ logsError: "history offline", rollbackError: "rollback offline", task: { ...taskFixture, prNumber: 9 } })}
      />,
    );
    const close = screen.getByRole("button", { name: "Close task drawer" });
    expect(close).toHaveTextContent("‹ Back");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Logs" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load log history: history offline");
    await user.click(screen.getByRole("button", { name: "PR" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Rollback status could not be loaded: rollback offline",
    );
  });
});
