import type { LogEvent } from "@orc/types";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LogPanel } from "./LogPanel";

function log(index: number, source = "engine"): LogEvent {
  return {
    id: `log-${index}`,
    projectId: "proj-test",
    runId: "run-1",
    taskId: "task-a",
    ts: "2026-08-17T00:00:00.000Z",
    level: "info",
    source,
    message: `line ${index}`,
  };
}

describe("LogPanel motion and omission", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes("prefers-reduced-motion: reduce"),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
  });

  it("scrolls the log container smoothly when motion is allowed", () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    render(<LogPanel logs={[log(1)]} loading={false} />);
    const scroller = screen.getByTestId("task-log-scroller");
    expect(scroller.scrollTo).toHaveBeenCalledWith({
      top: scroller.scrollHeight,
      behavior: "smooth",
    });
  });

  it("skips smooth scrolling when reduced motion is preferred", () => {
    render(<LogPanel logs={[log(1)]} loading={false} />);
    const scroller = screen.getByTestId("task-log-scroller");
    expect(scroller.scrollTo).toHaveBeenCalledWith({
      top: scroller.scrollHeight,
      behavior: "auto",
    });
  });

  it("shows an omission notice and keeps source filtering on the retained rows", async () => {
    const user = userEvent.setup();
    render(
      <LogPanel
        logs={[log(1, "engine"), log(2, "agent")]}
        loading={false}
        omittedOlder
      />,
    );
    expect(
      screen.getByText("Showing latest 1,000 lines. Older lines were omitted."),
    ).toBeVisible();
    expect(screen.getByText("line 1")).toBeVisible();
    await user.selectOptions(screen.getByRole("combobox"), "agent");
    expect(screen.queryByText("line 1")).not.toBeInTheDocument();
    expect(screen.getByText("line 2")).toBeVisible();
  });
});
