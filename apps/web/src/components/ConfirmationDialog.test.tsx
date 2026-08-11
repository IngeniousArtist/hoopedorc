import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { errorMessage, useConfirmation } from "./ConfirmationDialog";

function Harness({ action }: { action: () => unknown | Promise<unknown> }) {
  const { requestConfirmation, confirmationDialog } = useConfirmation();
  const [draft, setDraft] = useState("");
  return (
    <>
      <label>
        Draft
        <input value={draft} onChange={(event) => setDraft(event.target.value)} />
      </label>
      <button
        type="button"
        onClick={() =>
          requestConfirmation({
            title: "Delete the draft?",
            description: "This cannot be undone.",
            confirmLabel: "Delete draft",
            pendingLabel: "Deleting…",
            tone: "danger",
            action,
            errorMessage: (error) =>
              `Could not delete the draft: ${errorMessage(error)}`,
          })
        }
      >
        Open confirmation
      </button>
      {confirmationDialog}
    </>
  );
}

describe("shared confirmation dialog", () => {
  it("contains focus, cancels with Escape, and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<Harness action={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Open confirmation" });

    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "Delete the draft?" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();

    await user.tab();
    expect(screen.getByRole("button", { name: "Delete draft" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("submits once while pending and retains caller input plus an actionable retry", async () => {
    let resolveAction!: () => void;
    const firstAttempt = new Promise<void>((resolve) => {
      resolveAction = resolve;
    });
    const action = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(firstAttempt)
      .mockRejectedValueOnce(new Error("Disk is busy"))
      .mockResolvedValueOnce();
    const user = userEvent.setup();
    render(<Harness action={action} />);

    await user.type(screen.getByRole("textbox", { name: "Draft" }), "keep me");
    await user.click(screen.getByRole("button", { name: "Open confirmation" }));
    const confirm = screen.getByRole("button", { name: "Delete draft" });
    await user.click(confirm);
    await user.click(screen.getByRole("button", { name: "Deleting…" }));
    expect(action).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Deleting…" })).toBeDisabled();

    await act(async () => resolveAction());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open confirmation" }));
    await user.click(screen.getByRole("button", { name: "Delete draft" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not delete the draft: Disk is busy",
    );
    expect(screen.getByRole("textbox", { name: "Draft" })).toHaveValue("keep me");
    expect(screen.getByRole("dialog", { name: "Delete the draft?" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Delete draft" }));
    expect(action).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
