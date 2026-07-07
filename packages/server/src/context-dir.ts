import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project } from "@orc/types";

/**
 * Root of a project's "context" folder — F27's uploaded attachments and
 * F28's archived plan-chat session files both live under here, inside the
 * project's own clone. The mock-seed project's `localPath` is `"."` (this
 * server's own cwd), so writes are rooted in a scratch tmp dir instead in
 * `ENV.mock`, keyed by project id — otherwise every `npm run mock` session
 * would dirty this actual repo.
 */
export function contextDir(project: Project, mock: boolean): string {
  if (mock) {
    return join(tmpdir(), "hoopedorc-mock-context", project.id);
  }
  return join(project.localPath, "context");
}
