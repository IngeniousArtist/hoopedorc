import type { ServerEvent } from "@orc/types";
import type WebSocket from "ws";

/**
 * A stalled browser must be dropped before the ws implementation keeps
 * retaining an unbounded queue of broadcast payloads. One MiB is large
 * enough for several normal task/log bursts while bounding one client's
 * pending transport/delta queue to a small, predictable amount; a reconnect
 * gets the authoritative project snapshot again.
 */
export const WS_MAX_BUFFERED_AMOUNT = 1 * 1024 * 1024;
export const WS_SLOW_CLIENT_CLOSE_CODE = 4008;
export const WS_SLOW_CLIENT_CLOSE_REASON = "slow client; resync required";
export const WS_SEND_FAILURE_CLOSE_CODE = 1011;
export const WS_SEND_FAILURE_CLOSE_REASON = "WebSocket send failed";
export const WS_SNAPSHOT_FAILURE_CLOSE_CODE = 1011;
export const WS_SNAPSHOT_FAILURE_CLOSE_REASON =
  "WebSocket snapshot failed; resync required";

type Client = {
  ws: WebSocket;
  projectId?: string;
  closing?: boolean;
  generation: number;
  replay?: {
    generation: number;
    snapshot: ServerEvent[];
    snapshotIndex: number;
    /** Bytes belonging to the one exempt durable snapshot frame currently
     * handed to ws. They are excluded from the live queue ceiling; ws reports
     * them together with ordinary buffered bytes in bufferedAmount. */
    snapshotBytesInFlight: number;
    queued: string[];
    queuedBytes: number;
  };
};

/**
 * Which project an event belongs to, for broadcast scoping (B15) —
 * `undefined` for the event types treated as global (see broadcast()).
 */
function eventProjectId(event: ServerEvent): string | undefined {
  switch (event.type) {
    case "log":
    case "task.updated":
    case "run.updated":
    case "cost.updated":
    case "cost.snapshot":
    case "merge.decision":
    case "rollback.updated":
      return event.payload.projectId;
    case "project.updated":
    case "project.deleted":
      return event.payload.id;
    case "notification":
    case "projects.snapshot":
    case "notifications.snapshot":
      return undefined;
  }
}

/** Broadcast to every client regardless of subscription: project-level
 *  events (useful even to a client that hasn't picked a project yet, e.g. a
 *  projects list page) and notifications (the "needs you" channel). */
function isGlobalEvent(event: ServerEvent): boolean {
  return (
    event.type === "project.updated" ||
    event.type === "project.deleted" ||
    event.type === "projects.snapshot" ||
    event.type === "notification" ||
    event.type === "notifications.snapshot"
  );
}

export class WsHub {
  private clients = new Set<Client>();

  /**
   * Returns the catch-up snapshot for a project a client just subscribed to.
   * Set once by the server; kept here so the hub doesn't depend on the db.
   */
  private snapshotFor?: (projectId: string) => ServerEvent[];

  setSnapshotProvider(fn: (projectId: string) => ServerEvent[]): void {
    this.snapshotFor = fn;
  }

  private closeClient(client: Client, code: number, reason: string): void {
    if (client.closing) return;
    client.closing = true;
    client.generation++;
    client.projectId = undefined;
    client.replay = undefined;
    this.clients.delete(client);
    try {
      client.ws.close(code, reason);
    } catch {
      try {
        client.ws.terminate();
      } catch {
        // The socket is already unusable; the close event will remove it when
        // the ws implementation can deliver one.
      }
    }
  }

  /**
   * Send one payload without allowing a broken or stalled client to affect
   * the rest of the broadcast. Returning false means the event was not sent;
   * the socket has already been closed, so it cannot remain silently stale.
   */
  private send(
    client: Client,
    payload: string,
    onDelivered?: () => void,
    includePayloadInLimit = true,
  ): boolean {
    if (client.closing || client.ws.readyState !== 1 /* WebSocket.OPEN */) {
      return false;
    }
    const outgoingBytes = includePayloadInLimit
      ? Buffer.byteLength(payload)
      : 0;
    if (
      client.ws.bufferedAmount + outgoingBytes >=
      WS_MAX_BUFFERED_AMOUNT
    ) {
      this.closeClient(
        client,
        WS_SLOW_CLIENT_CLOSE_CODE,
        WS_SLOW_CLIENT_CLOSE_REASON,
      );
      return false;
    }
    try {
      client.ws.send(payload, (error?: Error) => {
        // Do not let a completion callback from a removed Client close a new
        // Client that happens to wrap the same underlying socket object.
        if (client.closing || !this.clients.has(client)) return;
        if (error) {
          this.closeClient(
            client,
            WS_SEND_FAILURE_CLOSE_CODE,
            WS_SEND_FAILURE_CLOSE_REASON,
          );
          return;
        }
        onDelivered?.();
      });
      return true;
    } catch {
      this.closeClient(
        client,
        WS_SEND_FAILURE_CLOSE_CODE,
        WS_SEND_FAILURE_CLOSE_REASON,
      );
      return false;
    }
  }

