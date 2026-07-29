import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ROUTES } from "@orc/types";
import type { FastifyInstance, HTTPMethods } from "fastify";
import { defaultSettings, ENV } from "./config.js";
import { initDb } from "./db/index.js";
import * as repo from "./db/repo.js";
import { EngineRunner } from "./engine-runner.js";
import { buildApp } from "./index.js";
import { SelfUpdater } from "./self-update.js";
import { WsHub } from "./ws-hub.js";

const CONTRACT_START = "<!-- ROUTES:START -->";
const CONTRACT_END = "<!-- ROUTES:END -->";
const CONTRACT_PATH = fileURLToPath(
  new URL("../../../docs/CONTRACT.md", import.meta.url),
);

type RouteManifest = Readonly<Record<string, string>>;

function splitRoute(signature: string): {
  method: HTTPMethods;
  url: string;
} {
  const separator = signature.indexOf(" ");
  assert.notEqual(separator, -1, `invalid route signature: ${signature}`);
  return {
    method: signature.slice(0, separator) as HTTPMethods,
    url: signature.slice(separator + 1),
  };
}

function unregisteredRoutes(
  app: FastifyInstance,
  manifest: RouteManifest,
): string[] {
  return Object.entries(manifest)
    .filter(([, signature]) => !app.hasRoute(splitRoute(signature)))
    .map(([key, signature]) => `${key}: ${signature}`);
}

function parseDocumentedRoutes(markdown: string): Map<string, string> {
  const starts = markdown.split(CONTRACT_START).length - 1;
  const ends = markdown.split(CONTRACT_END).length - 1;
  assert.equal(starts, 1, `expected one ${CONTRACT_START} marker`);
  assert.equal(ends, 1, `expected one ${CONTRACT_END} marker`);

  const start = markdown.indexOf(CONTRACT_START) + CONTRACT_START.length;
  const end = markdown.indexOf(CONTRACT_END);
  assert.ok(start < end, "route contract markers are out of order");

  const rows = markdown
    .slice(start, end)
    .split("\n")
    .filter(
      (line) =>
        line.startsWith("| `") && !line.startsWith("| `ROUTES` key |"),
    );
  const documented = new Map<string, string>();
  const signatures = new Set<string>();

  for (const row of rows) {
    const match =
      /^\| `([A-Za-z][A-Za-z0-9]*)` \| `(GET|POST|PUT|PATCH|DELETE) (\/api\/[^`]*)` \| .+ \|$/.exec(
        row,
      );
    assert.ok(match, `malformed route contract row: ${row}`);
    const key = match[1]!;
    const method = match[2]!;
    const url = match[3]!;
    const signature = `${method} ${url}`;
    assert.ok(!documented.has(key), `duplicate route contract key: ${key}`);
    assert.ok(
      !signatures.has(signature),
      `duplicate route contract signature: ${signature}`,
    );
    documented.set(key, signature);
    signatures.add(signature);
  }

  return documented;
}

function assertDocumentedRoutes(
  manifest: RouteManifest,
  documented: ReadonlyMap<string, string>,
): void {
  const manifestKeys = Object.keys(manifest);
  assert.deepEqual(
    manifestKeys.filter((key) => !documented.has(key)),
    [],
    "ROUTES keys missing from docs/CONTRACT.md",
  );
  assert.deepEqual(
    [...documented.keys()].filter((key) => !(key in manifest)),
    [],
    "docs/CONTRACT.md route keys missing from ROUTES",
  );
  for (const [key, signature] of Object.entries(manifest)) {
    assert.equal(
      documented.get(key),
      signature,
      `documented route mismatch for ${key}`,
    );
  }
}

test("O30: every ROUTES method and path is registered in Fastify", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-route-contract-"));
  const db = initDb(":memory:");
  repo.upsertSettings(db, defaultSettings());
  const hub = new WsHub();
  const app = await buildApp({
    db,
    hub,
    engine: new EngineRunner(db, hub),
    selfUpdater: new SelfUpdater({
      repoRoot: root,
      mock: true,
      statusFile: join(root, "self-update.json"),
    }),
    env: {
      ...ENV,
      host: "127.0.0.1",
      mock: true,
      apiToken: undefined,
      allowUnauthenticated: false,
      dbPath: ":memory:",
      dbBackupDir: join(root, "backups"),
    },
    repoRoot: root,
    version: "test",
    logger: false,
  });

  try {
    await app.ready();
    assert.deepEqual(unregisteredRoutes(app, ROUTES), []);

    const renamed = {
      ...ROUTES,
      getProject: "GET /api/projects/:id/renamed",
    };
    assert.deepEqual(unregisteredRoutes(app, renamed), [
      "getProject: GET /api/projects/:id/renamed",
    ]);
  } finally {
    await app.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("O33: docs/CONTRACT.md exactly covers the ROUTES manifest", () => {
  const documented = parseDocumentedRoutes(
    readFileSync(CONTRACT_PATH, "utf8"),
  );
  assertDocumentedRoutes(ROUTES, documented);

  assert.throws(
    () =>
      assertDocumentedRoutes(
        { ...ROUTES, undocumentedRoute: "GET /api/undocumented" },
        documented,
      ),
    /ROUTES keys missing from docs\/CONTRACT\.md/,
  );
});
