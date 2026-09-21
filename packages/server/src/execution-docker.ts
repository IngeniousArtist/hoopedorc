import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execManagedProcess, spawnManagedProcess, type AgentExecution, type ManagedProcessOptions } from "@orc/adapters";
import { ResourceUnavailableError, type ExecutionProfile } from "@orc/types";

export const WORKER_CLI_VERSION = "codex-cli 0.154.0";
export class ExecutionUnsettledError extends ResourceUnavailableError {
  constructor() { super("Worker termination could not be verified. Its account slot and workspace remain protected; inspect execution status before recovery.", false); }
}
export interface DockerWorkerIdentity { id: string; workerName: string; proxyName: string; volumeName: string; owner: string }
export interface DockerWorkerSpec {
  identity: DockerWorkerIdentity;
  profile: ExecutionProfile;
  imageId: string;
  cwd: string;
  directory: string;
  readOnly: boolean;
  /** Durable state changes must complete before the next external mutation. */
  transition: (state: "preparing" | "running" | "stopping" | "stopped" | "unresolved") => void;
}
const inside = (root: string, target: string) => { const path = relative(root, target); return path === "" || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path); };
export function workerIdentity(owner: string): DockerWorkerIdentity {
  const id = randomUUID(); return { id, owner, workerName: `hoop-worker-${id}`, proxyName: `hoop-proxy-${id}`, volumeName: `hoop-proxy-${id}` };
}

