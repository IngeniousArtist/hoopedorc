import { render, screen } from "@testing-library/react";
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
});
