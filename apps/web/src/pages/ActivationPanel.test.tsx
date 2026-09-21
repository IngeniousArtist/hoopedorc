import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { ActivationResponse, SaveActivationRequest } from "@orc/types";
import { api } from "../api/client";
import { ActivationPanel } from "./ActivationPanel";
vi.mock("../api/client", async (original) => ({ ...await original<typeof import("../api/client")>(), api: vi.fn() }));
const mock = vi.mocked(api); const handoff = vi.fn();
const response = (): ActivationResponse => ({ current: { projectId: "p", revision: 0, createdAt: "", policy: { mode: "inherit", skills: [], mcps: [], browser: false } }, revisions: [], manifests: [], compatibility: [], nativePlugins: { supported: false, reason: "Native bundles are not verified." } });
beforeEach(() => { sessionStorage.clear(); mock.mockReset(); handoff.mockReset(); });

it("shows loading, empty and unsupported states; saves only explicit choices and hands off a saved revision", async () => {
  let value = response();
  mock.mockImplementation((key, options) => {
    if (key === "projectActivation") return Promise.resolve(value);
    if (key === "saveProjectActivation") {
      const body = options?.body as SaveActivationRequest; const revision = { ...value.current, revision: 1, policy: body.policy };
      value = { ...value, current: revision, revisions: [revision] }; return Promise.resolve({ revision });
    }
    return Promise.reject(new Error(key));
  });
  render(<ActivationPanel projectId="p" entries={[]} onHandoff={handoff} />);
  expect(screen.getByText("Loading activation…")).toBeVisible();
  await screen.findByLabelText("Configuration mode");
  expect(screen.getByText(/No MCPs registered/)).toBeVisible();
  expect(screen.getByText("Native plugins · unavailable in selective mode")).toBeVisible();
  await userEvent.selectOptions(screen.getByLabelText("Configuration mode"), "selected");
  await userEvent.click(screen.getByLabelText(/Task browser/));
  await userEvent.click(screen.getByRole("button", { name: "Save activation" }));
  expect(await screen.findByText(/Activation saved/)).toBeVisible();
  expect(value.current.policy.browser).toBe(true);
  await userEvent.click(screen.getByText("Saved revisions and invocation history"));
  await userEvent.click(screen.getByRole("button", { name: "Use revision 1 in Plan" }));
  expect(handoff).toHaveBeenCalledWith(expect.stringContaining("hoop-activation:1"));
});

it("keeps a failed draft and its retry identity across navigation, then explicitly discards", async () => {
  mock.mockImplementation((key) => key === "projectActivation" ? Promise.resolve(response()) : Promise.reject(new Error("Activation changed in another session.")));
  const view = render(<ActivationPanel projectId="p" entries={[]} onHandoff={handoff} />);
  await userEvent.selectOptions(await screen.findByLabelText("Configuration mode"), "selected");
  await userEvent.click(screen.getByRole("button", { name: "Register MCP" }));
  await userEvent.type(screen.getByLabelText("MCP URL"), "https://example.com/mcp");
  await userEvent.click(screen.getByRole("button", { name: "Save activation" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("changed in another session");
  const first = mock.mock.calls.find(([key]) => key === "saveProjectActivation")?.[1]?.body;
  view.unmount(); render(<ActivationPanel projectId="p" entries={[]} onHandoff={handoff} />);
  expect(await screen.findByLabelText("MCP URL")).toHaveValue("https://example.com/mcp");
  await userEvent.click(screen.getByRole("button", { name: "Save activation" }));
  await waitFor(() => expect(mock.mock.calls.filter(([key]) => key === "saveProjectActivation")).toHaveLength(2));
  expect(mock.mock.calls.filter(([key]) => key === "saveProjectActivation")[1]?.[1]?.body).toEqual(first);
  await userEvent.click(screen.getByRole("button", { name: "Discard draft" }));
  expect(screen.getByLabelText("MCP URL")).toHaveValue("https://example.com/mcp");
  await userEvent.click(screen.getByRole("button", { name: "Discard edits" }));
  expect(screen.queryByLabelText("MCP URL")).not.toBeInTheDocument();
});

it("recovers an unavailable read and prevents duplicate saves", async () => {
  let finish: ((value: unknown) => void) | undefined;
  mock.mockRejectedValueOnce(new Error("Offline")).mockImplementation((key) => key === "projectActivation" ? Promise.resolve(response()) : new Promise((resolve) => { finish = resolve; }));
  render(<ActivationPanel projectId="p" entries={[]} onHandoff={handoff} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Offline");
  await userEvent.click(screen.getByRole("button", { name: "Reload activation" }));
  await userEvent.click(await screen.findByRole("button", { name: "Save activation" }));
  expect(screen.getByRole("button", { name: "Saving activation…" })).toBeDisabled();
  expect(screen.getByLabelText("Configuration mode")).toBeDisabled();
  finish?.({ revision: { ...response().current, revision: 1 } });
  expect(await screen.findByText(/Activation saved/)).toBeVisible();
});
