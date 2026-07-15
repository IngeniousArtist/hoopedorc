import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { BrowserNotifyProvider } from "../hooks/useBrowserNotify";
import { healthFixture, settingsFixture } from "../test/fixtures";
import { Settings } from "./Settings";

vi.mock("../api/client", () => ({ api: vi.fn() }));

const apiMock = vi.mocked(api);

function arrangeSettings(update: "success" | "failure") {
  const settings = settingsFixture();
  apiMock.mockImplementation(async (key) => {
    if (key === "getSettings") return { settings };
    if (key === "setupModels") return { models: [] };
    if (key === "health") return healthFixture;
    if (key === "updateSettings") {
      if (update === "failure") throw new Error("Settings could not be saved");
      return { settings: { ...settings, holdWhileAwaitingApproval: true } };
    }
    throw new Error(`Unexpected API call: ${key}`);
  });
}

function renderSettings(onDirtyChange = vi.fn()) {
  render(
    <BrowserNotifyProvider>
      <Settings onDirtyChange={onDirtyChange} />
    </BrowserNotifyProvider>,
  );
  return onDirtyChange;
}

describe("Settings dirty and save behavior", () => {
  beforeEach(() => {
    apiMock.mockReset();
  });

  it("keeps edits dirty and presents a recoverable error when save fails", async () => {
    arrangeSettings("failure");
    const user = userEvent.setup();
    const onDirtyChange = renderSettings();
    await screen.findByRole("heading", { name: "Settings" });

    await user.click(screen.getByLabelText("Hold new dispatch while an approval is pending"));
    expect(screen.getByText("Unsaved changes")).toBeVisible();
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    await user.click(screen.getByRole("button", { name: "Save Settings" }));
    expect(await screen.findByText("Error: Settings could not be saved")).toBeVisible();
    expect(screen.getByText("Unsaved changes")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save Settings" })).toBeEnabled();
  });

  it("clears dirty state and confirms a successful save", async () => {
    arrangeSettings("success");
    const user = userEvent.setup();
    const onDirtyChange = renderSettings();
    await screen.findByRole("heading", { name: "Settings" });

    await user.click(screen.getByLabelText("Hold new dispatch while an approval is pending"));
    await user.click(screen.getByRole("button", { name: "Save Settings" }));

    expect(await screen.findByText("Settings saved.")).toBeVisible();
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
  });
});
