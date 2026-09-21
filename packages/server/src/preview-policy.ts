import type { PreviewProfile } from "@orc/types";
import { parseSetupCommand } from "./project-config";

export function parsePreviewProfile(input: unknown): { value: PreviewProfile } | { error: string } {
  const command = parseSetupCommand(input);
  if ("error" in command) return { error: command.error.replaceAll("setupCommand", "preview") };
  const value = input as Record<string, unknown>;
  if (typeof value.readinessPath !== "string" || !value.readinessPath.startsWith("/") || value.readinessPath.startsWith("//") ||
      value.readinessPath.length > 500 || /[\r\n\\]/.test(value.readinessPath)) return { error: "preview.readinessPath must be a local path beginning with /." };
  if (!Number.isInteger(value.startupTimeoutSeconds) || (value.startupTimeoutSeconds as number) < 5 || (value.startupTimeoutSeconds as number) > 120) {
    return { error: "preview.startupTimeoutSeconds must be between 5 and 120." };
  }
  return { value: { ...command.value, readinessPath: value.readinessPath, startupTimeoutSeconds: value.startupTimeoutSeconds as number } };
}

export interface PreviewSlot { port: number; origin: string }
export function previewSlots(ports = "4318,4319,4320,4321", origins = ""): PreviewSlot[] {
  const slots = ports.split(",").map((port) => Number(port.trim()));
  const publicOrigins = origins ? origins.split(",").map((origin) => origin.trim()) : [];
  if (!slots.length || slots.length > 8 || new Set(slots).size !== slots.length || slots.some((port) => !Number.isInteger(port) || port < 1024 || port > 65535) ||
      (publicOrigins.length && publicOrigins.length !== slots.length)) throw new Error("PREVIEW_PORTS must contain 1–8 unique ports, matched by PREVIEW_ORIGINS when configured.");
  const result = slots.map((port, index) => {
    const url = new URL(publicOrigins[index] ?? `http://127.0.0.1:${port}`);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
        (url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) {
      throw new Error("Preview origins require HTTPS outside loopback and cannot include credentials, paths or query parameters.");
    }
    return { port, origin: url.origin };
  });
  if (new Set(result.map((slot) => slot.origin)).size !== result.length) throw new Error("Each preview slot requires a distinct public origin.");
  return result;
}
