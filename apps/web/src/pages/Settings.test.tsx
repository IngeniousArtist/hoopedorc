import { SECRET_SENTINEL, type Settings as SettingsType } from "@orc/types";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  apiMock.mockImplementation(async (key, options) => {
    if (key === "getSettings") return { settings };
    if (key === "modelCatalog") return { generatedAt: "", catalogs: [] };
    if (key === "health") return healthFixture;
    if (key === "updateSettings") {
      if (update === "failure") throw new Error("Settings could not be saved");
      return { settings: (options?.body as { settings: SettingsType }).settings };
    }
    throw new Error(`Unexpected API call: ${key}`);
  });
  return settings;
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

  it("preserves edits across sections and validation failure, then saves one complete draft with secret sentinels", async () => {
    const settings = arrangeSettings("failure");
    settings.apiToken = SECRET_SENTINEL;
    settings.telegram = { ...settings.telegram!, botToken: SECRET_SENTINEL };
    const user = userEvent.setup();
    renderSettings();
    await screen.findByRole("tab", { name: "Run policy" });
    await user.click(screen.getByLabelText("Hold new dispatch while an approval is pending"));
    await user.click(screen.getByRole("tab", { name: "Guidelines" }));
    fireEvent.change(screen.getByLabelText("Coding"), { target: { value: "Keep this draft." } });
    await user.click(screen.getByRole("tab", { name: "Notifications" }));
    fireEvent.change(screen.getByLabelText("Telegram chat ID"), { target: { value: "12345" } });
    await user.click(screen.getByRole("tab", { name: "Installation" }));
    fireEvent.change(screen.getByLabelText("Default projects directory"), { target: { value: "/workspace/projects" } });
    await user.click(screen.getByRole("button", { name: "Save Settings" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your edits are kept in every section");
    await user.click(screen.getByRole("tab", { name: "Guidelines" }));
    expect(screen.getByLabelText("Coding")).toHaveValue("Keep this draft.");
    expect(screen.getByRole("status")).toHaveTextContent("Unsaved changes");
    const initialApi = apiMock.getMockImplementation()!;
    apiMock.mockImplementation(async (key, options) => key === "updateSettings"
      ? { settings: (options?.body as { settings: SettingsType }).settings }
      : initialApi(key, options));
    await user.click(screen.getByRole("button", { name: "Save Settings" }));
    expect(await screen.findByText("Settings saved.")).toBeVisible();
    const saves = apiMock.mock.calls.filter(([key]) => key === "updateSettings");
    expect(saves).toHaveLength(2);
    expect(saves[1]?.[1]?.body).toMatchObject({ settings: {
      holdWhileAwaitingApproval: true,
      guidelines: { coding: "Keep this draft." },
      telegram: { chatId: "12345", botToken: SECRET_SENTINEL },
      apiToken: SECRET_SENTINEL,
      defaultProjectsDir: "/workspace/projects",
      models: settings.models,
      routing: settings.routing,
    } });
  });

  it("supports keyboard section navigation and locks edits while the submitted draft is saving", async () => {
    const settings = arrangeSettings("success");
    const initialApi = apiMock.getMockImplementation()!;
    let finishSave!: (value: { settings: SettingsType }) => void;
    apiMock.mockImplementation(async (key, options) => key === "updateSettings"
      ? new Promise<{ settings: SettingsType }>((resolve) => { finishSave = resolve; })
      : initialApi(key, options));
    const user = userEvent.setup();
    renderSettings();
    (await screen.findByRole("tab", { name: "Run policy" })).focus();
    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "Installation" })).toHaveFocus();
    expect(screen.getByRole("tabpanel", { name: "Installation" })).toBeVisible();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Run policy" })).toHaveFocus();
    await user.click(screen.getByLabelText("Hold new dispatch while an approval is pending"));
    await user.click(screen.getByRole("button", { name: "Save Settings" }));
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(screen.getByLabelText("Merge policy")).toBeDisabled();
    await user.click(screen.getByRole("tab", { name: "Guidelines" }));
    expect(screen.getByLabelText("Coding")).toBeDisabled();
    await act(async () => { finishSave({ settings: { ...settings, holdWhileAwaitingApproval: true } }); });
    expect(screen.getByLabelText("Coding")).toBeEnabled();
    expect(screen.getByText("Settings saved.")).toBeVisible();
  });

  it("retries an unavailable initial settings read", async () => {
    arrangeSettings("success");
    const initialApi = apiMock.getMockImplementation()!;
    let reads = 0;
    apiMock.mockImplementation(async (key, options) => {
      if (key === "getSettings" && reads++ === 0) throw new Error("server unavailable");
      return initialApi(key, options);
    });
    renderSettings();
    expect(await screen.findByRole("alert")).toHaveTextContent("server unavailable");
    await userEvent.click(screen.getByRole("button", { name: "Retry settings" }));
    expect(await screen.findByRole("tab", { name: "Run policy" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

});
