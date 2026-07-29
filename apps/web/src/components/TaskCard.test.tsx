import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
});
