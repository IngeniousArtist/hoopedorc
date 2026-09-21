import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { probeSelectiveClaude, selectiveClaudeArgs, selectiveClaudeVersion, verifySelectiveClaudeAuth } from "./activation.js";
import { ClaudeAdapter, CodexAdapter, OpenCodeAdapter } from "./index.js";

test("VW12: actual subprocess protocol allowlists, refusal, cancellation and adapter delivery", async () => {
  const root = mkdtempSync(join(tmpdir(), "activation-cli-test-")); const previous = process.env.PATH;
  const cli = join(root, "claude");
  writeFileSync(cli, `#!${process.execPath}
const readline = require('node:readline');
const args = process.argv.slice(2);
if(args.includes('--version')) { console.log('2.1.278 (Claude Code)'); process.exit(0); }
if(args.includes('auth')) { console.log(JSON.stringify({loggedIn:true,authMethod:args.includes('switch')?'changed':'fixture',apiProvider:'fixture'})); process.exit(0); }
const mode = args[args.indexOf('--mcp-config')+1];
if(args.includes('--input-format')) {
 readline.createInterface({input:process.stdin}).on('line',line=>{
  const r=JSON.parse(line); if(r.type!=='control_request') throw Error('Model request forbidden in probe');
  if(mode==='hang') return;
  const response=r.request.subtype==='initialize'?{commands:mode==='skill'?[{name:'unselected'}]:[],agents:mode==='plugin'?[{name:'plugin:agent'}]:[]}:{mcpServers:[{name:mode==='extra'?'unselected':'selected',status:mode==='missing'?'failed':'connected',tools:[{name:'fixture_check',inputSchema:{type:'object'}}]}]};
  console.log(JSON.stringify({type:'control_response',response:{subtype:'success',response}}));
 });
} else {
 let prompt=''; process.stdin.on('data',b=>prompt+=b); process.stdin.on('end',()=>console.log(JSON.stringify({type:'result',result:JSON.stringify({args,prompt})})));
}
`); chmodSync(cli, 0o755); process.env.PATH = `${root}:${previous}`;
  try {
    assert.equal(await selectiveClaudeVersion(), "2.1.278");
    await verifySelectiveClaudeAuth({ mcpConfigPath: "same" });
    await assert.rejects(verifySelectiveClaudeAuth({ mcpConfigPath: "switch" }), /billing method/);
    const result = await probeSelectiveClaude(root, { mcpConfigPath: "ok" }, ["selected"]);
    assert.equal(result[0]?.tools[0]?.name, "fixture_check"); assert.equal(result[0]?.tools[0]?.schemaSha?.length, 64);
    for (const mode of ["extra", "skill", "plugin", "missing"]) await assert.rejects(probeSelectiveClaude(root, { mcpConfigPath: mode }, ["selected"]), /unselected|unavailable/);
    const abort = new AbortController(); const running = probeSelectiveClaude(root, { mcpConfigPath: "hang" }, [], abort.signal); setTimeout(() => abort.abort(), 100);
    await assert.rejects(running, /cancelled/);
    const options = { model: "test", cwd: root, prompt: "Only selected skill text.", onLog() {}, activation: { mcpConfigPath: "owned.json" } };
    const run = await new ClaudeAdapter().run(options); const report = JSON.parse(run.summary!) as { prompt: string; args: string[] };
    assert.equal(report.prompt, options.prompt); assert.ok(report.args.includes("--strict-mcp-config")); assert.ok(report.args.includes("--disable-slash-commands")); assert.ok(!report.args.includes("--bare"));
    assert.deepEqual(selectiveClaudeArgs(), []);
    await assert.rejects(new CodexAdapter().run(options), /not verified/);
    await assert.rejects(new OpenCodeAdapter("", "test/model").run(options), /not verified/);
  } finally { process.env.PATH = previous; rmSync(root, { recursive: true, force: true }); }
});
