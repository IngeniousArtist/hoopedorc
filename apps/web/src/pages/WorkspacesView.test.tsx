import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { WorkspacesView } from "./WorkspacesView";

vi.mock("../api/client", async (original) => ({ ...await original<typeof import("../api/client")>(), api: vi.fn() }));
const apiMock = vi.mocked(api);
const workspace = { id: "primary", projectId: "p", title: "Primary clone", state: "available", branch: "main", headSha: "1234567", baseSha: "1234567", dirty: false, changedFiles: 0 };
const file = { workspace, path: "src/a.ts", content: "first\nsecond\n", contentSha: "hash-of-bytes", observedAt: "2026-09-21T00:00:00Z" };
const handoff = vi.fn();
beforeEach(() => { apiMock.mockReset(); handoff.mockReset(); });
function defaults(key: string) {
  if (key === "listWorkspaces") return { workspaces: [workspace] };
  if (key === "workspaceFiles") return { workspace, files: ["src/a.ts", "src/b.ts"].map((path) => ({ path, changed: false, untracked: false })), truncated: false };
  if (key === "workspaceFile") return file;
  if (key === "workspaceDiff") return { ...file, diff: "-old\n+new" };
  throw new Error(key);
}

it("inspects code/changes, filters files, and explicitly hands a bounded line reference to the plan", async () => {
  apiMock.mockImplementation(async (key) => defaults(key));
  render(<WorkspacesView projectId="p" onAddToPlan={handoff} />);
  expect(screen.getByRole("status")).toHaveTextContent("Loading workspaces");
  await userEvent.click(await screen.findByRole("button", { name: "src/a.ts" }));
  expect(await screen.findByLabelText("File contents")).toHaveTextContent("first");
  await userEvent.clear(screen.getByLabelText("To line")); await userEvent.type(screen.getByLabelText("To line"), "2");
  await userEvent.click(screen.getByRole("button", { name: "Add lines to plan" }));
  expect(handoff).toHaveBeenCalledWith(expect.stringContaining("first\nsecond"));
  expect(handoff.mock.calls[0]?.[0]).toContain("hash-of-bytes");
  await userEvent.click(screen.getByRole("button", { name: "Changes" }));
  expect(await screen.findByLabelText("File changes")).toHaveTextContent("+new");
  await userEvent.type(screen.getByLabelText("Find file"), "missing");
  expect(screen.getByText("No matching files.")).toBeVisible();
});

it("keeps inventory failures distinct from unavailable workspaces and retries explicitly", async () => {
  let first = true;
  apiMock.mockImplementation(async (key) => {
    if (key === "listWorkspaces") { if (first) { first = false; throw new Error("offline"); }
      return { workspaces: [{ ...workspace, state: "unavailable", reason: "Worktree was removed." }] }; }
    return defaults(key);
  });
  render(<WorkspacesView projectId="p" onAddToPlan={handoff} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("offline");
  await userEvent.click(screen.getByRole("button", { name: "Refresh workspaces" }));
  expect(await screen.findByText(/Worktree was removed/)).toBeVisible();
  expect(apiMock.mock.calls.some(([key]) => key === "workspaceFiles")).toBe(false);
});

it("ignores a stale file response after choosing another file, and surfaces read refusals", async () => {
  let finish!: (value: unknown) => void;
  apiMock.mockImplementation(async (key, opts) => {
    if (key === "workspaceFile" && opts?.query?.path === "src/a.ts") return new Promise((resolve) => { finish = resolve; });
    if (key === "workspaceFile") throw new Error("Binary file unavailable");
    return defaults(key);
  });
  render(<WorkspacesView projectId="p" onAddToPlan={handoff} />);
  await userEvent.click(await screen.findByRole("button", { name: "src/a.ts" }));
  await userEvent.click(screen.getByRole("button", { name: "src/b.ts" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Binary file unavailable");
  await act(async () => finish(file));
  await waitFor(() => expect(screen.queryByLabelText("File contents")).not.toBeInTheDocument());
});
