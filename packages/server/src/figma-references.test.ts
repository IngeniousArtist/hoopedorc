import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractFigmaReferences,
  MAX_FIGMA_REFERENCES,
  normalizeVerifiedFigmaReferences,
} from "./figma-references.js";

test("F52: exact Figma selections are allowlisted, canonicalized, and deduplicated", () => {
  const intake = extractFigmaReferences([
    {
      role: "user",
      content: [
        "Desktop https://figma.com/design/AbC_123/Login?node-id=10%3A20&t=secret",
        "duplicate https://www.figma.com/design/AbC_123/Login?node-id=10-20&mode=dev",
        "mobile https://www.figma.com/file/AbC_123/Login?node-id=30-40",
        "ignore https://figma.com.evil/design/AbC_123/Login?node-id=50-60",
      ].join("\n"),
    },
  ]);

  assert.deepEqual(intake.nodes, [
    {
      canonicalUrl:
        "https://www.figma.com/design/AbC_123/Login?node-id=10-20",
      fileKey: "AbC_123",
      nodeId: "10:20",
    },
    {
      canonicalUrl:
        "https://www.figma.com/file/AbC_123/Login?node-id=30-40",
      fileKey: "AbC_123",
      nodeId: "30:40",
    },
  ]);
  assert.equal(intake.invalidNodeCount, 0);
  assert.equal(intake.overLimit, false);
});

test("F52: whole-file links remain discovery context and invalid nodes fail classification", () => {
  const intake = extractFigmaReferences([
    {
      role: "user",
      content:
        "File https://www.figma.com/design/AbC123/Product?mode=dev invalid https://www.figma.com/design/AbC123/Product?node-id=nope",
    },
  ]);
  assert.deepEqual(intake.nodes, []);
  assert.deepEqual(intake.files, [
    "https://www.figma.com/design/AbC123/Product",
  ]);
  assert.equal(intake.invalidNodeCount, 1);
});

test("F52: an assistant-mentioned link cannot become an enforceable reference", () => {
  const intake = extractFigmaReferences([
    {
      role: "assistant",
      content:
        "Maybe use https://www.figma.com/design/File123/Guess?node-id=10-20",
    },
  ]);
  assert.deepEqual(intake.nodes, []);
  assert.deepEqual(intake.files, []);
});

test("F52: recognized Figma input is bounded", () => {
  const links = Array.from(
    { length: MAX_FIGMA_REFERENCES + 1 },
    (_, index) =>
      `https://www.figma.com/design/File123/Screen?node-id=${index + 1}-2`,
  );
  const intake = extractFigmaReferences([
    { role: "user", content: links.join(" ") },
  ]);
  assert.equal(intake.nodes.length, MAX_FIGMA_REFERENCES);
  assert.equal(intake.overLimit, true);
});

test("F52: repeated copies of one exact link do not consume the reference limit", () => {
  const link =
    "https://www.figma.com/design/File123/Screen?node-id=10-20";
  const intake = extractFigmaReferences([
    {
      role: "user",
      content: Array.from(
        { length: MAX_FIGMA_REFERENCES + 1 },
        () => link,
      ).join(" "),
    },
  ]);
  assert.equal(intake.nodes.length, 1);
  assert.equal(intake.overLimit, false);
});

test("F52: untrusted verification metadata must match every requested node", () => {
  const requested = [
    {
      canonicalUrl:
        "https://www.figma.com/design/File123/Login?node-id=10-20",
      fileKey: "File123",
      nodeId: "10:20",
    },
  ];
  const verified = normalizeVerifiedFigmaReferences(
    requested,
    [
      {
        index: 0,
        nodeId: "10-20",
        name: "Login\nDesktop",
        fileName: "Product",
        width: 1440.4,
        height: 900,
      },
    ],
    "codex",
    "codex",
    "2026-07-23T12:00:00.000Z",
  );
  assert.equal(verified?.[0]?.name, "Login Desktop");
  assert.equal(verified?.[0]?.width, 1440);
  assert.equal(
    normalizeVerifiedFigmaReferences(
      requested,
      [{ index: 0, nodeId: "99:99", name: "Wrong node" }],
      "codex",
      "codex",
      "2026-07-23T12:00:00.000Z",
    ),
    null,
  );
});
