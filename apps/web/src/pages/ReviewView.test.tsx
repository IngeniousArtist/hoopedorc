import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { api, apiBlob } from "../api/client";
import { ReviewView } from "./ReviewView";

vi.mock("../api/client", async (original) => ({ ...await original<typeof import("../api/client")>(), api: vi.fn(), apiBlob: vi.fn() }));
const mock = vi.mocked(api); const blob = vi.mocked(apiBlob); const handoff = vi.fn(); const select = vi.fn();
const task = { id: "t", projectId: "p", title: "Review the result", status: "in_review", attempts: 1, updatedAt: "v1", acceptanceCriteria: ["Show the expected screen"] };
const workspace = { id: "t", projectId: "p", taskId: "t", title: task.title, state: "available", headSha: "abcdef012345", branch: "orc/t", dirty: false };
const preview = { id: "preview", projectId: "p", taskId: "t", state: "ready", profile: { command: "npm", args: ["run", "dev"], readinessPath: "/", startupTimeoutSeconds: 30 }, headSha: workspace.headSha, dirty: false, startedAt: "2026-09-21", detail: "Preview ready", logs: "" };
const evidence = { id: "evidence", projectId: "p", taskId: "t", source: "browser", state: "failed", detail: "Expected text did not appear", freshness: "stale", freshnessReason: "The commit has changed.", startedAt: "2026-09-21", headSha: "older-sha", attempt: 1, environment: "Native host", viewport: { width: 390, height: 844 }, artifacts: [{ id: "artifact", kind: "text", name: "failure.txt", bytes: 40, available: true, expiresAt: "2026-10-21" }] };
const context = { task, workspace, preview, browser: { available: true }, evidence: [evidence], evidenceTruncated: false, decisions: [], runs: [] };
function response(key: string) {
  if (key === "listTasks") return { tasks: [task] };
  if (key === "taskReview") return context;
  if (key === "workspacePreview") return { preview, profile: preview.profile, available: true, projectUpdatedAt: "project-v1" };
  if (key === "taskLogs") return { logs: [] };
  if (key === "workspaceFiles") return { files: [], truncated: false, workspace };
  throw new Error(key);
}
beforeEach(() => { mock.mockReset(); blob.mockReset(); handoff.mockReset(); select.mockReset(); mock.mockImplementation(async (key) => response(key)); });

