import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { modelFixture, taskFixture } from "../test/fixtures";
import { TaskCard } from "./TaskCard";

describe("TaskCard retry accounting", () => {
  it("labels consumed invocations, policy, and recovery allowance separately", () => {
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
        onClick={onOpen}
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
    expect(onStop).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("keeps a failed Stop confirmation open with a retryable inline error", async () => {
    const user = userEvent.setup();
    const onStop = vi.fn().mockRejectedValue(new Error("Agent would not settle"));
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

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not stop the task: Agent would not settle",
    );
    expect(
      screen.getByRole("dialog", { name: `Stop "${taskFixture.title}"?` }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Stop task" })).toBeEnabled();
  });
});
