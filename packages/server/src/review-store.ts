import { createHash, randomUUID } from "node:crypto";
import type { ReviewArtifact, ReviewEvidence } from "@orc/types";
import type { Db } from "./db/index";
import { PROJECT_ARTIFACT_LIMIT, RETENTION_MS, ReviewError, validateArtifact } from "./review-policy";

export const reviewRequestHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
interface EvidenceRow { evidence_json: string; request_hash: string }
interface ArtifactRow { artifact_json: string; payload: Buffer | null }

export class ReviewStore {
  constructor(readonly db: Db) {}
  prune(now = new Date()): void {
    this.db.prepare("UPDATE review_artifacts SET payload = NULL WHERE payload IS NOT NULL AND expires_at <= ?").run(now.toISOString());
  }
  recover(): void {
    const rows = this.db.prepare("SELECT evidence_json FROM review_evidence WHERE state = 'running'").all() as EvidenceRow[];
    for (const row of rows) {
      const value = JSON.parse(row.evidence_json) as ReviewEvidence;
      value.state = "interrupted"; value.endedAt = new Date().toISOString();
      value.detail = "Server restarted during this browser check. Available artifacts were retained; run a new check explicitly.";
      this.update(value);
    }
    this.prune();
  }
  get(id: string): ReviewEvidence | null {
    const row = this.db.prepare("SELECT evidence_json FROM review_evidence WHERE id = ?").get(id) as EvidenceRow | undefined;
    return row ? this.hydrate(row) : null;
  }
  existing(id: string, projectId: string, taskId: string, hash: string): ReviewEvidence | null {
    const row = this.db.prepare("SELECT evidence_json, request_hash FROM review_evidence WHERE id = ?").get(id) as EvidenceRow | undefined;
    if (!row) return null;
    const value = this.hydrate(row);
    if (value.projectId !== projectId || value.taskId !== taskId || row.request_hash !== hash) throw new ReviewError("This request ID already belongs to a different review request.");
    return value;
  }
  list(projectId: string, taskId: string) {
    this.prune();
    const rows = this.db.prepare("SELECT evidence_json FROM review_evidence WHERE project_id = ? AND task_id = ? ORDER BY rowid DESC LIMIT 101").all(projectId, taskId) as EvidenceRow[];
    return { evidence: rows.slice(0, 100).map((row) => this.hydrate(row)), evidenceTruncated: rows.length > 100 };
  }
  private hydrate(row: EvidenceRow): ReviewEvidence {
    const value = JSON.parse(row.evidence_json) as ReviewEvidence;
    value.artifacts = (this.db.prepare("SELECT artifact_json, payload IS NOT NULL AS available FROM review_artifacts WHERE evidence_id = ? ORDER BY rowid").all(value.id) as { artifact_json: string; available: number }[])
      .map((artifact) => ({ ...JSON.parse(artifact.artifact_json) as ReviewArtifact, available: artifact.available === 1 }));
    return value;
  }
  create(value: ReviewEvidence, requestHash: string): void {
    this.db.transaction(() => {
      if (value.state === "running" && this.db.prepare("SELECT id FROM review_evidence WHERE task_id = ? AND state = 'running'").get(value.taskId)) throw new ReviewError("A browser check is already running for this task.");
      this.db.prepare("INSERT INTO review_evidence (id, project_id, task_id, state, request_hash, evidence_json) VALUES (?, ?, ?, ?, ?, ?)")
        .run(value.id, value.projectId, value.taskId, value.state, requestHash, JSON.stringify(value));
    })();
  }
  update(value: ReviewEvidence): void {
    this.db.prepare("UPDATE review_evidence SET state = ?, evidence_json = ? WHERE id = ?").run(value.state, JSON.stringify(value), value.id);
  }
  addArtifact(value: ReviewEvidence, kind: ReviewArtifact["kind"], name: string, bytes: Buffer): ReviewArtifact {
    const parsed = validateArtifact(kind, name, bytes);
    const artifact: ReviewArtifact = { ...parsed, id: randomUUID(), expiresAt: new Date(Date.now() + RETENTION_MS).toISOString(), available: true };
    this.db.transaction(() => {
      this.prune();
      const used = (this.db.prepare("SELECT COALESCE(SUM(length(a.payload)), 0) AS bytes FROM review_artifacts a JOIN review_evidence e ON e.id = a.evidence_id WHERE e.project_id = ?").get(value.projectId) as { bytes: number }).bytes;
      if (used + bytes.length > PROJECT_ARTIFACT_LIMIT) throw new ReviewError("This project has reached the 200 MiB review artifact limit. Existing evidence is preserved until its 30-day expiry.");
      this.db.prepare("INSERT INTO review_artifacts (id, evidence_id, expires_at, artifact_json, payload) VALUES (?, ?, ?, ?, ?)").run(artifact.id, value.id, artifact.expiresAt, JSON.stringify(artifact), bytes);
      this.update({ ...value, artifacts: [...value.artifacts, artifact] });
    })();
    value.artifacts.push(artifact);
    return artifact;
  }
  artifact(projectId: string, taskId: string, id: string): { artifact: ReviewArtifact; bytes: Buffer } {
    this.prune();
    const row = this.db.prepare("SELECT a.artifact_json, a.payload FROM review_artifacts a JOIN review_evidence e ON e.id = a.evidence_id WHERE a.id = ? AND e.project_id = ? AND e.task_id = ?").get(id, projectId, taskId) as ArtifactRow | undefined;
    if (!row) throw new ReviewError("Review artifact not found for this task.", 404);
    if (!row.payload) throw new ReviewError("This artifact's 30-day retention period has expired. Its evidence record is preserved.", 410);
    return { artifact: JSON.parse(row.artifact_json) as ReviewArtifact, bytes: row.payload };
  }
}
