import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { SetupView } from "./SetupView";

vi.mock("../api/client", () => ({ api: vi.fn() }));

const apiMock = vi.mocked(api);

const runtimeHealth = {
  ok: true,
  mock: false,
  version: "0.7.0",
  state: "running",
  degraded: [],
  dependencies: {
    docker: {
      available: true,
      required: false,
      detail: "Docker is available.",
    },
    telegram: {
      enabled: false,
      running: false,
      state: "disabled",
    },
  },
};

const readyUpdate = {
  available: true,
  state: "idle",
  message: "No UI update has run yet.",
  branch: "main",
  fromCommit: "abc1234",
  updateUnit: "hoopedorc-self-update.service",
};

function installApiMock(updateStatus: Record<string, unknown> = readyUpdate) {
  apiMock.mockImplementation(async (key) => {
    if (key === "setupHealth") return { checks: [], allOk: true };
    if (key === "health") return runtimeHealth;
    if (key === "modelHealth") return { models: [] };
    if (key === "selfUpdateStatus") return updateStatus;
    if (key === "startSelfUpdate") {
      return {
        status: {
          ...readyUpdate,
          state: "queued",
          message: "Update queued in a separate systemd service.",
          startedAt: "2026-07-16T12:00:00.000Z",
          updatedAt: "2026-07-16T12:00:00.000Z",
          blockedReason: "An update is already in progress.",
        },
      };
    }
    throw new Error(`Unexpected API call: ${key}`);
  });
}

describe("SetupView self-update", () => {
  beforeEach(() => {
    apiMock.mockReset();
  });

  it("keeps the action visible but disabled with a manual fallback when unsupported", async () => {
    installApiMock({
      ...readyUpdate,
      available: false,
      unavailableReason: "UI updates require the Linux systemd deployment.",
    });
    render(<SetupView />);
    await userEvent.click(screen.getByRole("tab", { name: "Updates" }));

    expect(await screen.findByText("Update Hoopedorc")).toBeVisible();
    expect(screen.getByText("Unavailable")).toBeVisible();
    expect(screen.getByRole("button", { name: "Update & restart" })).toBeDisabled();
    expect(screen.getByText(/UI updates require the Linux systemd deployment/i)).toBeVisible();
    expect(screen.getByText("npm run update")).toBeVisible();
  });

  it("requires inline confirmation and launches the fixed POST action once", async () => {
    installApiMock();
    const user = userEvent.setup();
    render(<SetupView />);
    await userEvent.click(screen.getByRole("tab", { name: "Updates" }));

    const update = await screen.findByRole("button", { name: "Update & restart" });
    expect(update).toBeEnabled();
    await user.click(update);

    expect(
      screen.getByText(/Update and restart now\? The server will refuse/i),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Confirm update & restart" }),
    );

    expect(apiMock).toHaveBeenCalledWith("startSelfUpdate");
    expect(await screen.findByText("Update in progress…")).toBeDisabled();
    expect(screen.getByText("Queued")).toBeVisible();
  });

  it("preserves the confirmation and shows an inline recovery error", async () => {
    installApiMock();
    apiMock.mockImplementation(async (key) => {
      if (key === "setupHealth") return { checks: [], allOk: true };
      if (key === "health") return runtimeHealth;
      if (key === "modelHealth") return { models: [] };
      if (key === "selfUpdateStatus") return readyUpdate;
      if (key === "startSelfUpdate") {
        throw new Error("The working tree has unrelated changes.");
      }
      throw new Error(`Unexpected API call: ${key}`);
    });
    const user = userEvent.setup();
    render(<SetupView />);
    await userEvent.click(screen.getByRole("tab", { name: "Updates" }));

    await user.click(await screen.findByRole("button", { name: "Update & restart" }));
    await user.click(
      screen.getByRole("button", { name: "Confirm update & restart" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The working tree has unrelated changes.",
    );
    expect(
      screen.getByRole("button", { name: "Confirm update & restart" }),
    ).toBeEnabled();
  });

  it("separates overview, model health, and updates without triggering an action", async () => {
    installApiMock();
    render(<SetupView />);
    expect(await screen.findByText("Runtime healthy")).toBeVisible();
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("button", { name: "Test models" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Update & restart" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Models" }));
    expect(screen.getByText(/No configured models were reported/)).toBeVisible();
    await userEvent.click(screen.getByRole("tab", { name: "Updates" }));
    await userEvent.click(screen.getByRole("button", { name: "Update & restart" }));
    await userEvent.click(screen.getByRole("tab", { name: "Overview" }));
    await userEvent.click(screen.getByRole("tab", { name: "Updates" }));
    expect(screen.getByRole("button", { name: "Confirm update & restart" })).toBeVisible();
    expect(apiMock.mock.calls.some(([key]) => key === "testModels" || key === "startSelfUpdate")).toBe(false);
  });

  it("reports loading and failed model health, then recovers without showing failure as empty", async () => {
    installApiMock();
    const initialApi = apiMock.getMockImplementation()!;
    let fail!: (error: Error) => void;
    let reads = 0;
    apiMock.mockImplementation(async (key, options) => {
      if (key === "modelHealth" && reads++ === 0) return new Promise((_, reject) => { fail = reject; });
      return initialApi(key, options);
    });
    render(<SetupView />);
    await userEvent.click(screen.getByRole("tab", { name: "Models" }));
    expect(screen.getByRole("status")).toHaveTextContent("Loading model health");
    await act(async () => { fail(new Error("health store unavailable")); });
    expect(screen.getByRole("alert")).toHaveTextContent("health store unavailable");
    expect(screen.queryByText(/No configured models were reported/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText(/No configured models were reported/)).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

});
