import { useEffect, useRef } from "react";
import type { ServerEvent } from "@orc/types";
import { getStoredApiToken } from "../api/client";

/** Reconnect backoff: 1s → 2s → 4s … capped at 15s. */
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 15_000;

/**
 * F25: every useWS() call used to open its own socket — the Board view
 * alone (App + Board + MissionControl, all subscribing to the same
 * project) held three concurrent connections to the same server: three
 * reconnect storms after a restart or phone sleep, three snapshot replays,
 * for zero benefit. This module now holds exactly one shared connection
 * (module-level, not per-hook) behind a reference-counted subscriber
 * registry — useWS()'s own signature is unchanged, so no call site needed
 * to change.
 *
 * ws-hub.ts tracks one subscribed project per socket, which this design
 * satisfies as long as every subscriber wants the same projectId — true
 * today (App/Board/MissionControl/Notifications all derive it from the
 * same selected-project state). subscribe() below warns if that invariant
 * is ever violated, so a future regression is visible instead of silently
 * subscribing to whichever project happened to register first.
 */
type Subscriber = { projectId: string; onEvent: (e: ServerEvent) => void };

const subscribers = new Map<symbol, Subscriber>();

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let disconnectTimer: ReturnType<typeof setTimeout> | null = null;
let attempts = 0;
/** The projectId the live socket has actually sent "subscribe" for. */
let currentProjectId: string | null = null;
/** Set once the manager is deliberately torn down (last subscriber gone),
 *  so a stray in-flight onclose doesn't schedule a pointless reconnect. */
let torn = true;

function desiredProjectId(): string | undefined {
  return subscribers.values().next().value?.projectId;
}

function dispatch(e: ServerEvent): void {
  for (const sub of subscribers.values()) sub.onEvent(e);
}

/** Send subscribe/unsubscribe on the live socket if the desired project
 *  differs from what it's actually subscribed to. A no-op (by design) when
 *  called redundantly — every subscriber's effect calls this on mount/
 *  projectId-change, but only the first to notice a mismatch acts on it. */
function resyncSubscription(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const pid = desiredProjectId();
  if (!pid || pid === currentProjectId) return;
  if (currentProjectId) {
    ws.send(JSON.stringify({ type: "unsubscribe", projectId: currentProjectId }));
  }
  ws.send(JSON.stringify({ type: "subscribe", projectId: pid }));
  currentProjectId = pid;
}

function connect(): void {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  // Browsers can't set custom headers on a WS upgrade, so the bearer
  // token (when the server requires one) rides as a query param instead.
  const token = getStoredApiToken();
  const url = `${protocol}//${location.host}/ws${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  ws = new WebSocket(url);

  ws.onopen = () => {
    attempts = 0; // reset backoff once a connection succeeds
    currentProjectId = null; // force a fresh subscribe on the new socket
    resyncSubscription();
  };

  ws.onmessage = (msg) => {
    try {
      dispatch(JSON.parse(msg.data) as ServerEvent);
    } catch {
      /* ignore malformed messages */
    }
  };

  const scheduleReconnect = () => {
    if (torn || reconnectTimer) return;
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** attempts, BACKOFF_MAX_MS);
    attempts++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  // close fires after error too, so reconnecting here covers both.
  ws.onclose = scheduleReconnect;
  ws.onerror = () => ws?.close();
}

function ensureConnected(): void {
  // A disconnect was scheduled (the last subscriber just unmounted) but a
  // new one showed up before it fired — e.g. React re-running every
  // useWS() effect for the same projectId change in one commit, or
  // StrictMode's dev-only double-invoke. Cancel it; the connection (and
  // its subscription) is still valid.
  if (disconnectTimer) {
    clearTimeout(disconnectTimer);
    disconnectTimer = null;
  }
  if (ws || reconnectTimer) return; // already connecting/connected
  torn = false;
  connect();
}

function teardown(): void {
  torn = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    // Drop handlers so this deliberate close() doesn't trigger a reconnect.
    ws.onclose = null;
    ws.onerror = null;
    if (ws.readyState === WebSocket.OPEN && currentProjectId) {
      ws.send(JSON.stringify({ type: "unsubscribe", projectId: currentProjectId }));
    }
    ws.close();
    ws = null;
  }
  currentProjectId = null;
  attempts = 0;
}

/** Deferred so a same-tick unmount+remount (a projectId change re-running
 *  every subscriber's effect, or StrictMode) doesn't flap the socket closed
 *  and immediately reopen it — resyncSubscription() alone handles a real
 *  projectId change on the still-open connection. */
function scheduleTeardownIfIdle(): void {
  if (disconnectTimer) return;
  disconnectTimer = setTimeout(() => {
    disconnectTimer = null;
    if (subscribers.size === 0) teardown();
  }, 0);
}

/**
 * Subscribe to the server's event stream for a project. Auto-reconnects with
 * capped exponential backoff so a server restart, laptop sleep, or network
 * blip during a long autonomous run doesn't silently freeze the UI — on
 * reconnect it re-subscribes and the server replays the project snapshot.
 */
export function useWS(
  projectId: string,
  onEvent: (e: ServerEvent) => void,
): void {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    const existing = desiredProjectId();
    if (existing !== undefined && existing !== projectId) {
      console.warn(
        `[useWS] distinct projectIds requested at once ("${existing}" vs "${projectId}") — the shared connection subscribes to only one project; this likely indicates a regression.`,
      );
    }

    const id = Symbol("useWS-subscriber");
    subscribers.set(id, {
      projectId,
      onEvent: (e) => onEventRef.current(e),
    });
    ensureConnected();
    resyncSubscription();

    return () => {
      subscribers.delete(id);
      if (subscribers.size === 0) {
        scheduleTeardownIfIdle();
      } else {
        // Another subscriber (possibly with a new projectId) remains —
        // make sure the live socket reflects whatever they now want.
        resyncSubscription();
      }
    };
  }, [projectId]);
}
