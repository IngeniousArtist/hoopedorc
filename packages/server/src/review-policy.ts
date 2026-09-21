import { createHash } from "node:crypto";
import type { BrowserReviewStep, CaptureReviewRequest, ReviewArtifact, ReviewEvidence, Task, UploadReviewEvidenceRequest, WorkspacePreview, WorkspaceSummary } from "@orc/types";

export class ReviewError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}
export const ARTIFACT_LIMITS = { screenshot: 5 * 1024 * 1024, trace: 20 * 1024 * 1024, text: 256 * 1024 };
export const PROJECT_ARTIFACT_LIMIT = 200 * 1024 * 1024;
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const object = (input: unknown): Record<string, unknown> => {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ReviewError("Review request must be an object.", 400);
  return input as Record<string, unknown>;
};
const text = (input: unknown, name: string, limit = 500): string => {
  if (typeof input !== "string" || !input.trim() || input.length > limit || input.includes("\0")) throw new ReviewError(`${name} must contain 1–${limit} characters.`, 400);
  return input;
};
function identity(input: Record<string, unknown>) {
  const requestId = text(input.requestId, "requestId", 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) throw new ReviewError("requestId must be a UUID v4.", 400);
  return { requestId, taskUpdatedAt: text(input.taskUpdatedAt, "taskUpdatedAt", 50) };
}
export function parseCaptureRequest(input: unknown): CaptureReviewRequest {
  const raw = object(input); const id = identity(raw);
  if (Object.keys(raw).some((key) => !["requestId", "taskUpdatedAt", "previewId", "path", "viewport", "steps"].includes(key))) throw new ReviewError("Browser capture accepts only a reviewed preview, path, viewport and steps; arbitrary URLs/scripts are unavailable.", 400);
  const path = text(raw.path, "path");
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\r\n]/.test(path) || path.startsWith("/__hoop_session")) throw new ReviewError("Choose an application path beginning with /.", 400);
  const viewport = object(raw.viewport);
  const width = viewport.width as number; const height = viewport.height as number;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 240 || width > 2560 || height < 240 || height > 1600) throw new ReviewError("Viewport must be 240–2560px wide and 240–1600px high.", 400);
  if (!Array.isArray(raw.steps) || raw.steps.length > 10) throw new ReviewError("Use at most 10 browser steps.", 400);
  const steps = raw.steps.map((input): BrowserReviewStep => {
    const step = object(input);
    if (step.action !== "clickText" && step.action !== "fillLabel" && step.action !== "expectText") throw new ReviewError("Unsupported browser action.", 400);
    return { action: step.action, target: text(step.target, "Step target", 200),
      ...(step.action === "fillLabel" ? { value: typeof step.value === "string" && step.value.length <= 2000 ? step.value : text(step.value, "Field value", 2000) } : {}) };
  });
  return { ...id, previewId: text(raw.previewId, "previewId", 100), path, viewport: { width, height }, steps };
}
export function validateArtifact(kind: ReviewArtifact["kind"], name: string, bytes: Buffer) {
  if (!Object.hasOwn(ARTIFACT_LIMITS, kind) || !bytes.length || bytes.length > ARTIFACT_LIMITS[kind]) throw new ReviewError("Artifact is empty or exceeds its type's size limit.", 400);
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$/.test(name)) throw new ReviewError("Artifact name must be a plain filename without directories.", 400);
  const mime = kind === "screenshot" ? "image/png" : kind === "trace" ? "application/zip" : "text/plain; charset=utf-8";
  if (kind === "screenshot" && (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.toString("ascii", 12, 16) !== "IHDR" || bytes.readUInt32BE(16) < 1 || bytes.readUInt32BE(20) < 1 || bytes.readUInt32BE(16) > 4096 || bytes.readUInt32BE(20) > 4096)) throw new ReviewError("Screenshot must be a PNG no larger than 4096×4096.", 400);
  if (kind === "trace" && !bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))) throw new ReviewError("Trace must be a ZIP file.", 400);
  if (kind === "text") { try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new ReviewError("Text evidence must be UTF-8.", 400); } }
  return { kind, name, mime, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}
export function parseUploadRequest(input: unknown): { request: UploadReviewEvidenceRequest; bytes: Buffer } {
  const raw = object(input); const id = identity(raw);
  if (raw.kind !== "screenshot" && raw.kind !== "trace" && raw.kind !== "text") throw new ReviewError("Supply a PNG screenshot, ZIP trace or UTF-8 text artifact.", 400);
  const kind = raw.kind; const name = text(raw.name, "Artifact name", 120); const description = text(raw.description, "Evidence description", 2000);
  if (typeof raw.contentBase64 !== "string" || raw.contentBase64.length > Math.ceil(ARTIFACT_LIMITS[kind] / 3) * 4) throw new ReviewError("Artifact exceeds its size limit.", 400);
  const bytes = Buffer.from(raw.contentBase64, "base64");
  if (bytes.toString("base64") !== raw.contentBase64) throw new ReviewError("Artifact must use canonical base64 encoding.", 400);
  validateArtifact(kind, name, bytes);
  return { request: { ...id, kind, name, description, contentBase64: raw.contentBase64 }, bytes };
}
export function evidenceFreshness(evidence: ReviewEvidence, task: Task, workspace: WorkspaceSummary, preview: WorkspacePreview | null): Pick<ReviewEvidence, "freshness" | "freshnessReason"> {
  if (evidence.source === "upload") return { freshness: "unverified", freshnessReason: "Supplied by the operator; its contents were not independently verified against this revision." };
  if (evidence.state === "running") return { freshness: "unverified", freshnessReason: "Capture is still running." };
  if (task.runGeneration !== evidence.runGeneration || task.attempts !== evidence.attempt) return { freshness: "stale", freshnessReason: "The task has moved to another execution generation or attempt." };
  if (workspace.state !== "available") return { freshness: "unavailable", freshnessReason: workspace.reason ?? "The captured workspace is no longer available for comparison." };
  if (workspace.headSha !== evidence.headSha || !preview || preview.id !== evidence.previewId || preview.state !== "ready") return { freshness: "stale", freshnessReason: "The commit or preview environment has changed or stopped." };
  if (preview.headSha !== evidence.headSha) return { freshness: "unverified", freshnessReason: "The preview started at another commit. Rebuild/restart it before treating this as current evidence." };
  if (workspace.dirty || evidence.dirty || !evidence.headSha) return { freshness: "unverified", freshnessReason: "Uncommitted working files cannot be proven to match this capture." };
  return { freshness: "current" };
}
