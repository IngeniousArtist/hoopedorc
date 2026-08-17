import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { ServerEvent } from "@orc/types";
import type WebSocket from "ws";
import {
  WS_MAX_BUFFERED_AMOUNT,
  WS_SEND_FAILURE_CLOSE_CODE,
  WS_SEND_FAILURE_CLOSE_REASON,
  WS_SLOW_CLIENT_CLOSE_CODE,
  WS_SLOW_CLIENT_CLOSE_REASON,
  WS_SNAPSHOT_FAILURE_CLOSE_CODE,
  WS_SNAPSHOT_FAILURE_CLOSE_REASON,
  WsHub,
} from "./ws-hub.js";

class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  terminated = false;
  throwOnSend = false;
  asyncSendError: Error | undefined;
  throwOnClose = false;
  maxBufferedAmount = 0;
  deferSendCallbacks = false;
  readonly pendingSendCallbacks: Array<() => void> = [];

  send(payload: string, callback?: (error?: Error) => void): void {
    if (this.throwOnSend) throw new Error("socket write failed");
    this.sent.push(payload);
    this.bufferedAmount += Buffer.byteLength(payload);
    this.maxBufferedAmount = Math.max(
      this.maxBufferedAmount,
      this.bufferedAmount,
    );
    if (callback) {
      const error = this.asyncSendError;
      const deliver = () => {
        this.bufferedAmount = 0;
        callback(error);
      };
      if (this.deferSendCallbacks) this.pendingSendCallbacks.push(deliver);
      else queueMicrotask(deliver);
    }
  }

  deliverNext(): void {
    const deliver = this.pendingSendCallbacks.shift();
    if (!deliver) throw new Error("no pending send callback");
    deliver();
  }

  close(code?: number, reason?: string): void {
    if (this.throwOnClose) throw new Error("socket close failed");
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
  }
}

