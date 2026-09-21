import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { allowedTarget, publicAddress, startProxy } from "./execution-proxy.mjs";

function request(path: string, text: string) {
  return new Promise<string>((resolve, reject) => {
    const client = net.connect(path); let response = "";
    client.setTimeout(2_000, () => client.destroy(new Error("Proxy response timed out")));
    client.once("connect", () => client.write(text));
    client.on("data", (data) => {
      response += data.toString();
      if (response.includes("\r\n\r\n")) { client.destroy(); resolve(response); }
    });
    client.once("error", reject);
  });
}

test("VW14: egress policy refuses local, metadata, control-plane and alternate-port destinations", () => {
  for (const target of ["localhost:443", "127.0.0.1:443", "169.254.169.254:443", "chatgpt.com:4317", "api.openai.com.evil.test:443", "api.openai.com.:443", "user@api.openai.com:443", "api.openai.com:443/path", "[::1]:443", "API.OPENAI.COM:443"]) assert.equal(allowedTarget(target), null, target);
  assert.equal(allowedTarget("chatgpt.com:443"), "chatgpt.com");
  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.100.100.100", "0.0.0.0", "224.0.0.1", "::ffff:127.0.0.1", "::1", "198.18.0.1"]) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress("8.8.8.8"), true);
});

test("VW14: real CONNECT proxy refuses DNS rebinding and settles sockets on shutdown", async () => {
  const root = mkdtempSync(join(tmpdir(), "vw14-proxy-")); const path = join(root, "proxy.sock"); let connects = 0;
  const close = await startProxy(path, { lookup: () => Promise.resolve([{ address: "127.0.0.1", family: 4 }]), connect: () => { connects++; throw new Error("Must not connect"); } });
  try {
    assert.match(await request(path, "CONNECT api.openai.com:443 HTTP/1.1\r\nHost: api.openai.com:443\r\n\r\n"), /403 Forbidden/);
    assert.match(await request(path, "CONNECT 169.254.169.254:443 HTTP/1.1\r\nHost: metadata\r\n\r\n"), /403 Forbidden/);
    assert.match(await request(path, "GET http://localhost:4317/api/settings HTTP/1.1\r\nHost: localhost\r\n\r\n"), /403 Forbidden/);
    assert.equal(connects, 0);
  } finally { await close(); rmSync(root, { recursive: true, force: true }); }
});

test("VW14: provider tunneling connects only to the inspected IP and preserves stream bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "vw14-proxy-ok-")); const path = join(root, "proxy.sock");
  let seen = ""; const peers = new Set<net.Socket>();
  const fixture = net.createServer((socket) => { peers.add(socket); socket.once("close", () => peers.delete(socket)); socket.on("data", (data) => { seen += data.toString(); socket.write("fixture reply"); }); });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const port = (fixture.address() as net.AddressInfo).port;
  const close = await startProxy(path, { lookup: () => Promise.resolve([{ address: "8.8.8.8", family: 4 }]), connect: (options) => { assert.deepEqual(options, { host: "8.8.8.8", port: 443 }); return net.connect(port, "127.0.0.1"); } });
  try {
    await new Promise<void>((resolve, reject) => {
      const client = net.connect(path); let reply = "";
      client.setTimeout(2_000, () => client.destroy(new Error("Tunnel timeout")));
      client.once("connect", () => client.write("CONNECT api.openai.com:443 HTTP/1.1\r\nHost: api.openai.com:443\r\n\r\nstream bytes"));
      client.once("error", reject);
      client.on("data", (data) => { reply += data.toString(); if (reply.includes("fixture reply")) { assert.match(reply, /200 Connection Established/); client.destroy(); resolve(); } });
    });
    assert.equal(seen, "stream bytes");
  } finally { await close(); for (const socket of peers) socket.destroy(); await new Promise<void>((resolve) => fixture.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
});
