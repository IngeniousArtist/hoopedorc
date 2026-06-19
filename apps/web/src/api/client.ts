import { ROUTES, type RouteKey } from "@orc/types";

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

export async function api<T>(
  key: RouteKey,
  opts: ApiCallOptions = {},
): Promise<T> {
  const { params, body, signal } = opts;
  const res = await fetch(apiUrl(key, params), {
    method: apiMethod(key),
    headers:
      body !== undefined
        ? { "Content-Type": "application/json" }
        : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `${res.status}` }));
    throw new Error(err.error || `${res.status} ${res.statusText}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}