function subscribe(hub: WsHub, socket: FakeSocket, projectId: string): () => void {
  const remove = hub.add(socket as unknown as WebSocket);
  socket.emit(
    "message",
    Buffer.from(JSON.stringify({ type: "subscribe", projectId })),
  );
  return remove;
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

function notificationEvent(
  id: string,
): Extract<ServerEvent, { type: "notification" }> {
  return {
    type: "notification",
    payload: {
      id,
      projectId: "project-1",
      severity: "action_required",
      title: id,
      message: "approval required",
      requiresApproval: true,
      options: ["approve", "reject"],
      createdAt: "2026-08-17T00:00:00.000Z",
    },
  };
}

function parseEvent(payload: string): ServerEvent {
  return JSON.parse(payload) as ServerEvent;
}

test("O12: a slow client closes before an event is skipped while healthy clients continue", () => {
  const hub = new WsHub();
  const slow = new FakeSocket();
  const healthy = new FakeSocket();
  subscribe(hub, slow, "project-1");
  subscribe(hub, healthy, "project-1");
  slow.bufferedAmount = WS_MAX_BUFFERED_AMOUNT;

  const event = taskEvent("project-1", "slow-task");
  hub.broadcast(event);

  assert.deepEqual(slow.closeCalls, [
    {
      code: WS_SLOW_CLIENT_CLOSE_CODE,
      reason: WS_SLOW_CLIENT_CLOSE_REASON,
    },
  ]);
  assert.deepEqual(healthy.sent.map(parseEvent), [event]);
});

test("O12: one oversized live frame closes before it can exceed the byte ceiling", () => {
  const hub = new WsHub();
  const socket = new FakeSocket();
  subscribe(hub, socket, "project-1");
  const event = taskEvent("project-1", "oversized-live-task");
  if (event.type !== "task.updated") throw new Error("expected task event");
  event.payload.description = "x".repeat(WS_MAX_BUFFERED_AMOUNT);

  hub.broadcast(event);

  assert.deepEqual(socket.sent, []);
  assert.deepEqual(socket.closeCalls, [
    {
      code: WS_SLOW_CLIENT_CLOSE_CODE,
      reason: WS_SLOW_CLIENT_CLOSE_REASON,
    },
  ]);
});

test("O12: a throwing send closes only that socket and does not abort the broadcast", () => {
  const hub = new WsHub();
  const broken = new FakeSocket();
  const healthy = new FakeSocket();
  subscribe(hub, broken, "project-1");
  subscribe(hub, healthy, "project-1");
  broken.throwOnSend = true;

  const event = taskEvent("project-1", "broken-task");
  hub.broadcast(event);

  assert.deepEqual(broken.closeCalls, [
    { code: WS_SEND_FAILURE_CLOSE_CODE, reason: WS_SEND_FAILURE_CLOSE_REASON },
  ]);
  assert.deepEqual(healthy.sent.map(parseEvent), [event]);
});

test("O6: a snapshot provider failure closes before the socket can receive deltas", () => {
  const hub = new WsHub();
  hub.setSnapshotProvider(() => {
    throw new Error("database snapshot failed");
  });
  const socket = new FakeSocket();
  subscribe(hub, socket, "project-1");

  assert.deepEqual(socket.closeCalls, [
    {
      code: WS_SNAPSHOT_FAILURE_CLOSE_CODE,
      reason: WS_SNAPSHOT_FAILURE_CLOSE_REASON,
    },
  ]);
  hub.broadcast(taskEvent("project-1", "must-not-leak"));
  assert.deepEqual(socket.sent, []);
});

test("O6: snapshot serialization failure closes before any event can leak", () => {
  const hub = new WsHub();
  hub.setSnapshotProvider(() => [
    taskEvent("project-1", "would-have-leaked"),
    {
      type: "task.updated",
      payload: { projectId: "project-1", id: "bad", invalid: 1n },
    } as unknown as ServerEvent,
  ]);
  const socket = new FakeSocket();
  subscribe(hub, socket, "project-1");

  assert.deepEqual(socket.closeCalls, [
    {
      code: WS_SNAPSHOT_FAILURE_CLOSE_CODE,
      reason: WS_SNAPSHOT_FAILURE_CLOSE_REASON,
    },
  ]);
  assert.deepEqual(socket.sent, []);
  hub.broadcast(taskEvent("project-1", "must-not-leak-after-serialization"));
  assert.deepEqual(socket.sent, []);
});

test("O12: async send errors close only the still-live client", async () => {
  const hub = new WsHub();
  const broken = new FakeSocket();
  const healthy = new FakeSocket();
  subscribe(hub, broken, "project-1");
  subscribe(hub, healthy, "project-1");
  broken.asyncSendError = new Error("async socket write failed");

  const event = taskEvent("project-1", "async-broken-task");
  hub.broadcast(event);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(broken.closeCalls, [
    { code: WS_SEND_FAILURE_CLOSE_CODE, reason: WS_SEND_FAILURE_CLOSE_REASON },
  ]);
  assert.deepEqual(healthy.sent.map(parseEvent), [event]);
});

test("O12: close failure falls back to terminate", async () => {
  const hub = new WsHub();
  const socket = new FakeSocket();
  subscribe(hub, socket, "project-1");
  socket.asyncSendError = new Error("async socket write failed");
  socket.throwOnClose = true;

  hub.broadcast(taskEvent("project-1", "terminate-task"));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(socket.terminated, true);
});

test("O12: an old send callback cannot close a newly-added Client", async () => {
  const hub = new WsHub();
  const socket = new FakeSocket();
  const remove = subscribe(hub, socket, "project-1");
  socket.asyncSendError = new Error("old socket write failed");
  hub.broadcast(taskEvent("project-1", "old-send"));
  remove();
  socket.asyncSendError = undefined;
  subscribe(hub, socket, "project-1");

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(socket.closeCalls, []);
});

test("O6: subscribe snapshot uses the authoritative event ordering", async () => {
  const hub = new WsHub();
  hub.setSnapshotProvider((projectId) => [
    {
      type: "projects.snapshot",
      payload: { projects: [{ id: projectId }] },
    } as ServerEvent,
    {
      type: "cost.snapshot",
      payload: { projectId, totalUsd: 4.25 },
    },
    taskEvent(projectId, "snapshot-task"),
  ]);
  const socket = new FakeSocket();
  subscribe(hub, socket, "project-1");
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(
    socket.sent.map((payload) => parseEvent(payload).type),
    ["projects.snapshot", "cost.snapshot", "task.updated"],
  );
});

test("O6: an empty subscription replays global state but no project deltas", async () => {
  const hub = new WsHub();
  const durable: ServerEvent = {
    type: "notifications.snapshot",
    payload: {
      notifications: [notificationEvent("missed-while-offline").payload],
    },
  };
  const live = notificationEvent("arrived-during-replay");
  hub.setSnapshotProvider((projectId) => {
    assert.equal(projectId, "");
    return [durable];
  });
  const socket = new FakeSocket();

  subscribe(hub, socket, "");
  hub.broadcast(taskEvent("project-1", "must-not-reach-global-only"));
  hub.broadcast(live);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(socket.sent.map(parseEvent), [durable, live]);
});

test("O6/O12: a large snapshot drains under the cap instead of reconnecting forever", async () => {
  const hub = new WsHub();
  const eventCount = 3_000;
  hub.setSnapshotProvider((projectId) =>
    Array.from({ length: eventCount }, (_, index) =>
      taskEvent(projectId, `snapshot-task-${index}`),
    ),
  );
  const socket = new FakeSocket();

  subscribe(hub, socket, "project-1");
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(socket.sent.length, eventCount);
  assert.equal(socket.closeCalls.length, 0);
  assert.ok(socket.maxBufferedAmount < WS_MAX_BUFFERED_AMOUNT);
});

test("O6/O12: a live event behind one oversized snapshot frame does not cause a reconnect loop", async () => {
  const hub = new WsHub();
  const oversized = taskEvent("project-1", "oversized-snapshot-task");
  if (oversized.type !== "task.updated") throw new Error("expected task event");
  oversized.payload.description = "x".repeat(WS_MAX_BUFFERED_AMOUNT);
  hub.setSnapshotProvider(() => [oversized]);
  const socket = new FakeSocket();
  socket.deferSendCallbacks = true;

  subscribe(hub, socket, "project-1");
  assert.ok(socket.bufferedAmount > WS_MAX_BUFFERED_AMOUNT);
  const live = notificationEvent("queued-behind-oversized-snapshot");
  hub.broadcast(live);

  assert.deepEqual(socket.closeCalls, []);
  assert.deepEqual(socket.sent.map(parseEvent), [oversized]);

  socket.deliverNext();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(socket.sent.map(parseEvent), [oversized, live]);
  assert.deepEqual(socket.closeCalls, []);
  socket.deliverNext();
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("O6/O12: a real hub slow-client close reconnects to an ordered snapshot and later delta", async () => {
  const hub = new WsHub();
  hub.setSnapshotProvider((projectId) => [
    {
      type: "projects.snapshot",
      payload: { projects: [{ id: projectId }] },
    } as ServerEvent,
    {
      type: "cost.snapshot",
      payload: { projectId, totalUsd: 4.5 },
    },
    taskEvent(projectId, "reconnected-task"),
  ]);
  const delta: ServerEvent = {
    type: "cost.updated",
    payload: {
      id: "cost-after-reconnect",
      projectId: "project-1",
      model: "deepseek-flash",
      costUsd: 0.25,
      tokensIn: 1,
      tokensOut: 1,
      tokensCached: 0,
      ts: "2026-08-11T00:00:01.000Z",
    },
  };

  const first = new FakeSocket();
  subscribe(hub, first, "project-1");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    first.sent.map((payload) => parseEvent(payload).type),
    ["projects.snapshot", "cost.snapshot", "task.updated"],
  );

  first.bufferedAmount = WS_MAX_BUFFERED_AMOUNT;
  hub.broadcast(delta);
  assert.deepEqual(first.closeCalls, [
    {
      code: WS_SLOW_CLIENT_CLOSE_CODE,
      reason: WS_SLOW_CLIENT_CLOSE_REASON,
    },
  ]);
  assert.equal(first.sent.some((payload) => parseEvent(payload).type === "cost.updated"), false);

  // The second socket represents the browser's bounded reconnect. It must
  // receive a fresh authoritative baseline before the next delta.
  const replacement = new FakeSocket();
  subscribe(hub, replacement, "project-1");
  // A delta broadcast while replay is still in flight must queue behind every
  // snapshot frame rather than interleaving with or being lost by the replay.
  hub.broadcast(delta);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    replacement.sent.map((payload) => parseEvent(payload).type),
    ["projects.snapshot", "cost.snapshot", "task.updated", "cost.updated"],
  );
});
