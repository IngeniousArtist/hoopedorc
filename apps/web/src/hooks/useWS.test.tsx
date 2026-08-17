import type { ServerEvent } from "@orc/types";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWS } from "./useWS";

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static readonly instances: FakeWebSocket[] = [];

  readonly send = vi.fn();
  readonly close = vi.fn(() => {
    this.readyState = FakeWebSocket.CLOSED;
  });
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  drop() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  message(event: ServerEvent) {
    this.raw(JSON.stringify(event));
  }

  raw(data: string) {
    this.onmessage?.({ data });
  }
}

function taskEvent(projectId: string, id: string): ServerEvent {
  return {
    type: "task.updated",
    payload: {
      id,
      projectId,
      title: id,
      description: "",
      difficulty: "easy",
      status: "ready",
      dependsOn: [],
      acceptanceCriteria: [],
      assignedModel: "deepseek-flash",
      scopePaths: [],
      attempts: 0,
      maxAttempts: 3,
      runGeneration: 0,
      runExtraAttempts: 0,
      runExhaustedModels: [],
      runRateLimitRetries: 0,
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z",
    },
  };
}

describe("project-owned shared WebSocket connections", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances.length = 0;
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("requests durable global catch-up when no project is selected", () => {
    const handler = vi.fn();
    const hook = renderHook(() => useWS("", handler));
    expect(FakeWebSocket.instances).toHaveLength(1);
    const socket = FakeWebSocket.instances[0]!;

    act(() => socket.open());
    expect(socket.send).toHaveBeenCalledOnce();
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "subscribe", projectId: "" }),
    );
    const event = {
      type: "project.updated",
      payload: { id: "created-elsewhere" },
    } as ServerEvent;
    act(() => socket.message(event));
    expect(handler).toHaveBeenCalledWith(event);

    hook.unmount();
    act(() => vi.runAllTimers());
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it("shares one socket with same-project subscribers and reference-counts teardown", () => {
    const first = vi.fn();
    const second = vi.fn();
    const hookA = renderHook(() => useWS("proj-test", first));
    const hookB = renderHook(() => useWS("proj-test", second));

    expect(FakeWebSocket.instances).toHaveLength(1);
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "subscribe", projectId: "proj-test" }),
    );

    const event = { type: "project.deleted", payload: { id: "proj-test" } } as ServerEvent;
    act(() => socket.message(event));
    expect(first).toHaveBeenCalledWith(event);
    expect(second).toHaveBeenCalledWith(event);

    hookA.unmount();
    act(() => vi.runAllTimers());
    expect(socket.close).not.toHaveBeenCalled();

    hookB.unmount();
    act(() => vi.runAllTimers());
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it("replays the running cost total to a subscriber mounted after the socket snapshot", () => {
    const first = vi.fn();
    const firstHook = renderHook(() => useWS("project-a", first));
    const socket = FakeWebSocket.instances[0]!;
    act(() => {
      socket.open();
      socket.message({
        type: "cost.snapshot",
        payload: { projectId: "project-a", totalUsd: 5 },
      });
      socket.message({
        type: "cost.updated",
        payload: {
          id: "cost-before-late-mount",
          projectId: "project-a",
          model: "deepseek-flash",
          costUsd: 0.25,
          tokensIn: 1,
          tokensOut: 1,
          tokensCached: 0,
          ts: "2026-08-17T00:00:00.000Z",
        },
      });
    });

    const late = vi.fn();
    const lateHook = renderHook(() => useWS("project-a", late));

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(late).toHaveBeenCalledOnce();
    expect(late).toHaveBeenCalledWith({
      type: "cost.snapshot",
      payload: { projectId: "project-a", totalUsd: 5.25 },
    });

    firstHook.unmount();
    lateHook.unmount();
    act(() => vi.runAllTimers());
  });

  it("does not replay a stale cost total to a subscriber mounted during reconnect backoff", () => {
    const firstHook = renderHook(() => useWS("project-a", vi.fn()));
    const socket = FakeWebSocket.instances[0]!;
    act(() => {
      socket.open();
      socket.message({
        type: "cost.snapshot",
        payload: { projectId: "project-a", totalUsd: 5 },
      });
      socket.drop();
    });

    const late = vi.fn();
    const lateHook = renderHook(() => useWS("project-a", late));

    expect(late).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1000));
    const replacement = FakeWebSocket.instances[1]!;
    act(() => {
      replacement.open();
      replacement.message({
        type: "cost.snapshot",
        payload: { projectId: "project-a", totalUsd: 6 },
      });
    });
    expect(late).toHaveBeenCalledOnce();
    expect(late).toHaveBeenCalledWith({
      type: "cost.snapshot",
      payload: { projectId: "project-a", totalUsd: 6 },
    });

    firstHook.unmount();
    lateHook.unmount();
    act(() => vi.runAllTimers());
  });

  it("isolates simultaneous different-project subscribers", () => {
    const first = vi.fn();
    const second = vi.fn();
    const hookA = renderHook(() => useWS("project-a", first));
    const hookB = renderHook(() => useWS("project-b", second));

    expect(FakeWebSocket.instances).toHaveLength(2);
    const socketA = FakeWebSocket.instances[0]!;
    const socketB = FakeWebSocket.instances[1]!;
    act(() => {
      socketA.open();
      socketB.open();
    });
    expect(socketA.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "subscribe", projectId: "project-a" }),
    );
    expect(socketB.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "subscribe", projectId: "project-b" }),
    );

    const eventA = taskEvent("project-a", "task-a");
    const eventB = taskEvent("project-b", "task-b");
    act(() => {
      socketA.message(eventA);
      socketB.message(eventB);
    });
    expect(first).toHaveBeenCalledWith(eventA);
    expect(first).not.toHaveBeenCalledWith(eventB);
    expect(second).toHaveBeenCalledWith(eventB);
    expect(second).not.toHaveBeenCalledWith(eventA);

    hookA.unmount();
    hookB.unmount();
    act(() => vi.runAllTimers());
    expect(socketA.close).toHaveBeenCalledOnce();
    expect(socketB.close).toHaveBeenCalledOnce();
  });

  it("reconnects a project manager with bounded backoff and resubscribes", () => {
    const handler = vi.fn();
    const hook = renderHook(() => useWS("project-a", handler));
    const first = FakeWebSocket.instances[0]!;
    act(() => {
      first.open();
      first.drop();
    });
    expect(FakeWebSocket.instances).toHaveLength(1);

    act(() => vi.advanceTimersByTime(999));
    expect(FakeWebSocket.instances).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(FakeWebSocket.instances).toHaveLength(2);
    const replacement = FakeWebSocket.instances[1]!;
    act(() => replacement.open());
    expect(replacement.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "subscribe", projectId: "project-a" }),
    );

    hook.unmount();
    act(() => vi.runAllTimers());
  });

  it("isolates a throwing subscriber from later same-project handlers", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const throwing = vi.fn(() => {
      throw new Error("view failed");
    });
    const healthy = vi.fn();
    const throwingHook = renderHook(() => useWS("project-a", throwing));
    const healthyHook = renderHook(() => useWS("project-a", healthy));
    const socket = FakeWebSocket.instances[0]!;
    act(() => {
      socket.open();
      socket.message(taskEvent("project-a", "shared-task"));
    });

    expect(throwing).toHaveBeenCalledOnce();
    expect(healthy).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledWith(
      "useWS subscriber failed for project project-a",
      expect.any(Error),
    );
    errorSpy.mockRestore();
    throwingHook.unmount();
    healthyHook.unmount();
  });

  it("recovers after malformed frames without losing the connection", () => {
    const handler = vi.fn();
    const hook = renderHook(() => useWS("project-a", handler));
    const socket = FakeWebSocket.instances[0]!;
    act(() => {
      socket.open();
      socket.raw("{malformed");
      socket.message(taskEvent("project-a", "after-malformed"));
    });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ type: "task.updated" }),
    );
    hook.unmount();
  });

  it("ignores a queued message from an old socket after replacement", () => {
    const handler = vi.fn();
    const hook = renderHook(() => useWS("project-a", handler));
    const first = FakeWebSocket.instances[0]!;
    act(() => {
      first.open();
      first.drop();
      vi.advanceTimersByTime(1000);
    });
    const replacement = FakeWebSocket.instances[1]!;
    act(() => {
      replacement.open();
      first.message(taskEvent("project-a", "stale"));
      replacement.message(taskEvent("project-a", "current"));
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "task.updated",
        payload: expect.objectContaining({ id: "current" }),
      }),
    );
    hook.unmount();
  });

  it("keeps a same-tick unmount/remount on one socket", () => {
    const first = renderHook(() => useWS("project-a", vi.fn()));
    first.unmount();
    const replacement = renderHook(() => useWS("project-a", vi.fn()));
    act(() => vi.runAllTimers());

    expect(FakeWebSocket.instances).toHaveLength(1);
    replacement.unmount();
    act(() => vi.runAllTimers());
  });

  it("removes stale managers so an old close cannot reconnect after cleanup", () => {
    const handler = vi.fn();
    const firstHook = renderHook(() => useWS("project-a", handler));
    const first = FakeWebSocket.instances[0]!;
    firstHook.unmount();
    act(() => vi.runAllTimers());
    expect(first.close).toHaveBeenCalledOnce();

    const secondHook = renderHook(() => useWS("project-a", handler));
    expect(FakeWebSocket.instances).toHaveLength(2);
    act(() => FakeWebSocket.instances[1]!.open());
    act(() => vi.runAllTimers());
    expect(FakeWebSocket.instances).toHaveLength(2);
    secondHook.unmount();
    act(() => vi.runAllTimers());
  });
});
