import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { registerBuiltWebApp } from "./web-static";

type RawResponse = {
  statusCode: number;
  contentType: string;
  body: string;
};

function rawGet(app: FastifyInstance, path: string): Promise<RawResponse> {
  const address = app.server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: address.port,
        method: "GET",
        path,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            contentType: String(res.headers["content-type"] ?? ""),
            body,
          });
        });
      },
    );
    req.once("error", reject);
    req.end();
  });
}

test("O1: static route guards canonicalize paths before authorizing files", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-static-guard-"));
  mkdirSync(join(root, "public"));
  mkdirSync(join(root, "private"));
  writeFileSync(join(root, "private", "secret.txt"), "private-sentinel");

  const app = Fastify();
  t.after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });
  await app.register(fastifyStatic, {
    root,
    allowedPath: (pathName) => !pathName.startsWith("/private/"),
  });
  await app.listen({ host: "127.0.0.1", port: 0 });

  for (const path of [
    "/private/secret.txt",
    "/public/../private/secret.txt",
    "/public/%2E%2E/private/secret.txt",
    "/public//../private/secret.txt",
  ]) {
    const response = await rawGet(app, path);
    // Canonical denied paths reach allowedPath's 404; malformed paths may be
    // rejected earlier with 403. Both are fail-closed, while vulnerable
    // releases returned the private file with 200.
    assert.ok(
      response.statusCode === 403 || response.statusCode === 404,
      `${path}: expected 403/404, received ${response.statusCode}`,
    );
    assert.doesNotMatch(response.body, /private-sentinel/, path);
  }
});

test("O1: built web registration serves assets and confines every fallback", async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "hoopedorc-web-dist-"));
  const webDist = join(fixture, "dist");
  mkdirSync(join(webDist, "assets"), { recursive: true });
  writeFileSync(join(webDist, "index.html"), "<html>spa-index</html>");
  writeFileSync(join(webDist, "assets", "app.js"), "window.__app = true;");
  writeFileSync(join(fixture, "outside.txt"), "outside-sentinel");

  const app = Fastify();
  t.after(async () => {
    await app.close();
    rmSync(fixture, { recursive: true, force: true });
  });
  await registerBuiltWebApp(app, webDist);
  await app.listen({ host: "127.0.0.1", port: 0 });

  const index = await rawGet(app, "/");
  assert.equal(index.statusCode, 200);
  assert.match(index.contentType, /^text\/html\b/);
  assert.equal(index.body, "<html>spa-index</html>");

  const asset = await rawGet(app, "/assets/app.js");
  assert.equal(asset.statusCode, 200);
  assert.match(asset.contentType, /javascript/);
  assert.equal(asset.body, "window.__app = true;");

  const spaRoute = await rawGet(app, "/projects/example");
  assert.equal(spaRoute.statusCode, 200);
  assert.match(spaRoute.contentType, /^text\/html\b/);
  assert.equal(spaRoute.body, "<html>spa-index</html>");

  for (const path of ["/api/missing", "/ws", "/ws?token=secret"]) {
    const response = await rawGet(app, path);
    assert.equal(response.statusCode, 404, path);
    assert.match(response.contentType, /^application\/json\b/, path);
    assert.deepEqual(JSON.parse(response.body), { error: "not found" }, path);
  }

  for (const path of [
    "/assets/../../outside.txt",
    "/assets/%2E%2E/%2E%2E/outside.txt",
    "/assets//../..//outside.txt",
  ]) {
    const response = await rawGet(app, path);
    assert.doesNotMatch(response.body, /outside-sentinel/, path);
    if (response.statusCode === 200) {
      assert.equal(response.body, "<html>spa-index</html>", path);
    }
  }
});
