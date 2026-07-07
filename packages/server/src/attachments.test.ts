import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  listAttachments,
  removeAttachment,
  resolveAttachmentPath,
  saveAttachment,
  sanitizeAttachmentName,
} from "./attachments.js";

// ── sanitizeAttachmentName ──

test("sanitizeAttachmentName: accepts a plain allowed-extension name", () => {
  assert.equal(sanitizeAttachmentName("diagram.png"), "diagram.png");
});

test("sanitizeAttachmentName: strips directory components (basename only)", () => {
  assert.equal(sanitizeAttachmentName("../../evil.png"), "evil.png");
  assert.equal(sanitizeAttachmentName("/etc/passwd.txt"), "passwd.txt");
});

test("sanitizeAttachmentName: rejects a disallowed extension", () => {
  assert.equal(sanitizeAttachmentName("script.sh"), null);
  assert.equal(sanitizeAttachmentName("payload.exe"), null);
});

test("sanitizeAttachmentName: rejects a name with no extension at all", () => {
  assert.equal(sanitizeAttachmentName("noext"), null);
});

test("sanitizeAttachmentName: rejects a dotfile / literal '..'", () => {
  assert.equal(sanitizeAttachmentName(".hidden.png"), null);
  assert.equal(sanitizeAttachmentName(".."), null);
  assert.equal(sanitizeAttachmentName("."), null);
});

test("sanitizeAttachmentName: normalizes spaces/unicode to underscores instead of rejecting", () => {
  assert.equal(sanitizeAttachmentName("my diagram!.png"), "my_diagram_.png");
});

test("sanitizeAttachmentName: is case-insensitive on the extension check", () => {
  assert.equal(sanitizeAttachmentName("photo.PNG"), "photo.PNG");
  assert.equal(sanitizeAttachmentName("readme.MD"), "readme.MD");
});

// ── resolveAttachmentPath ──

test("resolveAttachmentPath: resolves a plain name inside dir", () => {
  const dir = "/tmp/hoopedorc-attach-test";
  assert.equal(resolveAttachmentPath(dir, "a.png"), join(dir, "a.png"));
});

test("resolveAttachmentPath: rejects an escaping name even if one somehow reached this far", () => {
  const dir = "/tmp/hoopedorc-attach-test";
  assert.equal(resolveAttachmentPath(dir, "../outside.png"), null);
});

// ── save / list / remove round trip against a real temp directory ──

test("saveAttachment + listAttachments + removeAttachment: real round trip on disk", () => {
  const scratch = mkdtempSync(join(tmpdir(), "hoopedorc-attachments-test-"));
  const dir = join(scratch, "context", "attachments");
  try {
    assert.deepEqual(listAttachments(dir), []); // directory doesn't exist yet

    const buf = Buffer.from("hello world");
    const afterSave = saveAttachment(dir, "notes.txt", buf);
    assert.equal(afterSave.length, 1);
    assert.equal(afterSave[0]!.name, "notes.txt");
    assert.equal(afterSave[0]!.size, buf.length);
    assert.equal(readFileSync(join(dir, "notes.txt"), "utf8"), "hello world");

    // Collision: same sanitized name again gets a numeric suffix, not an
    // overwrite.
    const afterSecond = saveAttachment(dir, "notes.txt", Buffer.from("v2"));
    assert.equal(afterSecond.length, 2);
    const names = afterSecond.map((a) => a.name).sort();
    assert.deepEqual(names, ["notes-2.txt", "notes.txt"]);
    // The original is untouched.
    assert.equal(readFileSync(join(dir, "notes.txt"), "utf8"), "hello world");

    const afterRemove = removeAttachment(dir, "notes.txt");
    assert.notEqual(afterRemove, null);
    assert.deepEqual(
      afterRemove!.map((a) => a.name),
      ["notes-2.txt"],
    );
    assert.equal(existsSync(join(dir, "notes.txt")), false);

    // Removing something that never existed (or an unsafe name) is a
    // clean null, not a throw.
    assert.equal(removeAttachment(dir, "never-existed.txt"), null);
    assert.equal(removeAttachment(dir, "../escape.txt"), null);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
