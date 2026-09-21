import { ManagedProcessError, spawnManagedProcess, type ManagedProcess, type ManagedProcessOptions } from "./managed-process.js";

/** Server-owned per-invocation transport. Never deserialized from task prose. */
export interface AgentExecution {
  outputDirectory: string;
  spawn: (command: string, args: readonly string[], options: ManagedProcessOptions) => ManagedProcess;
  /** Must prove the whole external worker stopped, not just the host client. */
  close: () => Promise<void>;
}
export async function execInvocationProcess(command: string, args: readonly string[], options: ManagedProcessOptions, execution?: AgentExecution): Promise<{ stdout: string; stderr: string }> {
  options.signal?.throwIfAborted();
  const managed = (execution?.spawn ?? spawnManagedProcess)(command, args, options);
  let result;
  try { result = await managed.settled; }
  finally { await execution?.close(); }
  if (result.code !== 0 || result.aborted || result.timedOut || result.outputLimitExceeded) throw new ManagedProcessError(command, result);
  return { stdout: result.stdout, stderr: result.stderr };
}
