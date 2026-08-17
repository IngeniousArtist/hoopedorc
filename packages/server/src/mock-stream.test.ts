import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type WebSocket from "ws";
import { emitMockLogs, startMockLogStream } from "./mock-stream.js";
import { WsHub } from "./ws-hub.js";

class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: string[] = [];

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.readyState = 3;
  }

  terminate(): void {
    this.readyState = 3;
  }
}

function subscribe(hub: WsHub, socket: FakeSocket, projectId: string): void {
  hub.add(socket as unknown as WebSocket);
  socket.emit(
    "message",
    Buffer.from(JSON.stringify({ type: "subscribe", projectId })),
  );
}

function parseMockLog(payload: string): {
  payload: { projectId: string; taskId: string };
} {
  const parsed: unknown = JSON.parse(payload);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("invalid event");
  }
  const event = parsed as Record<string, unknown>;
  if (!event.payload || typeof event.payload !== "object") {
    throw new Error("invalid log payload");
  }
  const log = event.payload as Record<string, unknown>;
  if (typeof log.projectId !== "string" || typeof log.taskId !== "string") {
    throw new Error("invalid log scope");
  }
  return { payload: { projectId: log.projectId, taskId: log.taskId } };
}

test("mock logs use the hub so simultaneous projects stay isolated", () => {
  const hub = new WsHub();
  const projectA = new FakeSocket();
  const projectB = new FakeSocket();
  subscribe(hub, projectA, "project-a");
  subscribe(hub, projectB, "project-b");

  emitMockLogs(
    [
      { projectId: "project-a", taskId: "task-a" },
      { projectId: "project-b", taskId: "task-b" },
    ],
    (event) => hub.broadcast(event),
    () => new Date("2026-08-11T00:00:00.000Z"),
  );

  const logsA = projectA.sent.map(parseMockLog);
  const logsB = projectB.sent.map(parseMockLog);
  assert.deepEqual(logsA.map((event) => event.payload.projectId), ["project-a"]);
  assert.deepEqual(logsB.map((event) => event.payload.projectId), ["project-b"]);
  assert.equal(logsA[0]?.payload.taskId, "task-a");
  assert.equal(logsB[0]?.payload.taskId, "task-b");
});

test("mock stream timer stops cleanly when its owner clears it", async () => {
  let count = 0;
  const timer = startMockLogStream(
    () => [{ projectId: "project-a", taskId: "task-a" }],
    () => {
      count++;
    },
    1,
  );
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.ok(count > 0);
  clearInterval(timer);
  const afterStop = count;
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(count, afterStop);
});
