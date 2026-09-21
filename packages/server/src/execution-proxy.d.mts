import type { Socket } from "node:net";
export const PROVIDER_HOSTS: Set<string>;
export function publicAddress(address: string): boolean;
export function allowedTarget(authority: unknown): string | null;
export function startProxy(socketPath: string, dependencies?: {
  lookup?: (host: string, options: { all: true; family: 4 }) => Promise<{ address: string; family: number }[]>;
  connect?: (options: { host: string; port: number }) => Socket;
}): Promise<() => Promise<void>>;
