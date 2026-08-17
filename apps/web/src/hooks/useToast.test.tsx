import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast } from "./useToast";

function Trigger() {
  const toast = useToast();
  return (
    <button type="button" onClick={() => toast("Saved", "success")}>
      Notify
    </button>
  );
}

describe("toast timer ownership", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("dismisses a toast after the timeout", () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Notify" }));
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("clears pending dismissal timers on provider unmount", () => {
    const setSpy = vi.spyOn(globalThis, "setTimeout");
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const { unmount } = render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Notify" }));
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
    const timer = setSpy.mock.results.at(-1)?.value;
    unmount();
    expect(clearSpy).toHaveBeenCalledWith(timer);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
  });
});
