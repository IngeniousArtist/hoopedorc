import type { RunnerKind } from "./domain";

/** Operator-owned images and CLI login volumes; never provider credentials. */
export interface ExecutionProfile {
  id: string;
  name: string;
  kind: "docker";
  runner: "codex";
  /** Locally installed image. Admission pins the inspected content ID. */
  image: string;
  /** Existing, explicitly labelled Docker volume containing this CLI's login. */
  accountVolume: string;
  accountPoolId: string;
  cpus: number;
  memoryMiB: number;
  pidsLimit: number;
}
export interface ExecutionCapability {
  profileId?: string;
  runner: RunnerKind;
  state: "host" | "unavailable" | "verified";
  detail: string;
  imageId?: string;
  runtimeId?: string;
  cliVersion?: string;
  authentication?: "chatgpt" | "unavailable";
  checkedAt: string;
}
export interface ExecutionWorker {
  id: string;
  invocationId: string;
  projectId?: string;
  taskId?: string;
  profileId: string;
  /** Immutable configuration and admission evidence for this invocation. */
  profile: ExecutionProfile;
  verification?: ExecutionCapability;
  imageId: string;
  runtimeId: string;
  workerName: string;
  proxyName: string;
  state: "preparing" | "running" | "stopping" | "stopped" | "unresolved";
  createdAt: string;
  updatedAt: string;
  detail?: string;
}
export interface ExecutionStatusResponse {
  platform: string;
  profiles: ExecutionCapability[];
  workers: ExecutionWorker[];
  host: { filesystemIsolated: false; networkIsolated: false; authentication: "host-cli" };
}
