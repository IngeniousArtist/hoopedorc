import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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
});
