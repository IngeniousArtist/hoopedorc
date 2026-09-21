import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { modelFixture, taskFixture } from "../test/fixtures";
import { TaskCard, taskCardPropsAreEqual, type TaskCardProps } from "./TaskCard";

describe("TaskCard retry accounting", () => {
  it("labels consumed invocations, policy, and recovery allowance separately in the engineering view", () => {
    render(
      <TaskCard
        task={{
          ...taskFixture,
          attempts: 3,
          maxAttempts: 2,
          runExtraAttempts: 2,
        }}
        allTasks={[]}
        models={[modelFixture]}
        engineering
      />,
    );

    const accounting = screen.getByText("Attempt 3 · policy 2 + 2 recovery");
    expect(accounting).toHaveAttribute(
      "title",
      "3 author invocations consumed in logical run 0; policy allows 2 plus 2 recovery attempts",
    );
    expect(screen.queryByText("3/2")).not.toBeInTheDocument();
  });

  it("stops an active task only after the shared confirmation succeeds", async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    const onOpen = vi.fn();
    render(
      <TaskCard
        task={{ ...taskFixture, status: "in_progress" }}
        allTasks={[]}
        models={[modelFixture]}
        onStop={onStop}
        onSelect={onOpen}
      />,
    );

    const stop = screen.getByRole("button", { name: "Stop" });
    await user.click(stop);
    expect(
      screen.getByRole("dialog", { name: `Stop "${taskFixture.title}"?` }),
    ).toBeVisible();
    expect(onStop).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(stop).toHaveFocus();
    await user.click(stop);
    await user.click(screen.getByRole("button", { name: "Stop task" }));
    expect(onStop).toHaveBeenCalledExactlyOnceWith(taskFixture.id);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("keeps a failed Stop confirmation open with a retryable inline error", async () => {
    const user = userEvent.setup();
    const onStop = vi
      .fn()
      .mockRejectedValueOnce(new Error("engine unavailable"))
      .mockResolvedValueOnce(undefined);
    render(
      <TaskCard
        task={{ ...taskFixture, status: "in_progress" }}
        allTasks={[]}
        models={[modelFixture]}
        onStop={onStop}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Stop" }));
    await user.click(screen.getByRole("button", { name: "Stop task" }));

    const dialog = screen.getByRole("dialog", {
      name: `Stop "${taskFixture.title}"?`,
    });
    expect(dialog).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not stop the task: engine unavailable",
    );

    await user.click(screen.getByRole("button", { name: "Stop task" }));
    expect(onStop).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByRole("dialog", { name: `Stop "${taskFixture.title}"?` }),
    ).not.toBeInTheDocument();
  });
});

