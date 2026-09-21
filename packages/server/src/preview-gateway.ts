import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import WebSocket, { WebSocketServer } from "ws";

const secret = () => randomBytes(32).toString("hex");
const equal = (a: string, b: string) => { const left = Buffer.from(a); const right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); };
const HOP_HEADERS = new Set(["connection", "upgrade", "keep-alive", "transfer-encoding", "proxy-authenticate", "proxy-authorization", "te", "trailer", "authorization", "cookie", "host", "origin", "referer", "set-cookie"]);
function safeHeaders(source: IncomingHttpHeaders): IncomingHttpHeaders {
  const connection = new Set((source.connection ?? "").split(",").map((name) => name.trim().toLowerCase()));
  return Object.fromEntries(Object.entries(source).filter(([key]) => !HOP_HEADERS.has(key) && !connection.has(key) && !key.startsWith("x-forwarded-") && key !== "forwarded"));
}

export class PreviewGateway {
  private readonly session = secret();
  private readonly cookieName: string;
  private readonly appPrefix: string;
  private expiresAt = 0;
  private readonly tickets = new Map<string, number>();
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly webSockets = new Set<WebSocket>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  private closed = false;

  constructor(private readonly options: { id: string; port: number; targetPort: number; origin: string; ready: () => boolean; verifyTarget: () => Promise<boolean> }) {
    this.cookieName = `hoop_preview_${options.id.replaceAll("-", "")}`;
    this.appPrefix = `hoop_app_${options.id.replaceAll("-", "")}_`;
    this.server = createServer((req, res) => { void (async () => {
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      const url = req.url ?? "/";
      if (url.startsWith("/__hoop_session/")) {
        const token = url.slice("/__hoop_session/".length);
        const expiresAt = this.tickets.get(token);
        if (!this.options.ready() || req.method !== "GET" || !expiresAt || expiresAt < Date.now()) {
          res.writeHead(401).end("Preview link expired. Open it again from Hoopedorc."); return;
        }
        this.tickets.delete(token); this.expiresAt = Date.now() + 2 * 60 * 60 * 1000;
        const secure = options.origin.startsWith("https:") ? "; Secure" : "";
        res.setHeader("Set-Cookie", `${this.cookieName}=${this.session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=7200${secure}`);
        res.writeHead(303, { Location: "/" }).end(); return;
      }
      if (!this.authorized(req)) { res.writeHead(401).end("Preview access expired or unavailable. Reopen it from Hoopedorc."); return; }
      // Browsers mark service-worker script fetches with this header. Refuse
      // persistent interception across slot reuse without disabling ordinary
      // web workers used by editors and other development applications.
      if (req.headers["service-worker"]) { res.writeHead(403).end("Service workers are unavailable in managed previews."); return; }
      if (req.headers.origin && req.headers.origin !== options.origin) { res.writeHead(403).end("Preview origin refused."); return; }
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method ?? "GET") && req.headers.origin !== options.origin) {
        res.writeHead(403).end("Preview mutations require the preview origin."); return;
      }
      // Origin-form paths only. A client cannot choose a URL, host or port.
      if (!url.startsWith("/") || url.startsWith("//") || /[\r\n\\]/.test(url)) { res.writeHead(400).end("Invalid preview path."); return; }
      if (!await this.targetAvailable()) { res.writeHead(503).end("Preview process or workspace is no longer available."); return; }
      const upstream = httpRequest({ hostname: "127.0.0.1", port: options.targetPort, method: req.method, path: url,
        headers: this.upstreamHeaders(req), timeout: 30_000 }, (response) => {
        const headers = safeHeaders(response.headers);
        // Redirects stay on this assigned target; do not send a browser to a
        // backend loopback port, arbitrary origin or the control plane.
        if (headers.location) {
          try {
            const target = new URL(headers.location, `http://127.0.0.1:${options.targetPort}`);
            if (target.origin !== `http://127.0.0.1:${options.targetPort}` && target.origin !== options.origin) throw new Error("external redirect");
            headers.location = `${target.pathname}${target.search}${target.hash}`;
          } catch { response.resume(); res.writeHead(502).end("Preview redirected outside its assigned application."); return; }
        }
        const cookies = response.headers["set-cookie"]?.map((cookie) => this.scopeCookie(cookie)).filter((cookie): cookie is string => cookie !== null);
        if (cookies?.length) headers["set-cookie"] = cookies;
        delete headers["access-control-allow-origin"]; delete headers["access-control-allow-credentials"];
        headers["cache-control"] = "no-store"; headers["referrer-policy"] = "no-referrer";
        res.writeHead(response.statusCode ?? 502, headers); response.pipe(res);
      });
      upstream.on("timeout", () => upstream.destroy(new Error("Preview upstream timed out.")));
      upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end("Preview process unavailable."); });
      req.on("aborted", () => upstream.destroy()); res.on("close", () => upstream.destroy());
      req.pipe(upstream);
    })().catch(() => { if (!res.headersSent) res.writeHead(502); res.end("Preview request failed."); }); });
    this.server.on("connection", (socket) => { this.sockets.add(socket); socket.on("close", () => this.sockets.delete(socket)); });
    this.server.on("upgrade", (req, socket, head) => { void (async () => {
      if (!this.authorized(req) || req.headers.origin !== options.origin || !req.url?.startsWith("/") || req.url.startsWith("//") || /[\r\n\\]/.test(req.url)) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); return;
      }
      if (!await this.targetAvailable() || socket.destroyed) { socket.destroy(); return; }
      const protocols = req.headers["sec-websocket-protocol"]?.split(",").map((part) => part.trim()).filter(Boolean);
      const headers = this.upstreamHeaders(req);
      for (const key of Object.keys(headers)) if (key.startsWith("sec-websocket-")) delete headers[key];
      const upstream = new WebSocket(`ws://127.0.0.1:${options.targetPort}${req.url}`, protocols, { headers, handshakeTimeout: 5000, maxPayload: 8 * 1024 * 1024 });
      this.webSockets.add(upstream);
      upstream.once("error", () => { socket.destroy(); upstream.terminate(); });
      upstream.once("close", () => { this.webSockets.delete(upstream); socket.destroy(); });
      socket.once("close", () => upstream.terminate());
      upstream.once("open", () => {
        if (!this.authorized(req)) { socket.destroy(); upstream.terminate(); return; }
        if (upstream.protocol) req.headers["sec-websocket-protocol"] = upstream.protocol;
        else delete req.headers["sec-websocket-protocol"];
        this.wss.handleUpgrade(req, socket, head, (client) => {
          this.webSockets.add(client);
          client.on("message", (data, binary) => {
            if (!this.authorized(req) || upstream.readyState !== WebSocket.OPEN || upstream.bufferedAmount > 1024 * 1024) { client.terminate(); return; }
            upstream.send(data, { binary });
          });
          upstream.on("message", (data, binary) => {
            if (!this.authorized(req) || client.readyState !== WebSocket.OPEN || client.bufferedAmount > 1024 * 1024) { upstream.terminate(); return; }
            client.send(data, { binary });
          });
          client.on("error", () => upstream.terminate());
          client.on("close", () => { this.webSockets.delete(client); upstream.terminate(); });
        });
      });
    })().catch(() => socket.destroy()); });
  }

  private async targetAvailable(): Promise<boolean> {
    try { return !this.closed && await this.options.verifyTarget() && !this.closed; }
    catch { return false; }
  }

  private authorized(req: IncomingMessage): boolean {
    if (this.closed || !this.options.ready() || Date.now() > this.expiresAt) return false;
    const value = (req.headers.cookie ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${this.cookieName}=`))?.slice(this.cookieName.length + 1);
    return !!value && equal(value, this.session);
  }
  private upstreamHeaders(req: IncomingMessage): IncomingHttpHeaders {
    const headers = safeHeaders(req.headers);
    headers.host = `127.0.0.1:${this.options.targetPort}`;
    if (req.headers.origin) headers.origin = `http://127.0.0.1:${this.options.targetPort}`;
    const cookies = (req.headers.cookie ?? "").split(";").map((part) => part.trim())
      .filter((part) => part.startsWith(this.appPrefix)).map((part) => part.slice(this.appPrefix.length));
    if (cookies.length) headers.cookie = cookies.join("; ");
    return headers;
  }
  private scopeCookie(cookie: string): string | null {
    const [pair, ...attributes] = cookie.split(";");
    if (!pair || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+=/.test(pair)) return null;
    const scoped = attributes.filter((part) => !/^\s*(domain|path|samesite|httponly)(=|\s|$)/i.test(part));
    // HttpOnly prevents one application reading another preview's cookies on
    // the shared hostname; names are mapped back only for this upstream.
    return `${this.appPrefix}${pair}; ${scoped.join(";")}; Path=/; SameSite=Strict; HttpOnly`;
  }
  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, "127.0.0.1", () => { this.server.removeListener("error", reject); resolve(); });
    });
  }
  launch(controlOrigin?: string): { url: string; expiresAt: string } {
    if (this.closed || !this.options.ready()) throw new Error("Preview is not ready.");
    if (controlOrigin === this.options.origin) throw new Error("Preview origin must differ from the control plane. Configure PREVIEW_ORIGINS.");
    for (const [value, expiresAt] of this.tickets) if (expiresAt < Date.now()) this.tickets.delete(value);
    if (this.tickets.size >= 8) throw new Error("Several preview links are still pending. Use one or wait a minute before opening another.");
    const value = secret(); const expiresAt = Date.now() + 60_000; this.tickets.set(value, expiresAt);
    return { url: `${this.options.origin}/__hoop_session/${value}`, expiresAt: new Date(expiresAt).toISOString() };
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true; this.tickets.clear(); this.expiresAt = 0;
    for (const client of this.webSockets) client.terminate();
    for (const socket of this.sockets) socket.destroy();
    this.wss.close();
    if (this.server.listening) await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
  }
}