/** External values remain argv entries. The Docker endpoint is server-owned. */
export class DockerExecutionDriver {
  private readonly stopping = new Map<string, Promise<void>>();
  constructor(private readonly options: {
    run?: typeof execManagedProcess;
    spawn?: typeof spawnManagedProcess;
    endpoint?: string;
    transportDirectory?: string;
  } = {}) {}
  private args(args: string[]): string[] {
    const endpoint = this.options.endpoint ?? process.env.DOCKER_HOST ?? "unix:///var/run/docker.sock";
    if (!/^unix:\/\/\/[a-zA-Z0-9_./-]+$/.test(endpoint)) throw new ResourceUnavailableError("Isolated workers require an explicit local Unix Docker socket; remote Docker contexts are unsupported.", false);
    return ["--host", endpoint, ...args];
  }
  private processOptions(signal?: AbortSignal): ManagedProcessOptions {
    return { signal, timeoutMs: 20_000, maxOutputBytes: 1024 * 1024, env: { PATH: process.env.PATH, LANG: "C.UTF-8" } };
  }
  async command(args: string[], signal?: AbortSignal): Promise<string> {
    return (await (this.options.run ?? execManagedProcess)("docker", this.args(args), this.processOptions(signal))).stdout;
  }
  async inspectProfile(profile: ExecutionProfile, signal?: AbortSignal): Promise<{ imageId: string }> {
    const version = JSON.parse(await this.command(["version", "--format", "{{json .Server}}"], signal)) as { Os?: string };
    if (version.Os !== "linux") throw new ResourceUnavailableError("The isolated worker requires a Linux Docker engine.", false);
    const image = JSON.parse(await this.command(["image", "inspect", profile.image], signal)) as { Id: string; Config?: { Labels?: Record<string, string>; Volumes?: Record<string, unknown> } }[];
    const selected = image[0];
    if (!selected || !/^sha256:[a-f0-9]{64}$/.test(selected.Id) || selected.Config?.Labels?.["io.hoopedorc.worker"] !== "codex-v1" || Object.keys(selected.Config?.Volumes ?? {}).length) throw new ResourceUnavailableError("Image is missing the verified codex-v1 contract or declares implicit volumes. Build the documented worker image.", false);
    const volumes = JSON.parse(await this.command(["volume", "inspect", profile.accountVolume], signal)) as { Driver: string; Options?: Record<string, unknown> | null; Labels?: Record<string, string> }[];
    const volume = volumes[0];
    if (!volume || volume.Driver !== "local" || Object.keys(volume.Options ?? {}).length || volume.Labels?.["io.hoopedorc.account"] !== profile.accountPoolId) throw new ResourceUnavailableError("Account volume must already exist with the matching pool label and no host-path/remote driver options. Sign in with the worker CLI first.", false);
    return { imageId: selected.Id };
  }
  private labels(identity: DockerWorkerIdentity) { return ["--label", `io.hoopedorc.owner=${identity.owner}`, "--label", `io.hoopedorc.worker-id=${identity.id}`]; }
  private async ownedContainer(name: string, identity: DockerWorkerIdentity): Promise<boolean> {
    // Listing returns [] for absence. An unavailable daemon is not absence.
    const ids = (await this.command(["container", "ls", "-aq", "--filter", `name=^/${name}$`])).trim();
    if (!ids) return false;
    const rows = JSON.parse(await this.command(["container", "inspect", name])) as { Config?: { Labels?: Record<string, string> } }[];
    const labels = rows[0]?.Config?.Labels;
    if (labels?.["io.hoopedorc.owner"] !== identity.owner || labels?.["io.hoopedorc.worker-id"] !== identity.id) throw new ExecutionUnsettledError();
    return true;
  }
  stop(identity: DockerWorkerIdentity): Promise<void> {
    const previous = this.stopping.get(identity.id); if (previous) return previous;
    const pending = this.stopOwned(identity).finally(() => this.stopping.delete(identity.id));
    this.stopping.set(identity.id, pending); return pending;
  }
  private async stopOwned(identity: DockerWorkerIdentity): Promise<void> {
    for (const name of [identity.workerName, identity.proxyName]) {
      if (await this.ownedContainer(name, identity)) await this.command(["container", "rm", "-f", name]);
      if (await this.ownedContainer(name, identity)) throw new ExecutionUnsettledError();
    }
    const volumes = (await this.command(["volume", "ls", "-q", "--filter", `name=^${identity.volumeName}$`])).trim();
    if (volumes) {
      const rows = JSON.parse(await this.command(["volume", "inspect", identity.volumeName])) as { Labels?: Record<string, string> }[];
      if (rows[0]?.Labels?.["io.hoopedorc.owner"] !== identity.owner || rows[0]?.Labels?.["io.hoopedorc.worker-id"] !== identity.id) throw new ExecutionUnsettledError();
      await this.command(["volume", "rm", identity.volumeName]);
    }
  }
  async prepare(spec: DockerWorkerSpec, signal?: AbortSignal): Promise<AgentExecution> {
    const { identity, profile } = spec;
    if (!isAbsolute(spec.cwd) || !isAbsolute(spec.directory)) throw new ResourceUnavailableError("Worker paths must be server-owned absolute paths.", false);
    const cwd = await realpath(spec.cwd); await mkdir(spec.directory, { recursive: true, mode: 0o700 });
    const directory = await realpath(spec.directory);
    if ([cwd, directory].some((path) => /[,\n\r]/.test(path)) || inside(cwd, directory) || inside(directory, cwd)) throw new ResourceUnavailableError("Worker transport state must be outside the task workspace.", false);
    const outputDirectory = join(directory, "io"); const transport = join(directory, "transport");
    await mkdir(outputDirectory, { mode: 0o700 }); await mkdir(transport, { mode: 0o700 });
    const metadata = await lstat(join(cwd, ".git")).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    const gitMask = join(transport, "git-mask");
    if (metadata?.isSymbolicLink()) throw new ResourceUnavailableError("Symlinked Git metadata is unsupported in isolated workspaces.", false);
    if (metadata?.isDirectory()) await mkdir(gitMask, { mode: 0o500 });
    else if (metadata) await writeFile(gitMask, "Host Git metadata is intentionally unavailable in the worker.\n", { mode: 0o400, flag: "wx" });
    const gitMount = metadata ? ["--mount", `type=bind,source=${gitMask},target=/work/.git,readonly`] : [];
    const source = this.options.transportDirectory ?? dirname(fileURLToPath(import.meta.url));
    for (const name of ["execution-entry.mjs", "execution-proxy.mjs"]) await writeFile(join(transport, name), await readFile(join(source, name)), { mode: 0o400, flag: "wx" });
    const uid = process.getuid?.() ?? 1000; const gid = process.getgid?.() ?? 1000;
    if (uid === 0) throw new ResourceUnavailableError("Run Hoopedorc under a non-root service user before using isolated workers.", false);
    let stopping: Promise<void> | undefined;
    const close = () => stopping ??= (async () => {
      spec.transition("stopping");
      try { await this.stop(identity); spec.transition("stopped"); }
      catch { spec.transition("unresolved"); throw new ExecutionUnsettledError(); }
    })();
    try {
      spec.transition("preparing");
      await this.command(["volume", "create", ...this.labels(identity), "--driver", "local", "--opt", "type=tmpfs", "--opt", "device=tmpfs", "--opt", `o=uid=${uid},gid=${gid},mode=0700,size=1048576`, identity.volumeName], signal);
      const security = ["--pull=never", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user", `${uid}:${gid}`, "--pids-limit", "32", "--memory", "128m", "--cpus", "0.25", "--init"];
      await this.command(["run", "-d", "--name", identity.proxyName, ...this.labels(identity), ...security, "--network", "bridge", "--mount", `type=volume,source=${identity.volumeName},target=/proxy,volume-nocopy`, "--mount", `type=bind,source=${join(transport, "execution-proxy.mjs")},target=/proxy.mjs,readonly`, "--entrypoint", "node", spec.imageId, "/proxy.mjs"], signal);
      let ready = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        signal?.throwIfAborted();
        try { await this.command(["exec", identity.proxyName, "node", "-e", "require('node:fs').accessSync('/proxy/connect.sock')"], signal); ready = true; break; }
        catch { if (attempt === 19) break; await new Promise((resolve) => setTimeout(resolve, 100)); }
      }
      if (!ready) throw new ResourceUnavailableError("Restricted provider proxy did not become ready.", false);
      let spawned = false;
      return { outputDirectory, close, spawn: (command, originalArgs, options) => {
        if (spawned || command !== "codex" && command !== "node" || (resolve(String(options.cwd)) !== cwd && resolve(String(options.cwd)) !== resolve(spec.cwd))) throw new ResourceUnavailableError("Worker invocation does not match its owned execution context.", false);
        signal?.throwIfAborted(); options.signal?.throwIfAborted(); spawned = true;
        const translate = (arg: string) => arg === cwd || arg === spec.cwd ? "/work" : inside(outputDirectory, arg) && isAbsolute(arg) ? `/io/${relative(outputDirectory, arg).split(sep).join("/")}` : arg;
        const args = originalArgs.map(translate);
        if (command === "codex") {
          if (args[0] !== "exec") throw new ResourceUnavailableError("Only the Codex exec invocation is supported.", false);
          if (!args.includes("--skip-git-repo-check")) args.push("--skip-git-repo-check");
          args.push("-c", 'forced_login_method="chatgpt"');
        }
        spec.transition("running");
        return (this.options.spawn ?? spawnManagedProcess)("docker", this.args(["run", "-i", "--name", identity.workerName, ...this.labels(identity), "--pull=never", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user", `${uid}:${gid}`, "--pids-limit", String(profile.pidsLimit), "--memory", `${profile.memoryMiB}m`, "--cpus", String(profile.cpus), "--init", "--network", "none", "--tmpfs", "/tmp:rw,nosuid,nodev,size=268435456,mode=1777", "--mount", `type=bind,source=${cwd},target=/work${spec.readOnly ? ",readonly" : ""}`, ...gitMount, "--mount", `type=bind,source=${outputDirectory},target=/io`, "--mount", `type=bind,source=${join(transport, "execution-entry.mjs")},target=/entry.mjs,readonly`, "--mount", `type=volume,source=${profile.accountVolume},target=/account,volume-nocopy`, "--mount", `type=volume,source=${identity.volumeName},target=/proxy,volume-nocopy`, "--workdir", "/work", "--entrypoint", "node", spec.imageId, "/entry.mjs", JSON.stringify({ command, args })]), { ...options, cwd, env: this.processOptions().env });
      } };
    } catch (error) { await close(); throw error; }
  }
}
