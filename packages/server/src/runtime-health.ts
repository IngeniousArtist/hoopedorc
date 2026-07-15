import type { HealthResponse } from "@orc/types";
import type { ShutdownSnapshot } from "./shutdown.js";

export interface RuntimeHealthInput {
  lifecycle: ShutdownSnapshot;
  mock: boolean;
  version: string;
  dockerAvailable: boolean;
  dockerRequired: boolean;
}
/** Build the public, credential-free uptime payload from explicit state. */
export function buildRuntimeHealth(input: RuntimeHealthInput): HealthResponse {
  const degraded =
    input.dockerRequired && !input.dockerAvailable
      ? ["Docker is required for configured gates but the daemon is unavailable"]
      : [];
  return {
    ok: input.lifecycle.state === "running" && degraded.length === 0,
    mock: input.mock,
    version: input.version,
    state: input.lifecycle.state,
    shutdownReason: input.lifecycle.reason,
    degraded,
    dependencies: {
      docker: {
        available: input.dockerAvailable,
        required: input.dockerRequired,
        detail: input.dockerAvailable
          ? "Docker daemon available"
          : input.dockerRequired
            ? "Docker daemon unavailable — required gates are degraded"
            : "Docker daemon unavailable — auto mode uses the host",
      },
    },
  };
}