  /**
   * A catch-up snapshot is flow-controlled one frame at a time. Broadcasting
   * remains synchronous for producers, so events accepted while the replay is
   * in flight are retained behind the snapshot and drained in order. Only
   * those live deltas count against the 1 MiB transport-queue ceiling; the
   * database snapshot itself stays as source events and is serialized one
   * frame at a time rather than copied into the ws queue all at once.
   */
  private continueReplay(client: Client, generation: number): void {
    const replay = client.replay;
    if (
      !replay ||
      replay.generation !== generation ||
      client.generation !== generation ||
      client.closing ||
      !this.clients.has(client)
    ) {
      return;
    }

    let payload: string | undefined;
    let snapshotFrame = false;
    if (replay.snapshotIndex < replay.snapshot.length) {
      try {
        payload = JSON.stringify(replay.snapshot[replay.snapshotIndex++]);
        snapshotFrame = true;
      } catch {
        this.closeClient(
          client,
          WS_SNAPSHOT_FAILURE_CLOSE_CODE,
          WS_SNAPSHOT_FAILURE_CLOSE_REASON,
        );
        return;
      }
    } else {
      payload = replay.queued.shift();
      if (payload !== undefined) {
        replay.queuedBytes -= Buffer.byteLength(payload);
      }
    }

    if (payload === undefined) {
      client.replay = undefined;
      return;
    }

    if (snapshotFrame) {
      replay.snapshotBytesInFlight = Buffer.byteLength(payload);
    }

    this.send(
      client,
      payload,
      () => {
        if (snapshotFrame) replay.snapshotBytesInFlight = 0;
        // Avoid recursive growth with synchronous test transports while real ws
        // callbacks naturally wait until the previous frame has been written.
        queueMicrotask(() => this.continueReplay(client, generation));
      },
      // A durable snapshot may contain one record larger than the live queue
      // ceiling. It is still bounded to exactly one in-flight frame; rejecting
      // it would make every reconnect loop on the same durable record. Live
      // frames, including deltas queued behind this replay, count their full
      // outgoing size before they are accepted by ws.
      !snapshotFrame,
    );
  }

  private queueDuringReplay(client: Client, payload: string): void {
    const replay = client.replay;
    if (!replay) return;
    const payloadBytes = Buffer.byteLength(payload);
    // bufferedAmount includes the durable snapshot frame currently in flight.
    // That one source record is intentionally exempt from the live 1 MiB cap;
    // count only any remaining transport bytes plus queued live deltas here.
    const liveBufferedBytes = Math.max(
      0,
      client.ws.bufferedAmount - replay.snapshotBytesInFlight,
    );
    if (
      liveBufferedBytes + replay.queuedBytes + payloadBytes >=
      WS_MAX_BUFFERED_AMOUNT
    ) {
      this.closeClient(
        client,
        WS_SLOW_CLIENT_CLOSE_CODE,
        WS_SLOW_CLIENT_CLOSE_REASON,
      );
      return;
    }
    replay.queued.push(payload);
    replay.queuedBytes += payloadBytes;
  }

  add(ws: WebSocket): () => void {
    const client: Client = { ws, generation: 0 };
    this.clients.add(client);

    ws.on("message", (raw) => {
      let msg: { type?: unknown; projectId?: unknown };
      try {
        const parsed: unknown = JSON.parse(raw.toString());
        if (!parsed || typeof parsed !== "object") return;
        msg = parsed;
      } catch {
        // Ignore malformed messages without changing the current subscription.
        return;
      }

      if (msg.type === "subscribe" && typeof msg.projectId === "string") {
        const projectId = msg.projectId;
        let snapshot: ServerEvent[];
        try {
          // Build the complete replay before changing the active subscription.
          // Provider and serialization failures must never leak a partial
          // baseline or leave the socket receiving later deltas.
          snapshot = this.snapshotFor?.(projectId) ?? [];
          for (const event of snapshot) JSON.stringify(event);
        } catch {
          this.closeClient(
            client,
            WS_SNAPSHOT_FAILURE_CLOSE_CODE,
            WS_SNAPSHOT_FAILURE_CLOSE_REASON,
          );
          return;
        }

        const generation = ++client.generation;
        // An empty project ID requests only the durable global catch-up state.
        // It remains unsubscribed from every project-scoped live event.
        client.projectId = projectId || undefined;
        client.replay = {
          generation,
          snapshot,
          snapshotIndex: 0,
          snapshotBytesInFlight: 0,
          queued: [],
          queuedBytes: 0,
        };
        this.continueReplay(client, generation);
      } else if (msg.type === "unsubscribe") {
        client.generation++;
        client.projectId = undefined;
        client.replay = undefined;
      }
    });

    ws.on("close", () => {
      client.closing = true;
      client.generation++;
      client.replay = undefined;
      this.clients.delete(client);
    });

    return () => {
      client.closing = true;
      client.generation++;
      client.replay = undefined;
      this.clients.delete(client);
    };
  }

  broadcast(event: ServerEvent): void {
    const payload = JSON.stringify(event);
    const global = isGlobalEvent(event);
    const scopeId = eventProjectId(event);
    for (const client of this.clients) {
      // Project-scoped events (logs, task/run updates, merge/rollback
      // decisions, cost snapshots/deltas)
      // only go to clients subscribed to that same project — previously every
      // client got every project's events and relied on client-side filtering,
      // which meant N running projects meant N× the WS traffic per tab and a
      // (harmless today, but latent) cross-project log/task-id collision risk.
      if (!global && client.projectId !== scopeId) continue;
      if (client.replay) {
        this.queueDuringReplay(client, payload);
      } else {
        this.send(client, payload);
      }
    }
  }

  /** Close live sockets before Fastify drains its HTTP server. This prevents
   * an idle dashboard tab from holding graceful service shutdown open. */
  close(code = 1012, reason = "server restarting"): void {
    for (const client of this.clients) {
      this.closeClient(client, code, reason);
    }
    this.clients.clear();
  }
}
