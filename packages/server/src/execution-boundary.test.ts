import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { execInvocationProcess } from "@orc/adapters";
import type { ExecutionProfile } from "@orc/types";
import { DockerExecutionDriver, workerIdentity } from "./execution-docker";
import { ExecutionService } from "./execution";
import { initDb } from "./db/index";

const enabled = process.env.HOOPEDORC_DOCKER_BOUNDARY === "1";
test("VW14 live Docker: filesystem/network boundary, cancellation, ownership and missing-auth refusal", { skip: !enabled, timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(process.env.HOOPEDORC_WORKER_TEST_ROOT!, "boundary-"));
  const driver = new DockerExecutionDriver(); const account = `hoopedorc-account-${Date.now()}`;
  const profile: ExecutionProfile = { id: "isolated", name: "Boundary fixture", runner: "codex", kind: "docker", image: process.env.HOOPEDORC_WORKER_IMAGE!, accountVolume: account, accountPoolId: "test", cpus: 1, memoryMiB: 512, pidsLimit: 64 };
  const identities: ReturnType<typeof workerIdentity>[] = [];
  try {
    await driver.command(["volume", "create", "--label", "io.hoopedorc.account=test", account]);
    await driver.command(["run", "--rm", "--network", "none", "--mount", `type=volume,source=${account},target=/account`, "--entrypoint", "chown", profile.image, `${process.getuid!()}:${process.getgid!()}`, "/account"]);
    const { imageId } = await driver.inspectProfile(profile);
    const cwd = join(root, "work"); await mkdir(cwd); await mkdir(join(cwd, ".git")); await writeFile(join(cwd, ".git", "host-secret"), "canary"); await writeFile(join(root, "outside"), "canary");
    const states: string[] = [];
    async function worker(readOnly = false) { const identity = workerIdentity("live-boundary"); identities.push(identity); return { identity, execution: await driver.prepare({ identity, profile, imageId, cwd, directory: join(root, identity.id), readOnly, transition: (state) => states.push(state) }) }; }
    const first = await worker();
    const probe = `const fs=require('node:fs');const net=require('node:net');const http=require('node:http');(async()=>{const forbidden=${JSON.stringify([join(root, "outside"), "/var/run/docker.sock", "/work/.git/host-secret", "/Users/ingenious/.codex/auth.json"])};for(const p of forbidden){if(fs.existsSync(p))throw Error('host path visible: '+p)}if(process.getuid()===0||process.env.HOOPEDORC_BOUNDARY_CANARY)throw Error('host identity/env leaked');if(!/NoNewPrivs:\\s+1/.test(fs.readFileSync('/proc/self/status','utf8'))||!/CapEff:\\s+0+/.test(fs.readFileSync('/proc/self/status','utf8')))throw Error('privileges not restricted');if(fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim()!=='536870912'||fs.readFileSync('/sys/fs/cgroup/pids.max','utf8').trim()!=='64')throw Error('resource limits missing');fs.writeFileSync('/work/edited','isolated write');await Promise.all(['169.254.169.254','10.0.0.1','1.1.1.1'].map(host=>new Promise((r,j)=>{const s=net.connect({host,port:80});s.setTimeout(500,()=>{s.destroy();r()});s.on('error',()=>r());s.on('connect',()=>{s.destroy();j(Error('direct network escaped'))})})));await new Promise((r,j)=>{const p=new URL(process.env.HTTPS_PROXY);const q=http.request({host:p.hostname,port:p.port,method:'CONNECT',path:'169.254.169.254:80'});q.on('connect',(res,s)=>{s.destroy();res.statusCode===403?r():j(Error('metadata tunnel allowed'))});q.on('error',j);q.end()});console.log('boundary passed')})().catch(e=>{console.error(e.message);process.exit(1)});`;
    const output = await execInvocationProcess("node", ["-e", probe], { cwd, timeoutMs: 15_000, env: { HOOPEDORC_BOUNDARY_CANARY: "must-not-pass" } }, first.execution);
    assert.match(output.stdout, /boundary passed/); assert.equal(await readFile(join(cwd, "edited"), "utf8"), "isolated write"); assert.equal(states.at(-1), "stopped");
    assert.equal((await driver.command(["container", "ls", "-aq", "--filter", `name=^/${first.identity.workerName}$`])).trim(), "");
    const readonly = await worker(true);
    await execInvocationProcess("node", ["-e", "try {require('fs').writeFileSync('/work/forbidden','x');process.exit(1)}catch(e){if(e.code!=='EROFS')throw e}"], { cwd, timeoutMs: 10_000 }, readonly.execution);
    const cancellation = new AbortController(); const long = await worker();
    const running = execInvocationProcess("node", ["-e", "require('child_process').spawn('node',['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});setInterval(()=>{},1000)"], { cwd, signal: cancellation.signal, timeoutMs: 20_000 }, long.execution);
    setTimeout(() => cancellation.abort(), 1200); await assert.rejects(running);
    assert.equal((await driver.command(["container", "ls", "-aq", "--filter", `name=^/${long.identity.workerName}$`])).trim(), "");
    // Server restart has only the persisted identity, not the old Docker client.
    const orphan = await worker(); await new DockerExecutionDriver().stop(orphan.identity); await orphan.execution.close();
    const db = initDb(":memory:");
    try { const service = new ExecutionService(db, driver, join(root, "control")); const capability = await service.verify(profile); assert.equal(capability.state, "unavailable"); assert.match(capability.detail, /not signed in with ChatGPT/); assert.equal(capability.cliVersion, "codex-cli 0.154.0"); assert.ok(service.response().workers.every((row) => row.state === "stopped")); }
    finally { db.close(); }
  } finally {
    for (const identity of identities) await driver.stop(identity);
    await driver.command(["volume", "rm", account]); await rm(root, { recursive: true, force: true });
  }
});
