import type { LibrarySelection } from "./api";
import type { ModelInvocation, RunnerKind } from "./domain";

/** Registrations are inert until a selected policy invokes them. No secrets. */
export interface ActivationMcp {
  id: string;
  enabled: boolean;
  transport: { type: "stdio"; command: string; args: string[] } | { type: "http"; url: string };
}
export interface ActivationPolicy {
  mode: "inherit" | "selected";
  skills: LibrarySelection[];
  mcps: ActivationMcp[];
  browser: boolean;
}
export interface ActivationRevision {
  projectId: string;
  revision: number;
  createdAt: string;
  policy: ActivationPolicy;
}
export interface ActivationManifest {
  id: string;
  projectId: string;
  taskId?: string;
  stage: ModelInvocation["stage"];
  runner: RunnerKind;
  revision: number;
  createdAt: string;
  state: "inherited" | "verified" | "refused";
  cliVersion?: string;
  skills: { id: string; revision: number; contentSha: string }[];
  servers: { id: string; tools: { name: string; schemaSha?: string }[] }[];
  browser: "disabled" | "task-scoped" | "unavailable-outside-task";
  detail: string;
}
export interface ActivationResponse {
  current: ActivationRevision;
  revisions: ActivationRevision[];
  manifests: ActivationManifest[];
  compatibility: { runner: RunnerKind; selective: boolean; detail: string }[];
  nativePlugins: { supported: false; reason: string };
}
export interface SaveActivationRequest { requestId: string; expectedRevision: number; policy: ActivationPolicy }
export interface SaveActivationResponse { revision: ActivationRevision }
