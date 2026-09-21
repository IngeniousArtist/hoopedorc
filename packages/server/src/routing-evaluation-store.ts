import { createHash } from "node:crypto";
import type { EvaluateRoutingRequest, RoutingEvaluationRecord, RoutingEvaluationSummary } from "@orc/types";
import type { Db } from "./db/index";
import { evaluateRouting, parseRoutingBenchmark, RoutingEvaluationError } from "./routing-evaluation-policy";

/** Sorting object keys makes request retries insensitive to JSON key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${JSON.stringify(key)}:${canonical(value)}`).join(",")}}`;
  return JSON.stringify(value);
}
export class RoutingEvaluationStore {
  constructor(private readonly db: Db) {}
  list(): RoutingEvaluationSummary[] {
    return (this.db.prepare("SELECT id, created_at, name, provenance, status FROM routing_evaluations ORDER BY created_at DESC, rowid DESC LIMIT 50").all() as { id: string; created_at: string; name: string; provenance: RoutingEvaluationSummary["provenance"]; status: RoutingEvaluationSummary["status"] }[]).map((row) => ({ id: row.id, createdAt: row.created_at, name: row.name, provenance: row.provenance, status: row.status }));
  }
  get(id: string): RoutingEvaluationRecord {
    const row = this.db.prepare("SELECT json FROM routing_evaluations WHERE id = ?").get(id) as { json: string } | undefined;
    if (!row) throw new RoutingEvaluationError("Evaluation not found.", 404);
    return JSON.parse(row.json) as RoutingEvaluationRecord;
  }
  evaluate(value: unknown): RoutingEvaluationRecord {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["requestId", "dataset"].includes(key))) throw new RoutingEvaluationError("Use a requestId and dataset.");
    const input = value as EvaluateRoutingRequest;
    if (typeof input.requestId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input.requestId)) throw new RoutingEvaluationError("Use a UUID v4 requestId.");
    const dataset = parseRoutingBenchmark(input.dataset);
    const datasetHash = createHash("sha256").update(canonical(dataset)).digest("hex");
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT dataset_hash FROM routing_evaluations WHERE id = ?").get(input.requestId) as { dataset_hash: string } | undefined;
      if (row) { if (row.dataset_hash !== datasetHash) throw new RoutingEvaluationError("This request ID belongs to different input. Keep the draft and start a new evaluation.", 409); return this.get(input.requestId); }
      if ((this.db.prepare("SELECT COUNT(*) AS count FROM routing_evaluations").get() as { count: number }).count >= 200) throw new RoutingEvaluationError("The 200-report storage limit has been reached. Existing evidence is preserved; export reports before operator maintenance.", 409);
      const record: RoutingEvaluationRecord = { id: input.requestId, datasetHash, dataset, createdAt: new Date().toISOString(), report: evaluateRouting(dataset) };
      this.db.prepare("INSERT INTO routing_evaluations (id, dataset_hash, created_at, name, provenance, status, json) VALUES (?, ?, ?, ?, ?, ?, ?)").run(record.id, datasetHash, record.createdAt, dataset.name, dataset.provenance, record.report.status, JSON.stringify(record));
      return record;
    })();
  }
}
