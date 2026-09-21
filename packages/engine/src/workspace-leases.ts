import { resolve } from "node:path";

// The server's durable preview owner recreates leases while recovering a live
// orphan. No filesystem action is hidden in this registry.
const leases = new Map<string, Set<symbol>>();
export function retainWorkspace(path: string): () => void {
  const key = resolve(path); const token = Symbol("preview");
  const owners = leases.get(key) ?? new Set<symbol>(); owners.add(token); leases.set(key, owners);
  return () => { owners.delete(token); if (!owners.size) leases.delete(key); };
}
export function workspaceRetained(path: string): boolean { return (leases.get(resolve(path))?.size ?? 0) > 0; }
