import type { ServerEvent } from "@orc/types";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWS } from "./useWS";

const SLOW_CLIENT_CLOSE_CODE = 4008;
const SLOW_CLIENT_CLOSE_REASON = "slow client; resync required";

class BridgeServerSocket {
  readyState = 1;
  bufferedAmount = 0;

  constructor(private readonly browser: BridgeBrowserSocket) {}

  send(payload: string, callback?: (error?: Error) => void): void {
    if (this.readyState !== 1) {
      callback?.(new Error("server socket is closed"));
      return;
    }
    this.browser.onmessage?.({ data: payload });
    callback?.();
  }

  close(code = 1000, reason = "") {
    this.readyState = 3;
    this.browser.serverClose(code, reason);
  }

  terminate() {
    this.readyState = 3;
    this.browser.serverClose(1006, "terminated");
  }
}

class BridgeBrowserSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static readonly instances: BridgeBrowserSocket[] = [];
  static readonly snapshot: ServerEvent[] = [
    {
      type: "cost.snapshot",
      payload: { projectId: "project-a", totalUsd: 4.5 },
    },
    {
      type: "task.updated",
      payload: {
        id: "replayed-task",
        projectId: "project-a",
        title: "Replayed task",
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
    } as ServerEvent,
  ];

  readonly server: BridgeServerSocket;
  readonly url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    this.server = new BridgeServerSocket(this);
    BridgeBrowserSocket.instances.push(this);
  }

  open() {
    this.readyState = BridgeBrowserSocket.OPEN;
    this.server.readyState = BridgeBrowserSocket.OPEN;
    this.onopen?.();
  }

  send(payload: string) {
    const message = JSON.parse(payload) as {
      type?: string;
      projectId?: string;
    };
    if (message.type === "subscribe" && message.projectId === "project-a") {
      for (const event of BridgeBrowserSocket.snapshot) {
        this.server.send(JSON.stringify(event));
      }
    }
  }

  close() {
    this.readyState = BridgeBrowserSocket.CLOSED;
    this.server.readyState = BridgeBrowserSocket.CLOSED;
  }

  serverClose(code: number, reason: string) {
    this.readyState = BridgeBrowserSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  static forceSlowClose() {
    const active = [...BridgeBrowserSocket.instances]
      .reverse()
      .find((socket) => socket.readyState === BridgeBrowserSocket.OPEN);
    if (!active) throw new Error("no active browser socket");
    active.server.close(SLOW_CLIENT_CLOSE_CODE, SLOW_CLIENT_CLOSE_REASON);
  }

  static broadcast(event: ServerEvent) {
    const active = [...BridgeBrowserSocket.instances]
      .reverse()
      .find((socket) => socket.readyState === BridgeBrowserSocket.OPEN);
    if (!active) throw new Error("no active browser socket");
    active.server.send(JSON.stringify(event));
  }
}

describe("O6/O12 reconnect contract", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    BridgeBrowserSocket.instances.length = 0;
    vi.stubGlobal("WebSocket", BridgeBrowserSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("resyncs after 4008 with ordered task/cost snapshot then applies a delta", () => {
    const received: ServerEvent[] = [];
    const hook = renderHook(() => useWS("project-a", (event) => received.push(event)));
    const first = BridgeBrowserSocket.instances[0]!;
    act(() => first.open());
    expect(received.map((event) => event.type)).toEqual([
      "cost.snapshot",
      "task.updated",
    ]);

    received.length = 0;
    act(() => BridgeBrowserSocket.forceSlowClose());
    expect(first.readyState).toBe(BridgeBrowserSocket.CLOSED);
    act(() => vi.advanceTimersByTime(1000));
    const replacement = BridgeBrowserSocket.instances[1]!;
    act(() => replacement.open());
    act(() =>
      BridgeBrowserSocket.broadcast({
        type: "cost.updated",
        payload: {
          id: "cost-after-resync",
          projectId: "project-a",
          model: "deepseek-flash",
          costUsd: 0.25,
          tokensIn: 1,
          tokensOut: 1,
          tokensCached: 0,
          ts: "2026-08-11T00:00:01.000Z",
        },
      }),
    );

    expect(received.map((event) => event.type)).toEqual([
      "cost.snapshot",
      "task.updated",
      "cost.updated",
    ]);
    const total = received.reduce((sum, event) => {
      if (event.type === "cost.snapshot") return event.payload.totalUsd;
      if (event.type === "cost.updated") return sum + event.payload.costUsd;
      return sum;
    }, 0);
    expect(total).toBe(4.75);
    hook.unmount();
    act(() => vi.runAllTimers());
  });
});
