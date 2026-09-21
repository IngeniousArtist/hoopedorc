// Trusted sidecar: a worker has no network device and reaches this proxy only
// through one owned Unix socket. No credentials, workspace or control state.
import http from "node:http";
import net from "node:net";
import { lookup } from "node:dns/promises";
import { chmod } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const PROVIDER_HOSTS = new Set(["chatgpt.com", "api.openai.com", "auth.openai.com"]);
/** Reject local/private/reserved addresses, including IPv4 embedded in IPv6. */
export function publicAddress(address) {
  if (net.isIP(address) !== 4) return false; // Keep the first verified transport IPv4 only.
  const [a, b] = address.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && [0, 168].includes(b) || a === 100 && b >= 64 && b <= 127 || a === 198 && [18, 19, 51].includes(b) || a === 203 && b === 0);
}
export function allowedTarget(authority) {
  if (typeof authority !== "string" || authority.length > 255 || !/^[a-z0-9.-]+:443$/.test(authority)) return null;
  const host = authority.slice(0, -4);
  return PROVIDER_HOSTS.has(host) ? host : null;
}
export async function startProxy(socketPath, dependencies = {}) {
  const resolve = dependencies.lookup ?? lookup;
  const connect = dependencies.connect ?? net.connect;
  const sockets = new Set();
  const server = http.createServer((_request, response) => { response.writeHead(403); response.end("CONNECT to an approved provider is required."); });
  server.maxHeadersCount = 20; server.headersTimeout = 10_000; server.requestTimeout = 10_000;
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.on("connect", (request, client, head) => {
    const host = allowedTarget(request.url);
    const deny = () => { if (!client.destroyed) client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); };
    if (!host || sockets.size > 64 || request.headers["proxy-authorization"]) { deny(); return; }
    client.setTimeout(60_000, () => client.destroy());
    void (async () => {
      const addresses = await resolve(host, { all: true, family: 4 });
      if (client.destroyed || !addresses.length || addresses.some(({ address }) => !publicAddress(address))) { deny(); return; }
      // Connect to the inspected IP, not a second DNS lookup (rebinding).
      const upstream = connect({ host: addresses[0].address, port: 443 });
      sockets.add(upstream); upstream.once("close", () => sockets.delete(upstream));
      upstream.setTimeout(60_000, () => upstream.destroy());
      upstream.once("connect", () => {
        if (client.destroyed) { upstream.destroy(); return; }
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
      upstream.on("error", () => client.destroy()); client.on("error", () => upstream.destroy());
      client.once("close", () => upstream.destroy()); upstream.once("close", () => client.destroy());
    })().catch(deny);
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  await chmod(socketPath, 0o600);
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stop = await startProxy("/proxy/connect.sock");
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { void stop().then(() => process.exit(0), () => process.exit(1)); });
}
