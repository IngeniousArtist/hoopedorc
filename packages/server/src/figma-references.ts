import type { PlanChatMessage, VerifiedFigmaReference } from "@orc/types";

export const MAX_FIGMA_REFERENCES = 12;
export const MAX_FIGMA_URL_LENGTH = 2_048;

export interface FigmaNodeReferenceInput {
  canonicalUrl: string;
  fileKey: string;
  nodeId: string;
}

export interface FigmaReferenceIntake {
  nodes: FigmaNodeReferenceInput[];
  /** Safe canonical file/page links that do not claim fidelity. */
  files: string[];
  invalidNodeCount: number;
  overLimit: boolean;
}

const ALLOWED_HOSTS = new Set(["figma.com", "www.figma.com"]);
const ALLOWED_FILE_KINDS = new Set(["design", "file", "proto"]);
const URL_CANDIDATE = /\bhttps?:\/\/[^\s<>"']+/giu;

function trimUrlPunctuation(value: string): string {
  return value.replace(/[),.;!?\]}]+$/u, "");
}

function safeSegment(value: string): string {
  try {
    return encodeURIComponent(decodeURIComponent(value));
  } catch {
    return encodeURIComponent(value);
  }
}

function normalizeNodeId(value: string): string | null {
  const decoded = value.trim();
  const match = decoded.match(/^(\d+)[:-](\d+)$/u);
  if (!match) return null;
  return `${match[1]}:${match[2]}`;
}

function canonicalFileUrl(
  kind: string,
  fileKey: string,
  slug: string | undefined,
): string {
  const suffix = slug ? `/${safeSegment(slug)}` : "";
  return `https://www.figma.com/${kind}/${safeSegment(fileKey)}${suffix}`;
}

/**
 * Extract only bounded, allowlisted Figma design/file/proto URLs. Unknown
 * hosts and unrelated Figma paths remain ordinary chat text. Query parameters
 * other than node-id are deliberately discarded so secrets and presentation
 * state cannot enter logs or persistence.
 */
export function extractFigmaReferences(
  messages: PlanChatMessage[],
): FigmaReferenceIntake {
  const nodes = new Map<string, FigmaNodeReferenceInput>();
  const files = new Set<string>();
  let invalidNodeCount = 0;
  let overLimit = false;

  for (const message of messages) {
    // Only the operator can nominate a canonical fidelity source. A planner
    // mentioning or inventing a link in its own reply must never promote it.
    if (message.role !== "user") continue;
    for (const match of message.content.matchAll(URL_CANDIDATE)) {
      const raw = trimUrlPunctuation(match[0]);
      if (raw.length > MAX_FIGMA_URL_LENGTH) continue;

      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        continue;
      }
      if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) continue;

      const parts = url.pathname.split("/").filter(Boolean);
      const kind = parts[0]?.toLowerCase();
      const fileKey = parts[1];
      if (!kind || !ALLOWED_FILE_KINDS.has(kind) || !fileKey) continue;
      if (!/^[A-Za-z0-9_-]{3,128}$/u.test(fileKey)) continue;

      const fileUrl = canonicalFileUrl(kind, fileKey, parts[2]);
      const suppliedNodeId = url.searchParams.get("node-id");
      if (!suppliedNodeId) {
        if (files.has(fileUrl)) continue;
        if (nodes.size + files.size >= MAX_FIGMA_REFERENCES) {
          overLimit = true;
          continue;
        }
        files.add(fileUrl);
        continue;
      }

      const nodeId = normalizeNodeId(suppliedNodeId);
      if (!nodeId) {
        invalidNodeCount += 1;
        continue;
      }
      const canonicalUrl = `${fileUrl}?node-id=${nodeId.replace(":", "-")}`;
      const key = `${fileKey}:${nodeId}`;
      if (nodes.has(key)) continue;
      if (nodes.size + files.size >= MAX_FIGMA_REFERENCES) {
        overLimit = true;
        continue;
      }
      nodes.set(key, { canonicalUrl, fileKey, nodeId });
    }
  }

  return {
    nodes: [...nodes.values()],
    files: [...files],
    invalidNodeCount,
    overLimit,
  };
}

/**
 * B42: task descriptions are already the durable handoff for exact design
 * references. Reuse the same user-input parser rather than teaching execution
 * a second, looser interpretation of Figma URLs.
 */
export function extractFigmaReferencesFromText(
  text: string,
): FigmaReferenceIntake {
  return extractFigmaReferences([{ role: "user", content: text }]);
}

function safeMetadataText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\r\n\t]+/gu, " ").trim();
  return normalized ? normalized.slice(0, max) : undefined;
}

function safeDimension(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= 100_000
    ? Math.round(value)
    : undefined;
}

export interface RawVerifiedFigmaReference {
  index?: unknown;
  nodeId?: unknown;
  name?: unknown;
  fileName?: unknown;
  width?: unknown;
  height?: unknown;
}

/**
 * Convert untrusted model/MCP metadata into the exact requested references.
 * Indices and node ids must match one-for-one; extra, missing, reordered, or
 * anonymous entries fail closed instead of becoming false verification.
 */
export function normalizeVerifiedFigmaReferences(
  requested: FigmaNodeReferenceInput[],
  raw: unknown[],
  verifiedModel: VerifiedFigmaReference["verifiedModel"],
  verifiedRunner: VerifiedFigmaReference["verifiedRunner"],
  verifiedAt: string,
): VerifiedFigmaReference[] | null {
  if (raw.length !== requested.length) return null;

  const byIndex = new Map<number, RawVerifiedFigmaReference>();
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const candidate = item as RawVerifiedFigmaReference;
    if (
      typeof candidate.index !== "number" ||
      !Number.isInteger(candidate.index) ||
      byIndex.has(candidate.index)
    ) {
      return null;
    }
    byIndex.set(candidate.index, candidate);
  }

  const normalized: VerifiedFigmaReference[] = [];
  for (let index = 0; index < requested.length; index += 1) {
    const source = requested[index]!;
    const candidate = byIndex.get(index);
    const returnedNodeId =
      typeof candidate?.nodeId === "string"
        ? normalizeNodeId(candidate.nodeId)
        : null;
    const name = safeMetadataText(candidate?.name, 200);
    if (!candidate || returnedNodeId !== source.nodeId || !name) return null;
    normalized.push({
      ...source,
      name,
      fileName: safeMetadataText(candidate.fileName, 200),
      width: safeDimension(candidate.width),
      height: safeDimension(candidate.height),
      verifiedModel,
      verifiedRunner,
      verifiedAt,
    });
  }
  return normalized;
}
