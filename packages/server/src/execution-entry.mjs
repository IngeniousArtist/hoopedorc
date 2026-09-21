// Executed inside the network-none worker. This is only a byte bridge to the
// trusted sidecar's restricted CONNECT proxy, never a host shell launcher.
import net from "node:net";
import { spawn } from "node:child_process";

const config = JSON.parse(process.argv[2] ?? "null");
if (!config || !["codex", "node"].includes(config.command) || !Array.isArray(config.args) || config.args.some((arg) => typeof arg !== "string")) throw new Error("Invalid owned worker launch.");
const sockets = new Set();
const server = net.createServer((client) => {
  const upstream = net.connect("/proxy/connect.sock"); sockets.add(client); sockets.add(upstream);
  client.on("error", () => upstream.destroy()); upstream.on("error", () => client.destroy());
  client.once("close", () => { sockets.delete(client); upstream.destroy(); });
  upstream.once("close", () => { sockets.delete(upstream); client.destroy(); });
  client.pipe(upstream); upstream.pipe(client);
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const proxy = `http://127.0.0.1:${server.address().port}`;
const child = spawn(config.command, config.args, { cwd: "/work", stdio: "inherit", env: {
  PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/home/worker", CODEX_HOME: "/account",
  TMPDIR: "/tmp", PWD: "/work", LANG: "C.UTF-8", TERM: "dumb",
  HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy,
  http_proxy: proxy, https_proxy: proxy, all_proxy: proxy,
} });
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
child.on("error", () => { process.stderr.write("Worker CLI could not start.\n"); process.exitCode = 1; for (const socket of sockets) socket.destroy(); server.close(); });
child.on("exit", (code) => { process.exitCode = code ?? 1; for (const socket of sockets) socket.destroy(); server.close(); });
