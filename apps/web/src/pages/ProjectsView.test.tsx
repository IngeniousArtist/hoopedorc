import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { ToastProvider } from "../hooks/useToast";
import { projectFixture } from "../test/fixtures";
import { ProjectsView } from "./ProjectsView";

vi.mock("../api/client", () => ({ api: vi.fn() }));

const apiMock = vi.mocked(api);

function renderProjects() {
  render(
    <ToastProvider>
      <ProjectsView
        selectedProjectId={projectFixture.id}
        onSelect={vi.fn()}
        onDeleted={vi.fn()}
      />
    </ToastProvider>,
  );
}

describe("project destructive guards", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiMock.mockImplementation(async (key) => {
      if (key === "listProjects") return { projects: [projectFixture] };
      if (key === "pauseProject") return undefined;
      throw new Error(`Unexpected API call: ${key}`);
    });
  });

  it("blocks deletion while running and confirms an immediate stop", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderProjects();
    const stop = await screen.findByRole("button", { name: "⏹ Stop now" });

    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
    await user.click(stop);
    expect(apiMock.mock.calls.some(([key]) => key === "pauseProject")).toBe(false);

    confirm.mockReturnValue(true);
    await user.click(stop);
    expect(apiMock).toHaveBeenCalledWith("pauseProject", {
      params: { id: projectFixture.id },
      body: { drain: false },
    });
  });

  it("shows a toast when Stop now fails", async () => {
    apiMock.mockImplementation(async (key) => {
      if (key === "listProjects") return { projects: [projectFixture] };
      if (key === "pauseProject") throw new Error("Stop failed");
      throw new Error(`Unexpected API call: ${key}`);
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    renderProjects();
    await user.click(await screen.findByRole("button", { name: "⏹ Stop now" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Error: Stop failed");
  });
});
