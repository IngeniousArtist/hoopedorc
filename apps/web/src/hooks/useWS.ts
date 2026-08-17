import { useEffect, useRef } from "react";
import type { ServerEvent } from "@orc/types";
import { getStoredApiToken } from "../api/client";

/** Reconnect backoff: 1s → 2s → 4s … capped at 15s. */
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 15_000;

type Subscriber = { onEvent: (event: ServerEvent) => void };

type ProjectConnection = {
  projectId: string;
  subscribers: Map<symbol, Subscriber>;
  /** Latest authoritative project total, advanced by ordered deltas. A view
   * mounting after the shared socket opened receives this as its baseline. */
  costTotalUsd: number | null;
  ws: WebSocket | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
  attempts: number;
  /** Set when the last subscriber deliberately tears this manager down. */
  torn: boolean;
};

/** One reference-counted connection manager per project. */
const connections = new Map<string, ProjectConnection>();

function reportSubscriberError(projectId: string, error: unknown): void {
  console.error(`useWS subscriber failed for project ${projectId}`, error);
}

function recordAuthoritativeState(
  connection: ProjectConnection,
  event: ServerEvent,
): void {
  if (
    event.type === "cost.snapshot" &&
    event.payload.projectId === connection.projectId
  ) {
    connection.costTotalUsd = event.payload.totalUsd;
  } else if (
    event.type === "cost.updated" &&
    event.payload.projectId === connection.projectId &&
    connection.costTotalUsd !== null
  ) {
    connection.costTotalUsd += event.payload.costUsd;
  }
}

function dispatch(connection: ProjectConnection, event: ServerEvent): void {
  recordAuthoritativeState(connection, event);
  for (const subscriber of connection.subscribers.values()) {
    try {
      subscriber.onEvent(event);
    } catch (error) {
      // One broken view must not prevent other same-project views from
      // receiving the authoritative event stream.
      reportSubscriberError(connection.projectId, error);
    }
  }
}

function replayCostBaseline(
  connection: ProjectConnection,
  subscriber: Subscriber,
): void {
  if (connection.costTotalUsd === null || !connection.projectId) return;
  try {
    subscriber.onEvent({
      type: "cost.snapshot",
      payload: {
        projectId: connection.projectId,
        totalUsd: connection.costTotalUsd,
      },
    });
  } catch (error) {
    reportSubscriberError(connection.projectId, error);
  }
}

function connectUrl(): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  // Browsers cannot set custom headers on a WS upgrade, so the bearer token
  // (when the server requires one) rides as a query param instead.
  const token = getStoredApiToken();
  return `${protocol}//${location.host}/ws${token ? `?token=${encodeURIComponent(token)}` : ""}`;
}

function scheduleReconnect(connection: ProjectConnection): void {
  if (
    connection.torn ||
    connection.subscribers.size === 0 ||
    connection.reconnectTimer !== null
  ) {
    return;
  }
  const delay = Math.min(
    BACKOFF_BASE_MS * 2 ** connection.attempts,
    BACKOFF_MAX_MS,
  );
  connection.attempts++;
  connection.reconnectTimer = setTimeout(() => {
    connection.reconnectTimer = null;
    if (
      !connection.torn &&
      connection.subscribers.size > 0 &&
      connection.ws === null
    ) {
      connect(connection);
    }
  }, delay);
}

