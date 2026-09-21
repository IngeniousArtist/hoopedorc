import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GeminiAdapter, GeminiStream } from "./gemini.js";
import { makeAdapter } from "./index.js";

const stats = { input_tokens: 100, output_tokens: 12, cached: 30, input: 70, models: { nested: { input_tokens: 100 } } };
const final = (status = "success") => ({ type: "result", status, stats });
test("VW17: Gemini normalizes cumulative stats once and rejects malformed completion", () => {
  const stream = new GeminiStream(); stream.line(JSON.stringify({ type: "message", role: "assistant", content: "hello" })); stream.line(JSON.stringify(final()));
  assert.equal(stream.text, "hello"); assert.equal(stream.tokensIn, 70); assert.equal(stream.tokensCached, 30); assert.equal(stream.tokensOut, 12);
  stream.line(JSON.stringify(final())); assert.equal(stream.malformed, true); assert.equal(stream.tokensIn, 70);
  for (const value of ["no json", "null", JSON.stringify({ ...final(), stats: { ...stats, cached: 200 } }), JSON.stringify({ ...final(), stats: {} })]) { const parser = new GeminiStream(); parser.line(value); assert.equal(parser.malformed, true); }
});

async function fixture(body: string, run: (dir: string) => Promise<void>, version = "0.60.0") {
  const root = mkdtempSync(join(tmpdir(), "vw17-gemini-")); const prior = process.env.PATH;
  writeFileSync(join(root, "gemini"), `#!${process.execPath}\nif (process.argv.includes('--version')) { console.log(${JSON.stringify(version)}); process.exit(); }\n${body}`); chmodSync(join(root, "gemini"), 0o755); process.env.PATH = `${root}:${prior ?? ""}`;
  try { await run(root); } finally { if (prior === undefined) delete process.env.PATH; else process.env.PATH = prior; rmSync(root, { recursive: true, force: true }); }
}
const options = (cwd: string) => ({ model: "configured", cwd, prompt: "literal prompt $() with\nnewlines", onLog: () => {} });

test("VW17: native invocation preserves stdin/argv, refuses unsupported profiles, retries cleanly and accounts failures", async () => {
  await fixture(`import fs from 'node:fs';
let input=''; process.stdin.on('data', x => input+=x); process.stdin.on('end', () => {
 fs.writeFileSync('observed.json', JSON.stringify({ input, args:process.argv.slice(2), secret:process.env.VW17_SECRET, cwd:process.env.PWD }));
 console.log(JSON.stringify({type:'message',role:'assistant',content:'done'}));
 console.log(JSON.stringify(${JSON.stringify(final())}));
});`, async (cwd) => {
    const adapter = makeAdapter({ id: "g", displayName: "Gemini", runner: "gemini", geminiModel: "account-model", roles: [], enabled: true, maxConcurrent: 1 }, "");
    process.env.VW17_SECRET = "must-not-inherit";
    try {
      for (let i = 0; i < 2; i++) { const result = await adapter.run(options(cwd)); assert.equal(result.ok, true); assert.equal(result.tokensIn, 70); }
      const observed = JSON.parse(readFileSync(join(cwd, "observed.json"), "utf8")) as { input: string; secret?: string; cwd: string; args: string[] }; assert.equal(observed.input, options(cwd).prompt); assert.equal(observed.secret, undefined); assert.equal(observed.cwd, cwd); assert.deepEqual(observed.args, ["--model", "account-model", "--prompt", "Follow the task instructions provided on stdin.", "--output-format", "stream-json", "--approval-mode", "yolo", "--skip-trust"]);
      await assert.rejects(adapter.run({ ...options(cwd), activation: {} as never }), /Selective activation/);
      await assert.rejects(adapter.run({ ...options(cwd), execution: {} as never }), /Isolated execution/);
      await assert.rejects(new GeminiAdapter("model", "high").run(options(cwd)), /effort/);
    } finally { delete process.env.VW17_SECRET; }
  });
  await fixture(`console.log(JSON.stringify(${JSON.stringify({ ...final("error"), error: { message: "429 quota exceeded" } })})); process.exitCode=1;`, async (cwd) => {
    const result = await new GeminiAdapter("model").run(options(cwd)); assert.equal(result.ok, false); assert.equal(result.exitReason, "rate_limited"); assert.equal(result.tokensOut, 12);
  });
  for (const body of ["", `console.log('broken');`, `console.log(JSON.stringify(${JSON.stringify(final())})); process.exitCode=1;`]) await fixture(body, async (cwd) => { assert.equal((await new GeminiAdapter("model").run(options(cwd))).ok, false); });
  await fixture("throw new Error('must not run');", async (cwd) => { await assert.rejects(new GeminiAdapter("model").run(options(cwd)), /0.60.0 is required/); }, "0.61.0");
});

test("VW17: cancellation settles Gemini's process group and preserves final observed usage", async () => {
  await fixture(`import {spawn} from 'node:child_process';
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 process.on('SIGTERM',()=>{child.on('exit',()=>process.exit(0));});
 console.log(JSON.stringify(${JSON.stringify(final())}));
 console.error('child-pid:'+child.pid); setInterval(()=>{},1000);`, async (cwd) => {
    const controller = new AbortController(); let pid = 0;
    const result = await new GeminiAdapter("model").run({ ...options(cwd), signal: controller.signal, onLog: (line) => { const match = line.match(/child-pid:(\d+)/); if (match) { pid = Number(match[1]); controller.abort(); } } });
    assert.equal(result.exitReason, "killed"); assert.equal(result.tokensIn, 70); assert.ok(pid > 0); assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  });
});