describe("VW04 TaskCard outcome-first content", () => {
  it("shows the current activity and blockers first, keeping engineering chips off by default", () => {
    const dependency = { ...taskFixture, id: "dep", title: "Schema migration", status: "in_progress" as const };
    render(
      <TaskCard
        task={{
          ...taskFixture,
          status: "backlog",
          dependsOn: ["dep"],
          attempts: 2,
          prNumber: undefined,
        }}
        allTasks={[dependency]}
        models={[modelFixture]}
      />,
    );
    expect(screen.getByText("Waiting on 1 task")).toBeVisible();
    expect(screen.getByText("waiting on Schema migration")).toHaveAttribute(
      "title",
      "Schema migration — in_progress",
    );
    expect(screen.queryByText(/Attempt 2/)).not.toBeInTheDocument();
    expect(screen.queryByText(modelFixture.displayName)).not.toBeInTheDocument();
    expect(screen.queryByText("Review available")).not.toBeInTheDocument();
  });

  it("names the exact blocked or failed reason and flags review evidence", () => {
    render(
      <TaskCard
        task={{
          ...taskFixture,
          status: "failed",
          statusReason: "Gates kept failing after 3 attempts: tests",
          prNumber: 42,
        }}
        allTasks={[]}
        models={[modelFixture]}
      />,
    );
    expect(
      screen.getByText("Failed: Gates kept failing after 3 attempts: tests"),
    ).toHaveAttribute("title", "Status: failed");
    expect(screen.getByText("Review available")).toBeVisible();
  });

  it("offers only the allowed actions in the card menu and runs them", async () => {
    const user = userEvent.setup();
    const onRunNext = vi.fn();
    const onDefer = vi.fn();
    const onRetry = vi.fn();
    const onSelect = vi.fn();
    const { rerender } = render(
      <TaskCard
        task={{ ...taskFixture, status: "backlog", dependsOn: [] }}
        allTasks={[]}
        models={[modelFixture]}
        onRunNext={onRunNext}
        onDefer={onDefer}
        onRetry={onRetry}
        onSelect={onSelect}
      />,
    );

    await user.click(screen.getByRole("button", { name: `Actions for ${taskFixture.title}` }));
    const menu = screen.getByRole("menu", { name: `Actions for ${taskFixture.title}` });
    expect(menu).toBeVisible();
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Open details",
      "Run next",
    ]);
    await user.click(screen.getByRole("menuitem", { name: "Run next" }));
    expect(onRunNext).toHaveBeenCalledExactlyOnceWith(taskFixture.id);
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    rerender(
      <TaskCard
        task={{ ...taskFixture, status: "ready", dependsOn: [] }}
        allTasks={[]}
        models={[modelFixture]}
        onRunNext={onRunNext}
        onDefer={onDefer}
        onRetry={onRetry}
        onSelect={onSelect}
      />,
    );
    await user.click(screen.getByRole("button", { name: `Actions for ${taskFixture.title}` }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Open details",
      "Move back to queue",
    ]);
    await user.click(screen.getByRole("menuitem", { name: "Move back to queue" }));
    expect(onDefer).toHaveBeenCalledExactlyOnceWith(taskFixture.id);

    rerender(
      <TaskCard
        task={{ ...taskFixture, status: "failed", dependsOn: [] }}
        allTasks={[]}
        models={[modelFixture]}
        onRunNext={onRunNext}
        onDefer={onDefer}
        onRetry={onRetry}
        onSelect={onSelect}
      />,
    );
    await user.click(screen.getByRole("button", { name: `Actions for ${taskFixture.title}` }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Open details",
      "Retry task",
    ]);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("opens from the keyboard without triggering on menu keystrokes", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <TaskCard
        task={{ ...taskFixture, status: "done", dependsOn: [], prNumber: 4 }}
        allTasks={[]}
        models={[modelFixture]}
        onSelect={onSelect}
      />,
    );
    const card = screen.getByRole("article", { name: taskFixture.title });
    card.focus();
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(taskFixture.id);
    expect(screen.getByText("Merged · PR #4")).toBeVisible();
  });
});

describe("taskCardPropsAreEqual", () => {
  const base: TaskCardProps = {
    task: taskFixture,
    allTasks: [taskFixture],
    models: [modelFixture],
    onSelect: undefined,
    onStop: undefined,
  };

  it("treats unchanged props and unrelated allTasks identity as equal", () => {
    const next = { ...base, allTasks: [taskFixture] };
    expect(taskCardPropsAreEqual(base, next)).toBe(true);
  });

  it("rerenders when the task, selection, a dependency task, or the view mode changes", () => {
    const dependency = { ...taskFixture, id: "dep" };
    const withDependency = {
      ...base,
      task: { ...taskFixture, dependsOn: ["dep"] },
      allTasks: [dependency],
    };
    expect(
      taskCardPropsAreEqual(withDependency, {
        ...withDependency,
        allTasks: [{ ...dependency, status: "done" }],
      }),
    ).toBe(false);
    expect(taskCardPropsAreEqual(base, { ...base, isSelected: true })).toBe(false);
    expect(taskCardPropsAreEqual(base, { ...base, engineering: true })).toBe(false);
    expect(taskCardPropsAreEqual(base, { ...base, onRetry: () => {} })).toBe(false);
  });
});
