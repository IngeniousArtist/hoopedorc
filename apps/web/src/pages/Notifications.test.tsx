import type { ServerEvent } from "@orc/types";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { notificationFixture, projectFixture } from "../test/fixtures";
import { Notifications } from "./Notifications";

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

describe("approval decisions", () => {
  beforeEach(() => {
    apiMock.mockReset();
    wsState.handler = undefined;
    apiMock.mockImplementation(async (key) => {
      if (key === "listNotifications") return { notifications: [notificationFixture] };
      if (key === "respondNotification") return undefined;
      throw new Error(`Unexpected API call: ${key}`);
    });
  });

  it("replaces stale rows with the durable reconnect snapshot", async () => {
    render(<Notifications projectId={projectFixture.id} />);
    await screen.findByRole("button", { name: "Approve" });
    const restored = {
      ...notificationFixture,
      id: "approval-missed-while-offline",
      title: "Approval restored after reconnect",
    };

    act(() => {
      wsState.handler?.({
        type: "notifications.snapshot",
        payload: { notifications: [restored] },
      });
    });

    expect(
      await screen.findByText("Approval restored after reconnect"),
    ).toBeVisible();
  });

  it("does not let an older REST read overwrite a newer reconnect snapshot", async () => {
    let resolveList!: (value: {
      notifications: Array<typeof notificationFixture>;
    }) => void;
    const list = new Promise<{
      notifications: Array<typeof notificationFixture>;
    }>((resolve) => {
      resolveList = resolve;
    });
    apiMock.mockImplementation(async (key) => {
      if (key === "listNotifications") return list;
      throw new Error(`Unexpected API call: ${key}`);
    });
    render(<Notifications projectId={projectFixture.id} />);
    const restored = {
      ...notificationFixture,
      id: "approval-newer-than-rest-read",
      title: "Newer approval remains visible",
    };

    act(() => {
      wsState.handler?.({
        type: "notifications.snapshot",
        payload: { notifications: [restored] },
      });
    });
    expect(
      await screen.findByText("Newer approval remains visible"),
    ).toBeVisible();

    await act(async () => {
      resolveList({ notifications: [notificationFixture] });
      await list;
    });

    expect(screen.getByText("Newer approval remains visible")).toBeVisible();
    expect(
      screen.queryByText(notificationFixture.title),
    ).not.toBeInTheDocument();
  });

  it("submits and reflects an approval", async () => {
    const user = userEvent.setup();
    render(<Notifications projectId={projectFixture.id} />);
    await user.click(await screen.findByRole("button", { name: "Approve" }));

    expect(apiMock).toHaveBeenCalledWith("respondNotification", {
      params: { id: notificationFixture.id },
      body: { choice: "approve" },
    });
    expect(await screen.findByText("Responded: approve")).toBeVisible();
  });

  it("does not let an older reconnect snapshot undo a persisted response", async () => {
    let resolveResponse!: (value: {
      notification: typeof notificationFixture;
      delivery: "applied";
    }) => void;
    const response = new Promise<{
      notification: typeof notificationFixture;
      delivery: "applied";
    }>((resolve) => {
      resolveResponse = resolve;
    });
    apiMock.mockImplementation(async (key) => {
      if (key === "listNotifications") {
        return { notifications: [notificationFixture] };
      }
      if (key === "respondNotification") return response;
      throw new Error(`Unexpected API call: ${key}`);
    });
    const user = userEvent.setup();
    render(<Notifications projectId={projectFixture.id} />);
    await user.click(await screen.findByRole("button", { name: "Approve" }));

    const persisted = {
      ...notificationFixture,
      respondedWith: "approve",
      approvalDelivery: "applied" as const,
    };
    resolveResponse({ notification: persisted, delivery: "applied" });
    expect(await screen.findByText("Responded: approve")).toBeVisible();

    act(() => {
      wsState.handler?.({
        type: "notifications.snapshot",
        payload: { notifications: [notificationFixture] },
      });
    });

    expect(screen.getByText("Responded: approve")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("keeps the decision available and surfaces a failed response", async () => {
    apiMock.mockImplementation(async (key) => {
      if (key === "listNotifications") return { notifications: [notificationFixture] };
      if (key === "respondNotification") throw new Error("Approval delivery failed");
      throw new Error(`Unexpected API call: ${key}`);
    });
    const user = userEvent.setup();
    render(<Notifications projectId={projectFixture.id} />);
    await user.click(await screen.findByRole("button", { name: "Approve" }));

    expect(await screen.findByText("Error: Error: Approval delivery failed")).toBeVisible();
  });

  it("shows a durable queued choice without pretending it was applied", async () => {
    apiMock.mockImplementation(async (key) => {
      if (key === "listNotifications") {
        return { notifications: [notificationFixture] };
      }
      if (key === "respondNotification") {
        return {
          notification: {
            ...notificationFixture,
            respondedWith: "approve",
            approvalDelivery: "recorded",
            responseRecordedAt: "2026-08-11T00:00:00.000Z",
          },
          delivery: "queued",
        };
      }
      throw new Error(`Unexpected API call: ${key}`);
    });
    const user = userEvent.setup();
    render(<Notifications projectId={projectFixture.id} />);
    await user.click(await screen.findByRole("button", { name: "Approve" }));

    expect(
      await screen.findByText(
        "Recorded: approve — waiting for the task to recover",
      ),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();

    act(() => {
      wsState.handler?.({
        type: "notifications.snapshot",
        payload: {
          notifications: [
            {
              ...notificationFixture,
              respondedWith: "approve",
              approvalDelivery: "applied",
            },
          ],
        },
      });
    });
    expect(screen.getByText("Responded: approve")).toBeVisible();
    expect(
      screen.queryByText("Recorded: approve — waiting for the task to recover"),
    ).not.toBeInTheDocument();
  });
});
