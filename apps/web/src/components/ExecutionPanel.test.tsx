import type { ExecutionProfile, ExecutionStatusResponse, Settings } from "@orc/types";
import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { settingsFixture } from "../test/fixtures";
import { ExecutionPanel } from "./ExecutionPanel";
vi.mock("../api/client", () => ({ api: vi.fn() }));
const apiMock = vi.mocked(api);
const empty: ExecutionStatusResponse = { platform: "linux", profiles: [], workers: [], host: { filesystemIsolated: false, networkIsolated: false, authentication: "host-cli" } };
const profile: ExecutionProfile = { id: "docker", name: "Codex worker", kind: "docker", runner: "codex", image: `sha256:${"a".repeat(64)}`, accountPoolId: "shared", accountVolume: "hoopedorc-account-test", cpus: 2, memoryMiB: 1024, pidsLimit: 128 };
const capability = { profileId: profile.id, runner: "codex" as const, state: "unavailable" as const, detail: "Separate worker login required", checkedAt: "2026-09-21T12:00:00Z" };
function Wrapper({ configured = false }: { configured?: boolean }) {
  const initial = settingsFixture(); initial.accountPools = [{ id: "shared", name: "Subscription", billing: "subscription", maxConcurrent: 2, reviewSlots: 1 }]; initial.executionProfiles = configured ? [profile] : [];
  initial.models = initial.models.map((model) => ({ ...model, accountPoolId: "shared", executionProfileId: configured && model.runner === "codex" ? profile.id : undefined }));
  const [settings, setSettings] = useState<Settings>(initial);
  return <><ExecutionPanel settings={settings} active onChange={(patch) => setSettings({ ...settings, ...patch })} /><div aria-label="Execution draft">{JSON.stringify(settings)}</div></>;
}
beforeEach(() => apiMock.mockReset());
it("loads, shows unavailable actions and preserves execution drafts when refresh fails", async () => {
  let resolve!: (value: ExecutionStatusResponse) => void; apiMock.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  render(<Wrapper />); expect(screen.getByText("Loading execution status…")).toBeVisible(); await act(async () => resolve(empty));
  expect(screen.getByText(/No isolated profiles/)).toBeVisible(); fireEvent.click(screen.getByRole("button", { name: "Add Docker profile" }));
  fireEvent.change(screen.getByLabelText("Worker 1 name"), { target: { value: "My worker" } }); expect(screen.getByRole("button", { name: "Verify worker" })).toBeDisabled();
  apiMock.mockRejectedValueOnce(new Error("Status offline")); fireEvent.click(screen.getByRole("button", { name: "Refresh workers" })); expect(await screen.findByRole("alert")).toHaveTextContent("Status offline"); expect(screen.getByLabelText("Worker 1 name")).toHaveValue("My worker");
});
it("verification reports refusal then success with immediate duplicate prevention", async () => {
  let finish!: (value: typeof capability) => void;
  apiMock.mockImplementation((key) => key === "verifyExecutionProfile" ? new Promise((done) => { finish = done; }) : Promise.resolve({ ...empty, profiles: [capability] }));
  render(<Wrapper configured />); const verify = await screen.findByRole("button", { name: "Verify worker" }); await waitFor(() => expect(verify).toBeEnabled());
  fireEvent.click(verify); expect(screen.getByRole("button", { name: "Verifying…" })).toBeDisabled(); await act(async () => finish(capability)); expect(await screen.findByRole("alert")).toHaveTextContent("Separate worker login required");
  apiMock.mockImplementation((key) => Promise.resolve(key === "verifyExecutionProfile" ? { ...capability, state: "verified", detail: "Worker login checked" } : { ...empty, profiles: [capability] }));
  fireEvent.click(screen.getByRole("button", { name: "Verify worker" })); expect(await screen.findByRole("status")).toHaveTextContent("Worker login checked");
});
it("profile removal requires explicit confirmation before returning assigned models to host", async () => {
  apiMock.mockResolvedValue({ ...empty, profiles: [capability] }); render(<Wrapper configured />);
  const remove = screen.getByRole("button", { name: "Remove execution profile" }); await waitFor(() => expect(remove).toBeEnabled()); fireEvent.click(remove);
  expect(screen.getByRole("group", { name: "Confirm execution profile removal" })).toHaveTextContent("return its models to host execution");
  expect(JSON.parse(screen.getByLabelText("Execution draft").textContent!).executionProfiles).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Remove from draft" })); expect(JSON.parse(screen.getByLabelText("Execution draft").textContent!).executionProfiles).toHaveLength(0);
});
it("unresolved worker recovery confirms termination, preserves error and can retry", async () => {
  const status = { ...empty, profiles: [capability], workers: [{ id: "w", invocationId: "i", profileId: "docker", imageId: profile.image, workerName: "owned-worker", proxyName: "owned-proxy", state: "unresolved", createdAt: capability.checkedAt, updatedAt: capability.checkedAt }] };
  apiMock.mockResolvedValue(status); render(<Wrapper configured />); fireEvent.click(await screen.findByRole("button", { name: "Stop owned worker" }));
  expect(screen.getByRole("group", { name: "Confirm worker termination" })).toBeVisible(); apiMock.mockRejectedValueOnce(new Error("Daemon offline; capacity protected"));
  fireEvent.click(screen.getByRole("button", { name: "Stop and verify" })); expect(await screen.findByRole("alert")).toHaveTextContent("capacity protected");
  apiMock.mockResolvedValueOnce(empty); fireEvent.click(screen.getByRole("button", { name: "Stop and verify" })); expect(await screen.findByRole("status")).toHaveTextContent("termination verified");
});
