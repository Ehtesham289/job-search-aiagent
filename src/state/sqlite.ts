import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { Escalation } from "../schemas/common.js";
import { JDAnalysis, JobPosting } from "../schemas/job.js";
import { SourceRecord } from "../schemas/source.js";
import type { TraceEntry } from "../schemas/trace.js";
import type { NodeResultRecord, RunRecord, Store, VectorHit } from "./store.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export class SqliteStore implements Store {
  private db: Database.Database;
  private traceSeq = new Map<string, number>();

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(fs.readFileSync(path.join(here, "schema.sql"), "utf8"));
    this.addMissingColumns();
  }

  /**
   * `CREATE TABLE IF NOT EXISTS` is a no-op against a database that already
   * has the table, so a new column in schema.sql never reaches an existing
   * registry. This adds any that are missing.
   *
   * Every entry must carry a DEFAULT that reproduces the old behaviour, since
   * that is what existing rows will get. Additive only: nothing here drops or
   * rewrites a column, so a store written by a newer build stays readable by
   * an older one.
   */
  private addMissingColumns(): void {
    const additions: Array<{ table: string; column: string; ddl: string }> = [
      { table: "sources", column: "enabled", ddl: "INTEGER NOT NULL DEFAULT 1" },
    ];
    for (const a of additions) {
      const cols = this.db.prepare(`PRAGMA table_info(${a.table})`).all() as Array<{ name: string }>;
      if (cols.length === 0 || cols.some((c) => c.name === a.column)) continue;
      this.db.exec(`ALTER TABLE ${a.table} ADD COLUMN ${a.column} ${a.ddl}`);
    }
  }

  /* ── runs ─────────────────────────────────────────────────────────────── */

  createRun(run: RunRecord): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, brief, status, budget, plan, blackboard, created_at, updated_at)
         VALUES (@id, @brief, @status, @budget, @plan, @blackboard, @created_at, @updated_at)`,
      )
      .run(this.runRow(run));
  }

  getRun(id: string): RunRecord | null {
    const row = this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as RawRun | undefined;
    return row ? this.parseRun(row) : null;
  }

  saveRun(run: RunRecord): void {
    this.db
      .prepare(
        `UPDATE runs SET brief=@brief, status=@status, budget=@budget, plan=@plan,
         blackboard=@blackboard, updated_at=@updated_at WHERE id=@id`,
      )
      .run(this.runRow({ ...run, updated_at: new Date().toISOString() }));
  }

  listRuns(limit = 20): RunRecord[] {
    const rows = this.db.prepare(`SELECT * FROM runs ORDER BY created_at DESC LIMIT ?`).all(limit) as RawRun[];
    return rows.map((r) => this.parseRun(r));
  }

  private runRow(run: RunRecord) {
    return {
      id: run.id,
      brief: run.brief,
      status: run.status,
      budget: JSON.stringify(run.budget),
      plan: run.plan ? JSON.stringify(run.plan) : null,
      blackboard: JSON.stringify(run.blackboard),
      created_at: run.created_at,
      updated_at: run.updated_at,
    };
  }

  private parseRun(r: RawRun): RunRecord {
    return {
      id: r.id,
      brief: r.brief,
      status: r.status as RunRecord["status"],
      budget: JSON.parse(r.budget),
      plan: r.plan ? JSON.parse(r.plan) : null,
      blackboard: JSON.parse(r.blackboard),
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  }

  /* ── idempotency ──────────────────────────────────────────────────────── */

  getNodeResult(runId: string, key: string): NodeResultRecord | null {
    const r = this.db
      .prepare(`SELECT * FROM node_results WHERE run_id = ? AND idempotency_key = ?`)
      .get(runId, key) as RawNodeResult | undefined;
    return r ? { ...r, result: JSON.parse(r.result) } : null;
  }

  putNodeResult(rec: NodeResultRecord): void {
    this.db
      .prepare(
        `INSERT INTO node_results (run_id, idempotency_key, node_id, kind, status, result, created_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(run_id, idempotency_key) DO UPDATE SET
           status=excluded.status, result=excluded.result, created_at=excluded.created_at`,
      )
      .run(rec.run_id, rec.idempotency_key, rec.node_id, rec.kind, rec.status, JSON.stringify(rec.result), rec.created_at);
  }

  listNodeResults(runId: string): NodeResultRecord[] {
    const rows = this.db.prepare(`SELECT * FROM node_results WHERE run_id = ?`).all(runId) as RawNodeResult[];
    return rows.map((r) => ({ ...r, result: JSON.parse(r.result) }));
  }

  /* ── traces ───────────────────────────────────────────────────────────── */

  appendTrace(e: TraceEntry): void {
    const seq = (this.traceSeq.get(e.run_id) ?? this.maxSeq(e.run_id)) + 1;
    this.traceSeq.set(e.run_id, seq);
    this.db
      .prepare(
        `INSERT INTO traces (run_id, seq, node_id, kind, agent, model, status, input_hash, output_summary,
          usage, duration_ms, attempts, retries, validation_failures, error, started_at, finished_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        e.run_id, seq, e.node_id, e.kind, e.agent, e.model, e.status, e.input_hash, e.output_summary,
        JSON.stringify(e.usage), Math.round(e.duration_ms), e.attempts, e.retries, e.validation_failures,
        e.error, e.started_at, e.finished_at,
      );
  }

  private maxSeq(runId: string): number {
    const r = this.db.prepare(`SELECT MAX(seq) AS m FROM traces WHERE run_id = ?`).get(runId) as { m: number | null };
    return r.m ?? 0;
  }

  listTrace(runId: string): TraceEntry[] {
    const rows = this.db.prepare(`SELECT * FROM traces WHERE run_id = ? ORDER BY seq`).all(runId) as RawTrace[];
    return rows.map((r) => ({
      run_id: r.run_id,
      node_id: r.node_id,
      kind: r.kind,
      agent: r.agent,
      model: r.model,
      status: r.status as TraceEntry["status"],
      input_hash: r.input_hash,
      output_summary: r.output_summary,
      usage: JSON.parse(r.usage),
      duration_ms: r.duration_ms,
      attempts: r.attempts,
      retries: r.retries,
      validation_failures: r.validation_failures,
      error: r.error,
      started_at: r.started_at,
      finished_at: r.finished_at,
    }));
  }

  /* ── registry ─────────────────────────────────────────────────────────── */

  upsertSource(rec: SourceRecord): void {
    // The same board can arrive under two different ids.
    //
    // `discoverByRole` derives the id from the ATS slug it found
    // (`definitivehcindia`); `discoverOne` derives it from the company name the
    // user typed (`Definitive Healthcare`). Both then store the name the board
    // reports, so the row is identical under `idx_sources_company_ats` while
    // the primary keys differ — and `ON CONFLICT(id)` does not see it. The
    // insert threw, source discovery failed, and the registry silently stopped
    // growing exactly when a search most needed new employers.
    //
    // Resolved by identity rather than by adding a second conflict clause: a
    // board is *the same board*, so the existing row's id wins and the record
    // is updated in place instead of duplicated under a new key.
    const twin = this.db
      .prepare(
        `SELECT id FROM sources WHERE company = ? AND ats_type = ? AND IFNULL(ats_slug,'') = IFNULL(?,'') AND id <> ?`,
      )
      .get(rec.company, rec.ats_type, rec.ats_slug, rec.id) as { id: string } | undefined;
    const id = twin?.id ?? rec.id;

    this.db
      .prepare(
        `INSERT INTO sources (id, company, domain, career_url, ats_type, ats_slug, confidence, status, reason, verified_at, health, updated_at, enabled)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           company=excluded.company, domain=excluded.domain, career_url=excluded.career_url,
           ats_type=excluded.ats_type, ats_slug=excluded.ats_slug, confidence=excluded.confidence,
           status=excluded.status, reason=excluded.reason, verified_at=excluded.verified_at,
           health=excluded.health, updated_at=excluded.updated_at,
           -- Deliberately NOT excluded.enabled. Re-discovering or
           -- re-verifying a company must not switch it back on behind the
           -- user's back; only setSourceEnabled changes this column.
           enabled=sources.enabled`,
      )
      .run(
        id, rec.company, rec.domain, rec.career_url, rec.ats_type, rec.ats_slug, rec.confidence,
        rec.status, rec.reason, rec.verified_at, JSON.stringify(rec.health), new Date().toISOString(),
        rec.enabled ? 1 : 0,
      );
  }

  /** The only path that changes `enabled`. Returns false if there is no such source. */
  setSourceEnabled(id: string, enabled: boolean): boolean {
    const info = this.db
      .prepare(`UPDATE sources SET enabled = ?, updated_at = ? WHERE id = ?`)
      .run(enabled ? 1 : 0, new Date().toISOString(), id);
    return info.changes > 0;
  }

  getSource(id: string): SourceRecord | null {
    const r = this.db.prepare(`SELECT * FROM sources WHERE id = ?`).get(id) as RawSource | undefined;
    return r ? parseSource(r) : null;
  }

  listSources(filter: { status?: SourceRecord["status"]; enabled?: boolean; limit?: number } = {}): SourceRecord[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (filter.status) {
      where.push("status = ?");
      args.push(filter.status);
    }
    if (filter.enabled !== undefined) {
      where.push("enabled = ?");
      args.push(filter.enabled ? 1 : 0);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    args.push(filter.limit ?? 500);
    const rows = this.db
      .prepare(`SELECT * FROM sources ${clause} ORDER BY confidence DESC LIMIT ?`)
      .all(...args) as RawSource[];
    return rows.map(parseSource);
  }

  findSourceByCompany(company: string): SourceRecord | null {
    const r = this.db
      .prepare(`SELECT * FROM sources WHERE lower(company) = lower(?) ORDER BY confidence DESC LIMIT 1`)
      .get(company) as RawSource | undefined;
    return r ? parseSource(r) : null;
  }

  forgetSource(company: string): boolean {
    const info = this.db.prepare(`DELETE FROM sources WHERE lower(company) = lower(?)`).run(company);
    return info.changes > 0;
  }

  recordSourceHealth(id: string, ok: boolean, latencyMs: number, error?: string): void {
    const src = this.getSource(id);
    if (!src) return;
    const h = src.health;
    const attempts = h.attempts + 1;
    src.health = {
      attempts,
      failures: h.failures + (ok ? 0 : 1),
      last_ok_at: ok ? new Date().toISOString() : h.last_ok_at,
      last_error: ok ? h.last_error : (error ?? "unknown"),
      // Running mean, so one slow fetch does not rewrite the source's history.
      avg_latency_ms: h.avg_latency_ms + (latencyMs - h.avg_latency_ms) / attempts,
    };
    // Three strikes with nothing but failures and the source stops being tried.
    if (!ok && src.health.failures >= 3 && src.health.last_ok_at === null) {
      src.status = "dead";
      src.reason = error ?? "repeated fetch failures";
    }
    this.upsertSource(src);
  }

  /* ── jobs ─────────────────────────────────────────────────────────────── */

  upsertJob(job: JobPosting): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO jobs (id, dedupe_key, source_id, company, title, posting, first_seen, last_seen)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET posting=excluded.posting, last_seen=excluded.last_seen`,
      )
      .run(job.id, job.dedupe_key, job.source_id, job.company, job.title, JSON.stringify(job), now, now);
  }

  getJob(id: string): JobPosting | null {
    const r = this.db.prepare(`SELECT posting FROM jobs WHERE id = ?`).get(id) as { posting: string } | undefined;
    return r ? (JSON.parse(r.posting) as JobPosting) : null;
  }

  getJobsByDedupeKey(key: string): JobPosting[] {
    const rows = this.db.prepare(`SELECT posting FROM jobs WHERE dedupe_key = ?`).all(key) as { posting: string }[];
    return rows.map((r) => JSON.parse(r.posting) as JobPosting);
  }

  /* ── jd analysis cache ────────────────────────────────────────────────── */

  getAnalysis(jobId: string): JDAnalysis | null {
    const r = this.db.prepare(`SELECT analysis FROM jd_analysis WHERE job_id = ?`).get(jobId) as
      | { analysis: string }
      | undefined;
    if (!r) return null;
    const parsed = JDAnalysis.safeParse(JSON.parse(r.analysis));
    // A cached record that no longer fits the contract is treated as a miss,
    // not as a crash — schema evolution must not brick the cache.
    return parsed.success ? parsed.data : null;
  }

  putAnalysis(a: JDAnalysis): void {
    this.db
      .prepare(
        `INSERT INTO jd_analysis (job_id, analysis, model, created_at) VALUES (?,?,?,?)
         ON CONFLICT(job_id) DO UPDATE SET analysis=excluded.analysis, model=excluded.model`,
      )
      .run(a.job_id, JSON.stringify(a), a.model, new Date().toISOString());
  }

  /* ── embeddings ───────────────────────────────────────────────────────── */

  putEmbedding(ownerKind: string, ownerId: string, label: string, vec: Float32Array): void {
    this.db
      .prepare(
        `INSERT INTO embeddings (owner_kind, owner_id, dim, vec, label) VALUES (?,?,?,?,?)
         ON CONFLICT(owner_kind, owner_id) DO UPDATE SET dim=excluded.dim, vec=excluded.vec, label=excluded.label`,
      )
      .run(ownerKind, ownerId, vec.length, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength), label);
  }

  getEmbedding(ownerKind: string, ownerId: string): Float32Array | null {
    const r = this.db
      .prepare(`SELECT vec FROM embeddings WHERE owner_kind = ? AND owner_id = ?`)
      .get(ownerKind, ownerId) as { vec: Buffer } | undefined;
    return r ? toFloat32(r.vec) : null;
  }

  /**
   * Brute-force cosine. At registry scale (thousands of vectors) this is
   * microseconds and exact; the Postgres driver swaps in a pgvector index
   * behind the same signature.
   */
  searchEmbeddings(ownerKind: string, query: Float32Array, k: number): VectorHit[] {
    const rows = this.db
      .prepare(`SELECT owner_id, label, vec FROM embeddings WHERE owner_kind = ?`)
      .all(ownerKind) as Array<{ owner_id: string; label: string; vec: Buffer }>;
    const hits = rows.map((r) => ({ owner_id: r.owner_id, label: r.label, score: cosine(query, toFloat32(r.vec)) }));
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }

  /* ── synonym graph ────────────────────────────────────────────────────── */

  putTitleSynonym(term: string, canonical: string, weight: number, confirmed: boolean): void {
    this.db
      .prepare(
        `INSERT INTO title_synonyms (term, canonical, weight, confirmed, updated_at) VALUES (?,?,?,?,?)
         ON CONFLICT(term, canonical) DO UPDATE SET
           weight=MAX(title_synonyms.weight, excluded.weight),
           confirmed=MAX(title_synonyms.confirmed, excluded.confirmed),
           updated_at=excluded.updated_at`,
      )
      .run(norm(term), norm(canonical), weight, confirmed ? 1 : 0, new Date().toISOString());
  }

  titleSynonyms(term: string) {
    const rows = this.db
      .prepare(`SELECT canonical, weight, confirmed FROM title_synonyms WHERE term = ? ORDER BY weight DESC`)
      .all(norm(term)) as Array<{ canonical: string; weight: number; confirmed: number }>;
    return rows.map((r) => ({ canonical: r.canonical, weight: r.weight, confirmed: r.confirmed === 1 }));
  }

  putSkillSynonym(term: string, canonical: string, weight: number): void {
    this.db
      .prepare(
        `INSERT INTO skill_synonyms (term, canonical, weight, updated_at) VALUES (?,?,?,?)
         ON CONFLICT(term, canonical) DO UPDATE SET weight=MAX(skill_synonyms.weight, excluded.weight), updated_at=excluded.updated_at`,
      )
      .run(norm(term), norm(canonical), weight, new Date().toISOString());
  }

  skillSynonyms(term: string) {
    return this.db
      .prepare(`SELECT canonical, weight FROM skill_synonyms WHERE term = ? ORDER BY weight DESC`)
      .all(norm(term)) as Array<{ canonical: string; weight: number }>;
  }

  allSkillSynonyms() {
    return this.db.prepare(`SELECT term, canonical, weight FROM skill_synonyms`).all() as Array<{
      term: string;
      canonical: string;
      weight: number;
    }>;
  }

  /* ── escalations ──────────────────────────────────────────────────────── */

  putEscalation(runId: string, e: Escalation): void {
    this.db
      .prepare(
        `INSERT INTO escalations (id, run_id, payload, created_at) VALUES (?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`,
      )
      .run(e.id, runId, JSON.stringify(e), new Date().toISOString());
  }

  listEscalations(runId: string, onlyOpen = false) {
    const sql = onlyOpen
      ? `SELECT payload, answer FROM escalations WHERE run_id = ? AND answer IS NULL ORDER BY created_at`
      : `SELECT payload, answer FROM escalations WHERE run_id = ? ORDER BY created_at`;
    const rows = this.db.prepare(sql).all(runId) as Array<{ payload: string; answer: string | null }>;
    return rows.map((r) => ({ ...(JSON.parse(r.payload) as Escalation), answer: r.answer }));
  }

  answerEscalation(id: string, answer: string): void {
    this.db
      .prepare(`UPDATE escalations SET answer = ?, answered_at = ? WHERE id = ?`)
      .run(answer, new Date().toISOString(), id);
  }

  /* ── tracker & feedback ───────────────────────────────────────────────── */

  upsertApplication(rec: {
    id: string; run_id: string; job_id: string; state: string;
    apply_url: string | null; jd_snapshot: string | null; resume_sha: string | null; resume_path: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO applications (id, run_id, job_id, state, apply_url, jd_snapshot, resume_sha, resume_path, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET state=excluded.state, apply_url=excluded.apply_url,
           jd_snapshot=excluded.jd_snapshot, resume_sha=excluded.resume_sha,
           resume_path=excluded.resume_path, updated_at=excluded.updated_at`,
      )
      .run(rec.id, rec.run_id, rec.job_id, rec.state, rec.apply_url, rec.jd_snapshot, rec.resume_sha, rec.resume_path, new Date().toISOString());
  }

  recordEditFeedback(rec: { id: string; job_id: string; edit_kind: string; accepted: boolean; note: string | null }): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO edit_feedback (id, job_id, edit_kind, accepted, note, created_at) VALUES (?,?,?,?,?,?)`)
      .run(rec.id, rec.job_id, rec.edit_kind, rec.accepted ? 1 : 0, rec.note, new Date().toISOString());
  }

  editFeedbackStats() {
    return this.db
      .prepare(
        `SELECT edit_kind,
                SUM(CASE WHEN accepted = 1 THEN 1 ELSE 0 END) AS accepted,
                SUM(CASE WHEN accepted = 0 THEN 1 ELSE 0 END) AS rejected
         FROM edit_feedback GROUP BY edit_kind`,
      )
      .all() as Array<{ edit_kind: string; accepted: number; rejected: number }>;
  }

  close(): void {
    this.db.close();
  }
}

/* ── helpers ────────────────────────────────────────────────────────────── */

function norm(s: string): string {
  return s.trim().toLowerCase();
}

function toFloat32(buf: Buffer): Float32Array {
  const copy = new ArrayBuffer(buf.byteLength);
  new Uint8Array(copy).set(buf);
  return new Float32Array(copy);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]!, y = b[i]!;
    dot += x * y; na += x * x; nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function parseSource(r: RawSource): SourceRecord {
  return SourceRecord.parse({
    id: r.id,
    company: r.company,
    domain: r.domain,
    career_url: r.career_url,
    ats_type: r.ats_type,
    ats_slug: r.ats_slug,
    confidence: r.confidence,
    status: r.status,
    reason: r.reason,
    verified_at: r.verified_at,
    // Older rows predate the column; absent means on, which is how the
    // registry behaved before it existed.
    enabled: r.enabled === undefined ? true : r.enabled === 1,
    health: JSON.parse(r.health),
  });
}

interface RawRun { id: string; brief: string; status: string; budget: string; plan: string | null; blackboard: string; created_at: string; updated_at: string }
interface RawNodeResult { idempotency_key: string; run_id: string; node_id: string; kind: string; status: string; result: string; created_at: string }
interface RawSource { id: string; company: string; domain: string | null; career_url: string | null; ats_type: string; ats_slug: string | null; confidence: number; status: string; reason: string | null; verified_at: string | null; health: string; enabled?: number }
interface RawTrace { run_id: string; node_id: string; kind: string; agent: string; model: string | null; status: string; input_hash: string; output_summary: string; usage: string; duration_ms: number; attempts: number; retries: number; validation_failures: number; error: string | null; started_at: string; finished_at: string }
