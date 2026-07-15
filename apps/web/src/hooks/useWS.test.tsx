import type { ServerEvent } from "@orc/types";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useWS } from "./useWS";

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly instances: FakeWebSocket[] = [];

  readonly send = vi.fn();
  readonly close = vi.fn(() => {
    this.readyState = 3;
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

  message(event: ServerEvent) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

describe("shared WebSocket updates", () => {
  it("shares one socket, subscribes once, and broadcasts updates to every hook", () => {
    vi.useFakeTimers();
    FakeWebSocket.instances.length = 0;
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
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
    hookB.unmount();
    act(() => vi.runAllTimers());
    expect(socket.close).toHaveBeenCalledOnce();
  });
});
