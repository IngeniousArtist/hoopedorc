import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { WorkspacePreview } from "./WorkspacePreview";

vi.mock("../api/client", async (original) => ({ ...await original<typeof import("../api/client")>(), api: vi.fn() }));
const mock = vi.mocked(api);
const profile = { command: "npm", args: ["run", "dev"], readinessPath: "/", startupTimeoutSeconds: 30 };
const context = { preview: null, profile, projectUpdatedAt: "v1", available: true };
const ready = { ...context, preview: { id: "session", state: "ready", isolation: "host", profile, headSha: "123456789", startedAt: "2026-09-21", detail: "Preview ready", logs: "Listening" } };
beforeEach(() => { mock.mockReset(); });

it("shows loading and unavailable reasons without launching a process", async () => {
  mock.mockResolvedValue({ ...context, available: false, reason: "Sandboxing is required." });
  render(<WorkspacePreview projectId="p" workspaceId="t" />);
  expect(screen.getByRole("status")).toHaveTextContent("Loading preview");
  expect(await screen.findByText("Sandboxing is required.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Start preview" })).toBeDisabled();
  expect(mock).toHaveBeenCalledTimes(1);
});

it("reviews the saved command, prevents duplicate launch, embeds ready preview and confirms stop", async () => {
  let starts = 0;
  mock.mockImplementation(async (key) => {
    if (key === "workspacePreview") return context;
    if (key === "startWorkspacePreview") { starts++; return ready; }
    if (key === "openWorkspacePreview") return { url: "http://127.0.0.1:4318/__hoop_session/ticket", expiresAt: "later" };
    if (key === "stopWorkspacePreview") return { ...ready, preview: { ...ready.preview, state: "stopped", detail: "Workspace files preserved." } };
    throw new Error(key);
  });
  render(<WorkspacePreview projectId="p" workspaceId="t" />);
  await userEvent.click(await screen.findByRole("button", { name: "Start preview" }));
  expect(screen.getByRole("group", { name: "Confirm start preview" })).toHaveTextContent("not a sandbox");
  expect(starts).toBe(0);
  await userEvent.click(screen.getByRole("button", { name: "Confirm start" }));
  expect(await screen.findByText("Preview ready")).toBeVisible();
  expect(screen.getByRole("button", { name: "Start preview" })).toBeDisabled();
  expect(starts).toBe(1);
  expect(mock).toHaveBeenCalledWith("startWorkspacePreview", expect.objectContaining({ body: { projectUpdatedAt: "v1" } }));
  await userEvent.click(screen.getByRole("button", { name: "Show preview here" }));
  expect(await screen.findByTitle("Task workspace preview")).toHaveAttribute("src", expect.stringContaining("ticket"));
  await userEvent.click(screen.getByRole("button", { name: "Stop preview" }));
  await userEvent.click(screen.getByRole("button", { name: "Confirm stop" }));
  expect(await screen.findByText("Workspace files preserved.")).toBeVisible();
  expect(screen.queryByTitle("Task workspace preview")).not.toBeInTheDocument();
});

it("preserves the command draft on validation and stale-save errors, then saves an explicitly reloaded version", async () => {
  let stale = true;
  mock.mockImplementation(async (key) => {
    if (key === "workspacePreview") return context;
    if (key === "setPreviewProfile") { if (stale) throw new Error("Project settings changed. Refresh and review."); return { ...context, projectUpdatedAt: "v2" }; }
    throw new Error(key);
  });
  render(<WorkspacePreview projectId="p" workspaceId="t" />);
  await userEvent.click(await screen.findByText("Preview command"));
  const args = screen.getByLabelText("Arguments (JSON array)");
  await userEvent.clear(args); await userEvent.type(args, "invalid JSON");
  await userEvent.click(screen.getByRole("button", { name: "Save preview command" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("JSON array");
  expect(args).toHaveValue("invalid JSON");
  await userEvent.click(screen.getByRole("button", { name: "Load current command" }));
  await userEvent.clear(screen.getByLabelText("Command")); await userEvent.type(screen.getByLabelText("Command"), "pnpm");
  await userEvent.click(screen.getByRole("button", { name: "Save preview command" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Project settings changed");
  expect(screen.getByLabelText("Command")).toHaveValue("pnpm");
  stale = false;
  await userEvent.click(screen.getByRole("button", { name: "Save preview command" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Preview command saved"));
});
