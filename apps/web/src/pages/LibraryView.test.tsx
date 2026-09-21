import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { LibraryView } from "./LibraryView";

vi.mock("../api/client", async (original) => ({ ...await original<typeof import("../api/client")>(), api: vi.fn() }));
const mock = vi.mocked(api); const handoff = vi.fn();
const reference = { id: "design", projectId: "p", revision: 1, title: "Design rules", kind: "design", source: { type: "text", locator: "" }, applicability: "UI tasks", conflictGroup: "", content: "Use components.", contentSha: "hash", createdAt: "2026-09-21", archived: false, provenance: "operator" };
const entry = { ...reference, contentBytes: 15, conflictsWith: [], referencedByTasks: [] };
beforeEach(() => { sessionStorage.clear(); mock.mockReset(); handoff.mockReset(); mock.mockImplementation(async (key) => {
  if (key === "projectLibrary") return { entries: [entry] };
  if (key === "libraryReference") return { reference, versions: [reference] };
  if (key === "libraryHandoff") return { markdown: "hoop-reference:design@1\nUse components." };
  throw new Error(key);
}); });

it("loads source history on demand and hands off only an explicit selection", async () => {
  render(<LibraryView projectId="p" onAddToPlan={handoff} />);
  expect(screen.getByText("Loading library…")).toBeVisible();
  expect(await screen.findByText("Design rules", { selector: "h2" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Add selected to plan" })).toBeDisabled();
  expect(screen.queryByText("Use components.")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "View Design rules" }));
  expect(await screen.findByLabelText("Reference contents")).toHaveTextContent("Use components.");
  await userEvent.click(screen.getByLabelText("Select Design rules"));
  await userEvent.click(screen.getByRole("button", { name: "Add selected to plan" }));
  await waitFor(() => expect(handoff).toHaveBeenCalledWith("hoop-reference:design@1\nUse components."));
  expect(mock).toHaveBeenCalledWith("libraryHandoff", expect.objectContaining({ body: { references: [{ id: "design", revision: 1 }] } }));
});

it("preserves failed edits and request identity on retry, including leaving and reopening Library", async () => {
  mock.mockImplementation(async (key) => {
    if (key === "projectLibrary") return { entries: [] };
    if (key === "saveLibraryReference") throw new Error("This reference changed in another session.");
    throw new Error(key);
  });
  const view = render(<LibraryView projectId="p" onAddToPlan={handoff} />);
  await userEvent.click(screen.getByRole("button", { name: "New reference" }));
  await userEvent.type(screen.getByLabelText("Reference title"), "My draft");
  await userEvent.type(screen.getByLabelText("Reference text"), "Keep these edits");
  await userEvent.click(screen.getByRole("button", { name: "Save reference" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("changed in another session");
  await userEvent.click(screen.getByRole("button", { name: "Save reference" }));
  const writes = mock.mock.calls.filter(([key]) => key === "saveLibraryReference");
  expect(writes[0]?.[1]?.body).toEqual(writes[1]?.[1]?.body);
  view.unmount(); render(<LibraryView projectId="p" onAddToPlan={handoff} />);
  expect(screen.getByLabelText("Reference text")).toHaveValue("Keep these edits");
  await userEvent.click(screen.getByRole("button", { name: "Cancel edit" }));
  expect(screen.getByLabelText("Reference text")).toHaveValue("Keep these edits");
  await userEvent.click(screen.getByRole("button", { name: "Discard draft" }));
  expect(screen.queryByLabelText("Reference text")).not.toBeInTheDocument();
});

it("confirms archive changes and surfaces conflict/refusal errors without losing selection", async () => {
  mock.mockImplementation(async (key) => {
    if (key === "projectLibrary") return { entries: [entry] };
    if (key === "libraryReference") return { reference, versions: [reference] };
    if (key === "libraryHandoff") throw new Error("Conflicting source revisions; select one.");
    if (key === "saveLibraryReference") return { reference: { ...reference, revision: 2, archived: true } };
    throw new Error(key);
  });
  render(<LibraryView projectId="p" onAddToPlan={handoff} />);
  await userEvent.click(await screen.findByLabelText("Select Design rules"));
  await userEvent.click(screen.getByRole("button", { name: "Add selected to plan" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Conflicting source revisions");
  expect(screen.getByLabelText("Select Design rules")).toBeChecked(); expect(handoff).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "View Design rules" }));
  await userEvent.click(await screen.findByRole("button", { name: "Archive reference" }));
  expect(mock.mock.calls.some(([key]) => key === "saveLibraryReference")).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "Confirm archive" }));
  expect(await screen.findByRole("button", { name: "Restore reference" })).toBeVisible();
});

it("shows empty and failed loading states with a working refresh", async () => {
  mock.mockRejectedValueOnce(new Error("Library offline")).mockResolvedValue({ entries: [] });
  render(<LibraryView projectId="p" onAddToPlan={handoff} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Library offline");
  await userEvent.click(screen.getByRole("button", { name: "Refresh library" }));
  expect(await screen.findByText(/No references yet/)).toBeVisible();
});
