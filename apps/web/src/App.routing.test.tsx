import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api/client";
import { projectFixture, settingsFixture } from "./test/fixtures";

/** App parses the initial hash once at module load, so each test sets the
 *  URL first and then imports a fresh module — exactly how a real page load
 *  with a pasted deep link behaves. */
async function loadApp() {
  vi.resetModules();
  return (await import("./App")).App;
}

const boardState = vi.hoisted(() => ({
  onSelectTask: undefined as ((taskId: string | null) => void) | undefined,
}));

vi.mock("./api/client", () => ({
  api: vi.fn(),
  setUnauthorizedHandler: vi.fn(),
}));
vi.mock("./hooks/useWS", () => ({ useWS: () => {} }));
vi.mock("./hooks/useBrowserNotify", () => ({
  useBrowserNotify: () => ({ notify: vi.fn() }),
}));
vi.mock("./components/ProjectHeader", () => ({
  ProjectHeader: ({ project }: { project: { name: string } }) => <div>{project.name}</div>,
}));
vi.mock("./pages/Board", () => ({
  Board: ({
    selectedTaskId,
    onSelectTask,
  }: {
    selectedTaskId?: string | null;
    onSelectTask?: (taskId: string | null) => void;
  }) => {
    boardState.onSelectTask = onSelectTask;
    return (
      <div>
        <span data-testid="inspected-task">{selectedTaskId ?? "none"}</span>
        <button type="button" onClick={() => onSelectTask?.("t-42")}>
          Open t-42
        </button>
        <button type="button" onClick={() => onSelectTask?.(null)}>
          Close inspector
        </button>
      </div>
    );
  },
}));
vi.mock("./pages/PlanView", () => ({ PlanView: () => <div>Plan view</div> }));
vi.mock("./pages/CostView", () => ({ CostView: () => <div>Costs view</div> }));

const apiMock = vi.mocked(api);
const project = { ...projectFixture, id: "proj-route", status: "paused" as const };

function mockApi() {
  apiMock.mockImplementation(async (key) => {
    if (key === "listProjects") return { projects: [project] };
    if (key === "listNotifications") return { notifications: [] };
    if (key === "getSettings") return { settings: settingsFixture() };
    throw new Error(`Unexpected API call: ${String(key)}`);
  });
}

describe("VW04 task inspector routing", () => {
  beforeEach(() => {
    apiMock.mockReset();
    boardState.onSelectTask = undefined;
    localStorage.clear();
    window.scrollTo = vi.fn();
    mockApi();
  });

  it("opens the inspector from a deep link and keeps the task in the URL while open", async () => {
    history.replaceState(null, "", "/#/p/proj-route/board/t-7");
    const App = await loadApp();
    render(<App />);
    expect(await screen.findByTestId("inspected-task")).toHaveTextContent("t-7");
    expect(location.hash).toBe("#/p/proj-route/board/t-7");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Close inspector" }));
    expect(screen.getByTestId("inspected-task")).toHaveTextContent("none");
    await waitFor(() => expect(location.hash).toBe("#/p/proj-route/board"));

    await user.click(screen.getByRole("button", { name: "Open t-42" }));
    await waitFor(() => expect(location.hash).toBe("#/p/proj-route/board/t-42"));
  });

  it("closes the inspector on browser Back and drops it when leaving the board", async () => {
    history.replaceState(null, "", "/#/p/proj-route/board");
    const App = await loadApp();
    render(<App />);
    expect(await screen.findByTestId("inspected-task")).toHaveTextContent("none");
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Open t-42" }));
    await waitFor(() => expect(location.hash).toBe("#/p/proj-route/board/t-42"));

    // Browser Back lands on the board URL without a task segment.
    await act(async () => {
      history.replaceState(null, "", "/#/p/proj-route/board");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(screen.getByTestId("inspected-task")).toHaveTextContent("none");

    await user.click(screen.getByRole("button", { name: "Open t-42" }));
    await waitFor(() => expect(location.hash).toBe("#/p/proj-route/board/t-42"));
    await user.click(screen.getByRole("button", { name: "Costs" }));
    await waitFor(() => expect(location.hash).toBe("#/p/proj-route/costs"));
    await user.click(screen.getByRole("button", { name: "Board" }));
    await waitFor(() => expect(location.hash).toBe("#/p/proj-route/board"));
    expect(screen.getByTestId("inspected-task")).toHaveTextContent("none");
  });
});
