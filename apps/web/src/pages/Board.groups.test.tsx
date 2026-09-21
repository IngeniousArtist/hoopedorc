import type { Task } from "@orc/types";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { ToastProvider } from "../hooks/useToast";
import { settingsFixture, taskFixture } from "../test/fixtures";
import { Board } from "./Board";

vi.mock("../api/client", () => ({ api: vi.fn() }));
vi.mock("../hooks/useWS", () => ({ useWS: () => {} }));
vi.mock("../components/MissionControl", () => ({ MissionControl: () => null }));
vi.mock("../components/AddTaskForm", () => ({ AddTaskForm: () => null }));
vi.mock("../components/TaskDrawer", () => ({ TaskDrawer: () => null }));

const apiMock = vi.mocked(api);

function task(id: string, title: string, overrides: Partial<Task>): Task {
  return {
    ...taskFixture,
    id,
    projectId: "project-1",
    title,
    dependsOn: [],
    prNumber: undefined,
    statusReason: undefined,
    attempts: 0,
    ...overrides,
  };
}

const TASKS: Task[] = [
  task("backlog-1", "Write docs", { status: "backlog", dependsOn: ["run-1"] }),
  task("ready-1", "Add settings page", { status: "ready", attempts: 1 }),
  task("run-1", "Author login form", { status: "in_progress" }),
  task("repair-1", "Fix review notes", { status: "changes_requested", prNumber: 7 }),
  task("review-1", "Review auth gates", { status: "in_review", prNumber: 8 }),
  task("done-1", "Scaffold app", { status: "done", prNumber: 1 }),
  task("failed-1", "Broken probe", { status: "failed", statusReason: "Gates kept failing: tests" }),
];

function renderBoard() {
  return render(
    <ToastProvider>
      <Board projectId="project-1" />
    </ToastProvider>,
  );
}

function mockApi(updates: Array<{ id: string; body: unknown }>) {
  apiMock.mockImplementation(async (key, options) => {
    if (key === "listTasks") return { tasks: TASKS };
    if (key === "getSettings") return { settings: settingsFixture() };
    if (key === "costAnalytics") return { totalUsd: 2.5, budgetUsd: 10 };
    if (key === "estimatePlan") return { tasks: [] };
    if (key === "updateTask") {
      const id = options?.params?.id ?? "";
      updates.push({ id, body: options?.body });
      const current = TASKS.find((t) => t.id === id)!;
      return { task: { ...current, ...(options?.body as Partial<Task>) } };
    }
    throw new Error(`Unexpected API call: ${String(key)}`);
  });
}

describe("VW04 board groups", () => {
  beforeEach(() => {
    apiMock.mockReset();
    localStorage.clear();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  it("groups every status into five outcome columns with counts and the compact summary", async () => {
    mockApi([]);
    renderBoard();
    expect(await screen.findByRole("region", { name: "Planned (2)" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Working (2)" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Review (1)" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Done (1)" })).toBeVisible();
    const attention = screen.getByRole("region", { name: "Needs attention (1)" });
    expect(within(attention).getByText("Failed: Gates kept failing: tests")).toBeVisible();
    expect(within(screen.getByRole("region", { name: "Working (2)" })).getByText(
      "Repairing after review feedback · PR #7",
    )).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "Tasks done" })).toHaveAttribute(
      "aria-valuenow",
      "1",
    );
    expect(screen.getByText("1/7 done")).toBeVisible();
    expect(screen.getByText("$2.50 spent of $10.00")).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "Budget used" })).toHaveAttribute(
      "aria-valuenow",
      "25",
    );
    expect(screen.getByRole("button", { name: "Needs attention · 1" })).toBeVisible();
    // Engineering chips stay off the cards by default.
    expect(screen.queryByText(/Attempt 1/)).not.toBeInTheDocument();
  });

  it("accepts a drop only on Planned and expresses it as run-next, never as a manufactured status", async () => {
    const updates: Array<{ id: string; body: unknown }> = [];
    mockApi(updates);
    renderBoard();
    const planned = await screen.findByRole("region", { name: "Planned (2)" });
    const done = screen.getByRole("region", { name: "Done (1)" });
    const dataTransfer = { getData: () => "backlog-1", dropEffect: "move" };

    fireEvent.drop(done, { dataTransfer });
    expect(updates).toEqual([]);

    fireEvent.dragOver(planned, { dataTransfer });
    fireEvent.drop(planned, { dataTransfer });
    await waitFor(() => expect(updates).toEqual([{ id: "backlog-1", body: { status: "ready" } }]));
  });

  it("offers Run next / Move back to queue from the card menu with the same server semantics", async () => {
    const updates: Array<{ id: string; body: unknown }> = [];
    mockApi(updates);
    const user = userEvent.setup();
    renderBoard();
    await screen.findByRole("region", { name: "Planned (2)" });

    await user.click(screen.getByRole("button", { name: "Actions for Write docs" }));
    await user.click(screen.getByRole("menuitem", { name: "Run next" }));
    await waitFor(() => expect(updates).toContainEqual({ id: "backlog-1", body: { status: "ready" } }));

    await user.click(screen.getByRole("button", { name: "Actions for Add settings page" }));
    await user.click(screen.getByRole("menuitem", { name: "Move back to queue" }));
    await waitFor(() =>
      expect(updates).toContainEqual({ id: "ready-1", body: { status: "backlog" } }),
    );
  });

  it("shows a status-filtered list on phones, opening on the most urgent group", async () => {
    localStorage.setItem("hoop.board.view", "list");
    mockApi([]);
    const user = userEvent.setup();
    renderBoard();

    const tabs = await screen.findByRole("tablist", { name: "Task groups" });
    expect(within(tabs).getByRole("tab", { name: /Needs attention/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("Failed: Gates kept failing: tests")).toBeVisible();
    expect(screen.queryByText("Author login form")).not.toBeInTheDocument();

    await user.click(within(tabs).getByRole("tab", { name: /Working/ }));
    expect(screen.getByText("Author login form")).toBeVisible();
    expect(screen.queryByText("Broken probe")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Needs attention · 1" }));
    expect(within(tabs).getByRole("tab", { name: /Needs attention/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("Broken probe")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Kanban" }));
    expect(localStorage.getItem("hoop.board.view")).toBe("kanban");
    expect(await screen.findByRole("region", { name: "Working (2)" })).toBeVisible();
  });

  it("defaults to the list on a phone-width viewport and to Kanban otherwise", async () => {
    const matchMedia = vi.mocked(window.matchMedia);
    matchMedia.mockImplementationOnce((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    mockApi([]);
    renderBoard();
    expect(await screen.findByRole("tablist", { name: "Task groups" })).toBeVisible();
    expect(screen.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
  });

  it("toggles engineering details on the cards and remembers the choice", async () => {
    mockApi([]);
    const user = userEvent.setup();
    renderBoard();
    await screen.findByRole("region", { name: "Planned (2)" });
    expect(screen.queryByText("Attempt 1 · policy 3")).not.toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Engineering details" }));
    expect(screen.getByText("Attempt 1 · policy 3")).toBeVisible();
    expect(localStorage.getItem("hoop.board.engineering")).toBe("1");
  });
});
