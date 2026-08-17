import type { Project, ServerEvent } from "@orc/types";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api/client";
import { App } from "./App";
import { notificationFixture, projectFixture } from "./test/fixtures";

const wsState = vi.hoisted(() => ({
  handler: undefined as ((event: ServerEvent) => void) | undefined,
  onProjectCreated: undefined as ((project: Project) => void) | undefined,
}));

vi.mock("./api/client", () => ({
  api: vi.fn(),
  setUnauthorizedHandler: vi.fn(),
}));
vi.mock("./hooks/useWS", () => ({
  useWS: (_projectId: string, handler: (event: ServerEvent) => void) => {
    wsState.handler = handler;
  },
}));
vi.mock("./hooks/useBrowserNotify", () => ({
  useBrowserNotify: () => ({ notify: vi.fn() }),
}));
vi.mock("./components/ProjectHeader", () => ({
  ProjectHeader: ({ project }: { project: { name: string } }) => (
    <div>{project.name}</div>
  ),
}));
vi.mock("./pages/Board", () => ({
  Board: () => <div>Board view</div>,
}));
vi.mock("./pages/NewProject", () => ({
  NewProject: ({
    onProjectCreated,
  }: {
    onProjectCreated: (project: Project) => void;
  }) => {
    wsState.onProjectCreated = onProjectCreated;
    return <div>New project view</div>;
  },
}));
vi.mock("./pages/PlanView", () => ({
  PlanView: () => <div>Plan view</div>,
}));

const apiMock = vi.mocked(api);

describe("application reconnect authority", () => {
  beforeEach(() => {
    apiMock.mockReset();
    wsState.handler = undefined;
    wsState.onProjectCreated = undefined;
    localStorage.clear();
    history.replaceState(null, "", "/");
    window.scrollTo = vi.fn();
  });

  it("replaces missed deletions and ignores older REST reads", async () => {
    let resolveProjects!: (value: {
      projects: Array<typeof projectFixture>;
    }) => void;
    let resolveNotifications!: (value: {
      notifications: Array<typeof notificationFixture>;
    }) => void;
    const projectRead = new Promise<{
      projects: Array<typeof projectFixture>;
    }>((resolve) => {
      resolveProjects = resolve;
    });
    const notificationRead = new Promise<{
      notifications: Array<typeof notificationFixture>;
    }>((resolve) => {
      resolveNotifications = resolve;
    });
    apiMock.mockImplementation(async (key) => {
      if (key === "listProjects") return projectRead;
      if (key === "listNotifications") return notificationRead;
      throw new Error(`Unexpected API call: ${key}`);
    });
    render(<App />);

    const deleted = {
      ...projectFixture,
      id: "project-deleted-while-offline",
      name: "Deleted while offline",
    };
    const survivor = {
      ...projectFixture,
      id: "project-survivor",
      name: "Surviving project",
    };
    const restoredApproval = {
      ...notificationFixture,
      id: "approval-restored-from-snapshot",
    };

    act(() => {
      wsState.handler?.({ type: "project.updated", payload: deleted });
    });
    expect(
      screen.getByRole("option", { name: /Deleted while offline/ }),
    ).toBeVisible();

    act(() => {
      wsState.handler?.({
        type: "projects.snapshot",
        payload: { projects: [survivor] },
      });
      wsState.handler?.({
        type: "notifications.snapshot",
        payload: { notifications: [restoredApproval] },
      });
    });

    expect(
      screen.queryByRole("option", { name: /Deleted while offline/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /Surviving project/ }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: /Notifications1/ }),
    ).toBeVisible();

    await act(async () => {
      resolveProjects({ projects: [deleted] });
      resolveNotifications({ notifications: [] });
      await Promise.all([projectRead, notificationRead]);
    });

    expect(
      screen.queryByRole("option", { name: /Deleted while offline/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /Surviving project/ }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: /Notifications1/ }),
    ).toBeVisible();
  });

  it("preserves a locally created project across an older in-flight snapshot", async () => {
    const user = userEvent.setup();
    const survivor = {
      ...projectFixture,
      id: "project-existing",
      name: "Existing project",
    };
    const created = {
      ...projectFixture,
      id: "project-created-during-replay",
      name: "Created during replay",
    };
    apiMock.mockImplementation(async (key) => {
      if (key === "listProjects") return { projects: [survivor] };
      if (key === "listNotifications") return { notifications: [] };
      throw new Error(`Unexpected API call: ${key}`);
    });
    render(<App />);
    await screen.findByRole("option", { name: /Existing project/ });

    await user.click(screen.getByRole("button", { name: "+ New" }));
    expect(await screen.findByText("New project view")).toBeVisible();
    act(() => {
      wsState.onProjectCreated?.(created);
    });
    expect(await screen.findByText("Plan view")).toBeVisible();

    // This baseline was captured before createProject committed. Its queued
    // project.updated follows and confirms when the local preservation can end.
    act(() => {
      wsState.handler?.({
        type: "projects.snapshot",
        payload: { projects: [survivor] },
      });
    });
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue(
      created.id,
    );
    expect(
      screen.getByRole("option", { name: /Created during replay/ }),
    ).toBeVisible();

    act(() => {
      wsState.handler?.({ type: "project.updated", payload: created });
    });
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue(
      created.id,
    );
  });

  it("does not preserve a creation already observed before its HTTP response", async () => {
    const user = userEvent.setup();
    const survivor = {
      ...projectFixture,
      id: "project-existing-before-create",
      name: "Existing before create",
    };
    const created = {
      ...projectFixture,
      id: "project-broadcast-before-response",
      name: "Broadcast before response",
    };
    apiMock.mockImplementation(async (key) => {
      if (key === "listProjects") return { projects: [survivor] };
      if (key === "listNotifications") return { notifications: [] };
      throw new Error(`Unexpected API call: ${key}`);
    });
    render(<App />);
    await screen.findByRole("option", { name: /Existing before create/ });
    await user.click(screen.getByRole("button", { name: "+ New" }));

    // Normal server ordering: the live update precedes the HTTP response.
    act(() => {
      wsState.handler?.({ type: "project.updated", payload: created });
      wsState.onProjectCreated?.(created);
    });
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue(
      created.id,
    );

    // A later replacement snapshot omitting the project must still be able
    // to remove it (for example, after a project.deleted event was missed).
    act(() => {
      wsState.handler?.({
        type: "projects.snapshot",
        payload: { projects: [survivor] },
      });
    });
    expect(
      screen.queryByRole("option", { name: /Broadcast before response/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue(
      survivor.id,
    );
  });
});
