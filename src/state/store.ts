import type { Escalation } from "../schemas/common.js";
import type { JDAnalysis, JobPosting } from "../schemas/job.js";
import type { SourceRecord } from "../schemas/source.js";
import type { TaskGraph } from "../schemas/taskgraph.js";
import type { RunStatus, TraceEntry } from "../schemas/trace.js";

export interface RunRecord {
  id: string;
  brief: string;
  status: RunStatus;
  budget: TaskGraph["budget"];
  plan: TaskGraph | null;
  blackboard: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface NodeResultRecord {
  idempotency_key: string;
  run_id: string;
  node_id: string;
  kind: string;
  status: string;
  result: unknown;
  created_at: string;
}

export interface VectorHit {
  owner_id: string;
  label: string;
  score: number;
}

/**
 * L1 persistence. Everything above this line is storage-agnostic — the SQLite
 * driver ships by default so the system runs with no infrastructure, and a
 * Postgres/pgvector driver implements the same surface for deployment.
 */
export interface Store {
  /* runs & checkpoints */
  createRun(run: RunRecord): void;
  getRun(id: string): RunRecord | null;
  saveRun(run: RunRecord): void;
  listRuns(limit?: number): RunRecord[];

  /* idempotency */
  getNodeResult(runId: string, idempotencyKey: string): NodeResultRecord | null;
  putNodeResult(rec: NodeResultRecord): void;
  listNodeResults(runId: string): NodeResultRecord[];

  /* observability */
  appendTrace(entry: TraceEntry): void;
  listTrace(runId: string): TraceEntry[];

  /* registry */
  upsertSource(rec: SourceRecord): void;
  getSource(id: string): SourceRecord | null;
  listSources(filter?: { status?: SourceRecord["status"]; enabled?: boolean; limit?: number }): SourceRecord[];
  /** Include or exclude a source from future searches. False if unknown id. */
  setSourceEnabled(id: string, enabled: boolean): boolean;
  findSourceByCompany(company: string): SourceRecord | null;
  recordSourceHealth(id: string, ok: boolean, latencyMs: number, error?: string): void;
  /** Removes a registry entry, e.g. one a slug probe resolved to the wrong company. */
  forgetSource(company: string): boolean;

  /* jobs */
  upsertJob(job: JobPosting): void;
  getJob(id: string): JobPosting | null;
  getJobsByDedupeKey(key: string): JobPosting[];

  /* jd analysis cache */
  getAnalysis(jobId: string): JDAnalysis | null;
  putAnalysis(a: JDAnalysis): void;

  /* embeddings */
  putEmbedding(ownerKind: string, ownerId: string, label: string, vec: Float32Array): void;
  getEmbedding(ownerKind: string, ownerId: string): Float32Array | null;
  searchEmbeddings(ownerKind: string, query: Float32Array, k: number): VectorHit[];

  /* synonym graph */
  putTitleSynonym(term: string, canonical: string, weight: number, confirmed: boolean): void;
  titleSynonyms(term: string): Array<{ canonical: string; weight: number; confirmed: boolean }>;
  putSkillSynonym(term: string, canonical: string, weight: number): void;
  skillSynonyms(term: string): Array<{ canonical: string; weight: number }>;
  allSkillSynonyms(): Array<{ term: string; canonical: string; weight: number }>;

  /* escalations */
  putEscalation(runId: string, e: Escalation): void;
  listEscalations(runId: string, onlyOpen?: boolean): Array<Escalation & { answer: string | null }>;
  answerEscalation(id: string, answer: string): void;

  /* tracker & feedback */
  upsertApplication(rec: {
    id: string;
    run_id: string;
    job_id: string;
    state: string;
    apply_url: string | null;
    jd_snapshot: string | null;
    resume_sha: string | null;
    resume_path: string | null;
  }): void;
  recordEditFeedback(rec: { id: string; job_id: string; edit_kind: string; accepted: boolean; note: string | null }): void;
  editFeedbackStats(): Array<{ edit_kind: string; accepted: number; rejected: number }>;

  close(): void;
}