function connect(connection: ProjectConnection): void {
  if (connection.torn || connection.subscribers.size === 0) return;

  const socket = new WebSocket(connectUrl());
  connection.ws = socket;

  const handleClose = () => {
    // An old socket can only close after a replacement if the browser queued
    // the callback late; never let it tear down the replacement connection.
    if (connection.ws !== socket) return;
    connection.ws = null;
    if (!connection.torn && connection.subscribers.size > 0) {
      scheduleReconnect(connection);
    }
  };

  socket.onopen = () => {
    if (
      connection.ws !== socket ||
      connection.torn ||
      connection.subscribers.size === 0
    ) {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      return;
    }
    connection.attempts = 0;
    try {
      // An empty project requests only the durable global catch-up stream used
      // during onboarding and after deletion. The server keeps it unsubscribed
      // from project-scoped live events after that replay.
      socket.send(
        JSON.stringify({ type: "subscribe", projectId: connection.projectId }),
      );
    } catch {
      // A browser can reject a send during a transport race. Closing lets the
      // normal bounded reconnect path establish a clean subscription.
      try {
        socket.close();
      } catch {
        handleClose();
      }
    }
  };

  socket.onmessage = (message) => {
    // A stale transport can still deliver a queued frame after close while a
    // replacement socket is already active. Never dispatch that old frame.
    if (connection.ws !== socket) return;
    try {
      dispatch(connection, JSON.parse(message.data) as ServerEvent);
    } catch {
      /* Ignore malformed messages; the connection remains usable. */
    }
  };

  // close fires after error too, so reconnecting here covers both paths.
  socket.onclose = handleClose;
  socket.onerror = () => {
    if (connection.ws !== socket) return;
    try {
      socket.close();
    } catch {
      handleClose();
    }
  };
}

function ensureConnected(connection: ProjectConnection): void {
  // A disconnect was scheduled (the last subscriber just unmounted) but a
  // new one showed up before it fired — e.g. React StrictMode or a project
  // switch re-running effects in one commit. Keep this socket alive.
  if (connection.disconnectTimer !== null) {
    clearTimeout(connection.disconnectTimer);
    connection.disconnectTimer = null;
  }
  if (connection.ws || connection.reconnectTimer !== null) return;
  connection.torn = false;
  connect(connection);
}

function teardown(connection: ProjectConnection): void {
  connection.torn = true;
  if (connection.reconnectTimer !== null) {
    clearTimeout(connection.reconnectTimer);
    connection.reconnectTimer = null;
  }
  if (connection.disconnectTimer !== null) {
    clearTimeout(connection.disconnectTimer);
    connection.disconnectTimer = null;
  }
  if (connection.ws) {
    const socket = connection.ws;
    // Drop handlers so this deliberate close does not schedule a reconnect.
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    try {
      socket.close();
    } catch {
      /* A failed close is already an unusable socket. */
    }
    connection.ws = null;
  }
  connection.attempts = 0;
  if (connections.get(connection.projectId) === connection) {
    connections.delete(connection.projectId);
  }
}

/** Deferred so a same-tick unmount+remount does not flap the socket closed. */
function scheduleTeardown(connection: ProjectConnection): void {
  if (connection.disconnectTimer !== null) return;
  connection.disconnectTimer = setTimeout(() => {
    connection.disconnectTimer = null;
    if (connection.subscribers.size === 0) teardown(connection);
  }, 0);
}

function getConnection(projectId: string): ProjectConnection {
  const existing = connections.get(projectId);
  if (existing) return existing;
  const connection: ProjectConnection = {
    projectId,
    subscribers: new Map(),
    costTotalUsd: null,
    ws: null,
    reconnectTimer: null,
    disconnectTimer: null,
    attempts: 0,
    torn: true,
  };
  connections.set(projectId, connection);
  return connection;
}

/**
 * Subscribe to one project's event stream. Same-project subscribers share a
 * socket and reference-count its lifetime; different projects get isolated
 * sockets and dispatch registries. Reconnects use capped exponential
 * backoff, and every fresh subscription receives the server's authoritative
 * task/cost snapshot before later deltas.
 */
export function useWS(
  projectId: string,
  onEvent: (event: ServerEvent) => void,
): void {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    const connection = getConnection(projectId);
    const id = Symbol("useWS-subscriber");
    const subscriber: Subscriber = {
      onEvent: (event) => onEventRef.current(event),
    };
    connection.subscribers.set(id, subscriber);
    // A same-project manager may already be open because App or another view
    // owns it. Seed this late subscriber before any later live delta can run.
    replayCostBaseline(connection, subscriber);
    ensureConnected(connection);

    return () => {
      connection.subscribers.delete(id);
      if (connection.subscribers.size === 0) {
        scheduleTeardown(connection);
      }
    };
  }, [projectId]);
}
