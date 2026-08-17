import type { ServerEvent } from "@orc/types";
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api/client";
import { App } from "./App";
import { notificationFixture, projectFixture } from "./test/fixtures";

const wsState = vi.hoisted(() => ({
  handler: undefined as ((event: ServerEvent) => void) | undefined,
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

const apiMock = vi.mocked(api);

describe("application reconnect authority", () => {
  beforeEach(() => {
    apiMock.mockReset();
    wsState.handler = undefined;
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
});
