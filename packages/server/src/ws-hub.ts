import type { ServerEvent } from "@orc/types";
import type WebSocket from "ws";

/**
 * A stalled browser must be dropped before the ws implementation keeps
 * retaining an unbounded queue of broadcast payloads. One MiB is large
 * enough for several normal task/log bursts while bounding one client's
 * pending memory to a small, predictable amount; a reconnect gets the
 * authoritative project snapshot again.
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
    event.type === "notification"
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
  private send(client: Client, payload: string): boolean {
    if (client.closing || client.ws.readyState !== 1 /* WebSocket.OPEN */) {
      return false;
    }
    if (client.ws.bufferedAmount >= WS_MAX_BUFFERED_AMOUNT) {
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
        if (!error || client.closing || !this.clients.has(client)) return;
        this.closeClient(
          client,
          WS_SEND_FAILURE_CLOSE_CODE,
          WS_SEND_FAILURE_CLOSE_REASON,
        );
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

  add(ws: WebSocket): () => void {
    const client: Client = { ws };
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

      if (msg.type === "subscribe" && typeof msg.projectId === "string" && msg.projectId) {
        const projectId = msg.projectId;
        let snapshot: ServerEvent[] | undefined;
        try {
          // Build the complete replay before changing the active subscription.
          // A provider failure must never leave a socket receiving deltas
          // without an authoritative baseline.
          snapshot = this.snapshotFor?.(projectId);
        } catch {
          client.projectId = undefined;
          this.closeClient(
            client,
            WS_SNAPSHOT_FAILURE_CLOSE_CODE,
            WS_SNAPSHOT_FAILURE_CLOSE_REASON,
          );
          return;
        }

        client.projectId = projectId;
        try {
          // Send the catch-up snapshot for JUST this project on subscribe,
          // rather than replaying every project's full task+run history to
          // every client on connect (which scaled with total project count).
          if (snapshot && ws.readyState === 1) {
            for (const event of snapshot) {
              if (!this.send(client, JSON.stringify(event))) {
                client.projectId = undefined;
                break;
              }
            }
          }
        } catch {
          client.projectId = undefined;
          this.closeClient(
            client,
            WS_SNAPSHOT_FAILURE_CLOSE_CODE,
            WS_SNAPSHOT_FAILURE_CLOSE_REASON,
          );
        }
      } else if (msg.type === "unsubscribe") {
        client.projectId = undefined;
      }
    });

    ws.on("close", () => {
      this.clients.delete(client);
    });

    return () => this.clients.delete(client);
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
      this.send(client, payload);
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
