import type { ResourcesResponse, Settings as SettingsType } from "@orc/types";
import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { settingsFixture } from "../test/fixtures";
import { ResourcesPanel } from "./ResourcesPanel";

vi.mock("../api/client", () => ({ api: vi.fn() }));
const apiMock = vi.mocked(api);
const empty: ResourcesResponse = { pools: [], unresolved: [], unpooledModels: ["codex"], providerAllowance: "unknown" };
function Wrapper({ initial = settingsFixture() }: { initial?: SettingsType }) {
  const [settings, setSettings] = useState(initial);
  return <><ResourcesPanel settings={settings} active onChange={(patch) => setSettings({ ...settings, ...patch })} /><output aria-label="Settings draft">{JSON.stringify(settings)}</output></>;
}
beforeEach(() => { apiMock.mockReset(); });
it("shows loading, empty and failed status without losing a pool draft; removal requires confirmation", async () => {
  let resolve!: (value: ResourcesResponse) => void;
  apiMock.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  render(<Wrapper />); expect(screen.getByText("Loading account usage…")).toBeVisible();
  await act(async () => resolve(empty)); expect(screen.getByText(/No shared pools yet/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Add account pool" }));
  fireEvent.change(screen.getByLabelText("Account 1 name"), { target: { value: "My subscription" } });
  const draft = JSON.parse(screen.getByLabelText("Settings draft").textContent!) as SettingsType;
  fireEvent.change(screen.getByLabelText("Codex account pool"), { target: { value: draft.accountPools![0]!.id } });
  apiMock.mockRejectedValueOnce(new Error("Offline")); fireEvent.click(screen.getByRole("button", { name: "Refresh usage" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Offline"); expect(screen.getByLabelText("Account 1 name")).toHaveValue("My subscription");
  fireEvent.click(screen.getByRole("button", { name: "Remove account pool" })); expect(screen.getByRole("group", { name: "Confirm pool removal" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" })); expect(screen.getByLabelText("Account 1 name")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Remove account pool" })); fireEvent.click(screen.getByRole("button", { name: "Remove pool from draft" }));
  expect(screen.getByLabelText("Codex account pool")).toHaveValue("");
});
it("requires stopped-worker confirmation and retries an ambiguous failure with the same receipt ID", async () => {
  const unresolved: ResourcesResponse = { ...empty, unresolved: [{ id: "call-1", model: "codex", stage: "author", poolId: "shared", state: "unresolved", createdAt: "start", updatedAt: "version-1" }] };
  let attempts = 0; let settle!: (value: unknown) => void;
  apiMock.mockImplementation(async (key) => {
    if (key === "resources") return attempts > 1 ? empty : unresolved;
    attempts++; if (attempts === 1) throw new Error("Connection lost");
    return new Promise((resolve) => { settle = resolve; });
  });
  render(<Wrapper />); fireEvent.click(await screen.findByRole("button", { name: "Resolve worker" }));
  expect(attempts).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "Worker is stopped · release slot" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Connection lost");
  fireEvent.click(screen.getByRole("button", { name: "Worker is stopped · release slot" }));
  expect(screen.getByRole("button", { name: "Releasing…" })).toBeDisabled();
  const requests = apiMock.mock.calls.filter(([key]) => key === "recoverResource"); expect(requests).toHaveLength(2); expect(requests[0]![1]).toEqual(requests[1]![1]);
  await act(async () => settle({})); expect(await screen.findByText(/Worker capacity released/)).toBeVisible();
  await waitFor(() => expect(screen.queryByRole("button", { name: "Resolve worker" })).not.toBeInTheDocument());
});
