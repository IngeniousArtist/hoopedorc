/**
 * S7: the WS upgrade carries the bearer token as `?token=...` (browsers
 * can't set custom headers on a WS upgrade — see useWS.ts), so Fastify's
 * default request logger would otherwise write the real token to stdout
 * (and from there, systemd's journal) on every connection. Redact it from
 * the logged URL only — the actual request handling never sees this.
 *
 * T1: kept in its own module (mirroring scheduler.ts/budget.ts/estimate.ts)
 * rather than as a private function in index.ts, specifically so it's
 * importable from a test file without triggering index.ts's top-level
 * `main()` call.
 */
export function redactTokenFromUrl(url: string): string {
  return url.replace(/([?&]token=)[^&]*/, "$1[redacted]");
}
