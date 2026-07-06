import { ROUTES, type RouteKey } from "@orc/types";

const TOKEN_STORAGE_KEY = "hoopedorc.apiToken";

/** Read the bearer token the user entered (if the server requires one). */
export function getStoredApiToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null; // localStorage unavailable (private mode, etc.)
  }
}

function setStoredApiToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    /* best effort */
  }
}

/**
 * S6: registered by App.tsx to show the in-app TokenGate instead of the old
 * blocking browser-prompt stopgap. Called only on a real 401 — when auth is
 * off (the default) no request ever 401s, so nothing renders. Expected to
 * resolve with a token it has already confirmed works (or null if the user
 * gives up), so the single retry below normally succeeds.
 */
let unauthorizedHandler: (() => Promise<string | null>) | null = null;

export function setUnauthorizedHandler(
  handler: (() => Promise<string | null>) | null,
): void {
  unauthorizedHandler = handler;
}

export function apiUrl(key: RouteKey, params?: Record<string, string>): string {
  const parts = ROUTES[key].split(" ");
  let path = parts[1] ?? "";
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      path = path.replace(`:${k}`, v);
    }
  }
  return path;
}

export function apiMethod(key: RouteKey): string {
  return ROUTES[key].split(" ")[0] ?? "GET";
}

export interface ApiCallOptions {
  params?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
}

function doFetch(
  key: RouteKey,
  opts: ApiCallOptions,
  token: string | null,
): Promise<Response> {
  const { params, body, signal } = opts;
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return fetch(apiUrl(key, params), {
    method: apiMethod(key),
    headers: Object.keys(headers).length ? headers : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
}

export async function api<T>(
  key: RouteKey,
  opts: ApiCallOptions = {},
): Promise<T> {
  let token = getStoredApiToken();
  let res = await doFetch(key, opts, token);

  // Server requires a bearer token (HOST is non-loopback or an apiToken is
  // configured) and we don't have one, or it's stale — ask once and retry.
  // Frictionless when auth is off (the default): that path never 401s. A
  // second 401 after the retry just surfaces as a normal thrown error below;
  // the next unrelated api() call will 401 again and re-invoke the handler.
  if (res.status === 401 && unauthorizedHandler) {
    const entered = await unauthorizedHandler();
    if (entered) {
      setStoredApiToken(entered);
      token = entered;
      res = await doFetch(key, opts, token);
    }
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `${res.status}` }));
    throw new Error(err.error || `${res.status} ${res.statusText}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}