it("shows failed stale evidence, loads authenticated diagnostics and hands a focused repair to planning", async () => {
  blob.mockResolvedValue(new Blob(["Browser assertion failed"], { type: "text/plain" }));
  render(<ReviewView projectId="p" taskId="t" onSelectTask={select} onAddToPlan={handoff} />);
  expect(screen.getByText("Loading review…")).toBeVisible();
  expect(await screen.findByText("The commit has changed.")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Read diagnostics" }));
  expect(await screen.findByText("Browser assertion failed")).toBeVisible();
  expect(blob).toHaveBeenCalledWith("reviewArtifact", expect.objectContaining({ params: { id: "p", taskId: "t", artifactId: "artifact" } }));
  await userEvent.click(screen.getByRole("button", { name: "Reference in repair" }));
  await userEvent.type(screen.getByLabelText("What should change?"), "Fix the missing button.");
  await userEvent.click(screen.getByRole("button", { name: "Add repair to plan" }));
  expect(handoff).toHaveBeenCalledWith(expect.stringContaining("Evidence evidence, HEAD older-sha, attempt 1, 390×844"));
  expect(handoff.mock.calls[0]?.[0]).toContain("Fix the missing button.");
  await userEvent.click(within(screen.getByRole("navigation", { name: "Review sections" })).getByRole("button", { name: "Checks" }));
  expect(await screen.findByText("No code-check decisions recorded yet.")).toBeVisible();
  expect(screen.queryByRole("button", { name: /approve.*merge/i })).not.toBeInTheDocument();
});

it("requires explicit capture confirmation, disables duplicates and confirms cancellation", async () => {
  const running = { ...evidence, id: "new-check", state: "running", detail: "Starting browser", freshness: "unverified", artifacts: [] };
  let current = context;
  mock.mockImplementation(async (key) => {
    if (key === "taskReview") return current;
    if (key === "captureReview") { current = { ...context, evidence: [running] }; return { evidence: running }; }
    if (key === "cancelReviewCapture") { const cancelled = { ...running, state: "cancelled", detail: "Cancelled with evidence preserved" }; current = { ...context, evidence: [cancelled] }; return { evidence: cancelled }; }
    return response(key);
  });
  render(<ReviewView projectId="p" taskId="t" onSelectTask={select} onAddToPlan={handoff} />);
  await userEvent.click(await screen.findByRole("button", { name: "Run browser check" }));
  expect(mock.mock.calls.some(([key]) => key === "captureReview")).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "Confirm browser check" }));
  expect(await screen.findByRole("button", { name: "Browser check running…" })).toBeDisabled();
  const captured = mock.mock.calls.find(([key]) => key === "captureReview")![1]?.body;
  expect(captured).toMatchObject({ previewId: "preview", taskUpdatedAt: "v1", path: "/", viewport: { width: 1280, height: 800 }, steps: [] });
  await userEvent.click(screen.getByRole("button", { name: "Cancel browser check" }));
  expect(screen.getByRole("group", { name: "Confirm cancel browser check" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Confirm cancel" }));
  await waitFor(() => expect(mock.mock.calls.some(([key]) => key === "cancelReviewCapture")).toBe(true));
});

it("preserves failed capture input and request identity on retry, and explains unavailable browser checks", async () => {
  mock.mockImplementation(async (key) => { if (key === "captureReview") throw new Error("Connection lost. Retry this request."); return response(key); });
  const rendered = render(<ReviewView projectId="p" taskId="t" onSelectTask={select} onAddToPlan={handoff} />);
  const path = await screen.findByLabelText("Application path"); await userEvent.clear(path); await userEvent.type(path, "/settings");
  await userEvent.click(screen.getByRole("button", { name: "Run browser check" }));
  await userEvent.click(screen.getByRole("button", { name: "Confirm browser check" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Connection lost"); expect(path).toHaveValue("/settings");
  await userEvent.click(screen.getByRole("button", { name: "Confirm browser check" }));
  const calls = mock.mock.calls.filter(([key]) => key === "captureReview"); expect(calls).toHaveLength(2); expect(calls[0]?.[1]?.body).toEqual(calls[1]?.[1]?.body);
  rendered.unmount();
  mock.mockImplementation(async (key) => key === "taskReview" ? { ...context, browser: { available: false, reason: "Chromium unavailable" } } : response(key));
  render(<ReviewView projectId="p" taskId="t" onSelectTask={select} onAddToPlan={handoff} />);
  expect(await screen.findByText("Chromium unavailable")).toBeVisible(); expect(screen.getByRole("button", { name: "Run browser check" })).toBeDisabled();
});

it("keeps load errors distinct from empty evidence and ignores a response for an old task", async () => {
  let finish!: (value: unknown) => void;
  mock.mockImplementation(async (key, options) => {
    if (key === "taskReview" && options?.params?.taskId === "t") return new Promise((resolve) => { finish = resolve; });
    if (key === "taskReview") throw new Error("Review history unavailable");
    return response(key);
  });
  const rendered = render(<ReviewView projectId="p" taskId="t" onSelectTask={select} onAddToPlan={handoff} />);
  rendered.rerender(<ReviewView projectId="p" taskId="other" onSelectTask={select} onAddToPlan={handoff} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Review history unavailable");
  await act(async () => finish(context));
  expect(screen.queryByText("Expected text did not appear")).not.toBeInTheDocument();
  expect(screen.queryByText(/No evidence recorded yet/)).not.toBeInTheDocument();
});

it("VW16: artifact output keeps diagnostics available without opening an unusable preview", async () => {
  mock.mockImplementation(async (key) => key === "taskReview" ? { ...context, output: "artifacts" } : response(key));
  render(<ReviewView projectId="p" taskId="t" onSelectTask={select} onAddToPlan={handoff} />);
  expect(await screen.findByRole("button", { name: "Artifacts", exact: true })).toBeVisible();
  expect(screen.getByRole("button", { name: "Browser check unavailable for artifact output" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Read diagnostics" })).toBeVisible();
  expect(mock.mock.calls.some(([key]) => key === "workspacePreview")).toBe(false);
});
