import type { ServerEvent } from "@orc/types";
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { notificationFixture, projectFixture } from "../test/fixtures";
import { MissionControl } from "./MissionControl";

const wsState = vi.hoisted(() => ({
  handler: undefined as ((event: ServerEvent) => void) | undefined,
}));

vi.mock("../api/client", () => ({ api: vi.fn() }));
vi.mock("../hooks/useWS", () => ({
  useWS: (_projectId: string, handler: (event: ServerEvent) => void) => {
    wsState.handler = handler;
  },
}));

const apiMock = vi.mocked(api);

describe("MissionControl notification authority", () => {
  beforeEach(() => {
    apiMock.mockReset();
    wsState.handler = undefined;
  });

  it("does not let an older REST read overwrite a reconnect snapshot", async () => {
    let resolveNotifications!: (value: {
      notifications: Array<typeof notificationFixture>;
    }) => void;
    const notificationRead = new Promise<{
      notifications: Array<typeof notificationFixture>;
    }>((resolve) => {
      resolveNotifications = resolve;
    });
    apiMock.mockReturnValue(notificationRead);
    render(
      <MissionControl
        projectId={projectFixture.id}
        tasks={[]}
        models={[]}
        activity={{}}
        activeSince={{}}
        costUsd={0}
        onViewNotifications={vi.fn()}
      />,
    );

    act(() => {
      wsState.handler?.({
        type: "notifications.snapshot",
        payload: { notifications: [notificationFixture] },
      });
    });
    expect(
      await screen.findByRole("button", { name: "1 pending approval →" }),
    ).toBeVisible();

    await act(async () => {
      resolveNotifications({ notifications: [] });
      await notificationRead;
    });

    expect(
      screen.getByRole("button", { name: "1 pending approval →" }),
    ).toBeVisible();
  });
});
