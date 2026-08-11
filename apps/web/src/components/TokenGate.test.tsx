import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TokenGate } from "./TokenGate";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TokenGate dialog semantics", () => {
  it("starts on the token field, contains Escape, and returns focus after success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const user = userEvent.setup();

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Authenticate
          </button>
          {open && <TokenGate onAuthenticated={() => setOpen(false)} />}
        </>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Authenticate" });
    await user.click(trigger);

    expect(
      screen.getByRole("dialog", { name: "Hoopedorc requires a token" }),
    ).toBeVisible();
    expect(screen.getByLabelText("API token")).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeVisible();

    await user.type(screen.getByLabelText("API token"), "secret");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
