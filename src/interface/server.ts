#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../config/env.js";
import { SqliteStore } from "../state/sqlite.js";
import { JobSearchAgent } from "../orchestrator/run.js";
import { extractFromBuffer, extractText } from "../tools/parse/document.js";
import { parseResumeHeuristically } from "../tools/parse/resumeHeuristic.js";
import { installFixtures, offlineProvider } from "./fixtures.js";
import type { ProgressEvent } from "../orchestrator/events.js";
import type { Blackboard } from "../state/blackboard.js";
import { ProfileSummary, StructuredResume } from "../schemas/profile.js";

/**
 * L4, over HTTP. The terminal interface and this one consume the same
 * `ProgressEvent` stream — the web client is another sink, not a second
 * implementation of the interface layer.
 *
 * Deliberately dependency-free: node:http plus server-sent events. A local
 * operator console does not need a framework, and adding one would make the
 * app harder to run than the system it drives.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(here, "web");

interface RunChannel {
  events: ProgressEvent[];
  subscribers: Set<http.ServerResponse>;
  done: boolean;
  kind: "search" | "tailor";
  parent: string | null;
}

/**
 * Buffers each run's events so a client that connects late — or reloads
 * mid-run — still sees everything from the beginning, then follows live.
 */
class RunHub {
  private channels = new Map<string, RunChannel>();

  open(runId: string, kind: RunChannel["kind"], parent: string | null = null): RunChannel {
    const existing = this.channels.get(runId);
    if (existing) return existing;
    const ch: RunChannel = { events: [], subscribers: new Set(), done: false, kind, parent };
    this.channels.set(runId, ch);
    return ch;
  }

  get(runId: string): RunChannel | undefined {
    return this.channels.get(runId);
  }

  emit(runId: string, ev: ProgressEvent): void {
    const ch = this.open(runId, "search");
    ch.events.push(ev);
    const frame = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of ch.subscribers) res.write(frame);
  }

  close(runId: string): void {
    const ch = this.channels.get(runId);
    if (!ch) return;
    ch.done = true;
    for (const res of ch.subscribers) {
      res.write(`event: end\ndata: {}\n\n`);
      res.end();
    }
    ch.subscribers.clear();
  }

  subscribe(runId: string, res: http.ServerResponse): void {
    const ch = this.open(runId, "search");
    for (const ev of ch.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    if (ch.done) {
      res.write(`event: end\ndata: {}\n\n`);
      res.end();
      return;
    }
    ch.subscribers.add(res);
    res.on("close", () => ch.subscribers.delete(res));
  }
}

export interface ServerOptions {
  /** Use the local sample postings instead of real job boards. */
  fixtures: boolean;
  /** Heuristics instead of a model. Implied by `fixtures`, and by having no key. */
  offline?: boolean;
}

export function createServer(opts: ServerOptions) {
  const offline = opts.fixtures || opts.offline || !env.hasApiKey;
  const store = new SqliteStore(env.dbPath);
  if (opts.fixtures) installFixtures(store);
  const hub = new RunHub();

  /** One system per run so each gets its own event sink; the store is shared. */
  const systemFor = (runId: string) =>
    new JobSearchAgent({
      store,
      emit: (ev) => hub.emit(runId, ev),
      ...(offline ? { provider: offlineProvider() } : {}),
    });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      await route(url, req, res);
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
  });

  async function route(url: URL, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const { pathname } = url;

    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      return serveStatic(res, "index.html", "text/html; charset=utf-8");
    }
    if (req.method === "GET" && pathname === "/app.css") return serveStatic(res, "app.css", "text/css");
    if (req.method === "GET" && pathname === "/app.js") {
      return serveStatic(res, "app.js", "text/javascript; charset=utf-8");
    }

    if (req.method === "GET" && pathname === "/api/config") {
      return json(res, 200, {
        fixtures: opts.fixtures,
        offline,
        hasApiKey: env.hasApiKey,
        db: env.dbPath,
        sources: store.listSources({ status: "verified" }).length,
      });
    }

    /* ── résumé upload ────────────────────────────────────────────────── */
    if (req.method === "POST" && pathname === "/api/resume") {
      const name = url.searchParams.get("name") ?? "resume.txt";
      const ext = path.extname(name).toLowerCase();
      if (![".pdf", ".docx", ".txt", ".md", ".json", ""].includes(ext)) {
        return json(res, 400, { error: `unsupported file type '${ext}'. Use PDF, DOCX, TXT or MD.` });
      }
      const bytes = await readBody(req, 12_000_000);
      let extracted: { text: string; kind: string };
      try {
        extracted = await extractFromBuffer(bytes, name);
      } catch (err) {
        return json(res, 400, { error: `could not read ${name}: ${(err as Error).message}` });
      }
      if (extracted.text.trim().length < 100) {
        // A scanned PDF is the usual cause; the parse agent would confabulate
        // from nothing, so refuse here rather than downstream.
        return json(res, 422, {
          error:
            `Only ${extracted.text.trim().length} characters came out of ${name}. ` +
            `If it is a scanned image, export a text-based PDF or paste the text instead.`,
        });
      }
      // Who this is and how long they have worked, so the console can propose
      // a brief.
      //
      // A model reads it whenever one is available. The heuristic reads a
      // résumé by its *shape*, and shapes vary: on a CV laid out as
      // `Title······Jan 2026 – Present` over `Deloitte USI — Bangalore`, it
      // took the company line as the job title and found one role out of four,
      // proposing "Deloitte USI, 0.6 years" for five years of experience. The
      // brief drives the entire search, so getting it wrong is not cosmetic.
      //
      // The parse is returned to the client and sent back with the search, so
      // this is the same single parse the run would have paid for anyway.
      let role = "";
      let years = 0;
      let parsed: { resume: unknown; profile: unknown } | null = null;
      let readBy = "heuristic";

      if (!offline) {
        try {
          const r = await systemFor("resume").readResume(extracted.text);
          role = r.profile.canonical_titles[0] ?? "";
          years = r.profile.total_years;
          parsed = { resume: r.resume, profile: r.profile };
          readBy = "model";
        } catch {
          // Fall through to the heuristic: a failed read must not block an
          // upload the user can still describe themselves.
        }
      }
      if (!parsed) {
        const sketch = parseResumeHeuristically(extracted.text);
        role = sketch.experience[0]?.title ?? "";
        years = sketch.experience.length ? estimateYears(sketch.experience) : 0;
      }

      return json(res, 200, {
        name,
        kind: extracted.kind,
        chars: extracted.text.length,
        text: extracted.text,
        suggested_role: role,
        suggested_brief: role
          ? `${role}${years ? `, ${years} year${years === 1 ? "" : "s"} of experience` : ""}`
          : "",
        read_by: readBy,
        parsed,
      });
    }

    /* ── grow the registry from the console ───────────────────────────── */
    if (req.method === "POST" && pathname === "/api/discover") {
      const body = await readJson<{ companies?: string }>(req);
      const targets = (body.companies ?? "").split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
      if (targets.length === 0) return json(res, 400, { error: "companies is required" });

      // Slug probes and one verifying fetch — no model involved, so this works
      // with no API key.
      const system = systemFor("registry");
      const result = await system.discover(targets.slice(0, 12));
      return json(res, 200, {
        ...result,
        sources: store.listSources({ status: "verified" }).length,
      });
    }

    /* ── registry: what the live search actually searches ─────────────── */
    if (req.method === "GET" && pathname === "/api/sources") {
      const sources = store.listSources({ limit: 1000 }).map((s) => ({
        id: s.id,
        company: s.company,
        ats_type: s.ats_type,
        status: s.status,
        enabled: s.enabled,
        career_url: s.career_url,
        reason: s.reason,
        attempts: s.health.attempts,
        failures: s.health.failures,
        last_error: s.health.last_error,
      }));
      return json(res, 200, { sources });
    }

    /* ── include or exclude companies from future searches ────────────── */
    if (req.method === "POST" && pathname === "/api/sources/enabled") {
      const body = await readJson<{ ids?: string[]; enabled?: boolean }>(req);
      if (!Array.isArray(body.ids) || typeof body.enabled !== "boolean") {
        return json(res, 400, { error: "ids (array) and enabled (boolean) are required" });
      }
      // Takes a list rather than one id so "disable all" is a single atomic
      // request instead of eighty racing ones.
      let changed = 0;
      for (const id of body.ids) if (store.setSourceEnabled(id, body.enabled)) changed++;
      const enabled = store.listSources({ status: "verified", enabled: true, limit: 1000 }).length;
      return json(res, 200, { changed, enabled });
    }

    /* ── start a search ───────────────────────────────────────────────── */
    if (req.method === "POST" && pathname === "/api/search") {
      const body = await readJson<{
        brief?: string;
        resumeText?: string;
        resumePath?: string;
        budget?: number;
        usePlanner?: boolean;
        discover?: string;
        locations?: string;
        remoteOk?: boolean;
        preset?: string;
        autoDiscover?: boolean;
        /** Continue an earlier run: same brief and résumé, new jobs only. */
        continueFrom?: string;
        /** The upload endpoint's parse, handed back so the run reuses it. */
        parsedResume?: unknown;
      }>(req);

      // A continuation inherits everything the parent was told and adds the
      // one thing that makes it a continuation: don't show those jobs again.
      let excludeJobIds: string[] | undefined;
      let broaden = false;
      let inherited: { resume: StructuredResume; profile: ProfileSummary | null } | undefined;

      // Re-validated rather than trusted. It left as our own output, but it
      // came back over HTTP, and everything crossing that boundary is parsed
      // against the schema like any other input.
      if (body.parsedResume && typeof body.parsedResume === "object") {
        const p = body.parsedResume as { resume?: unknown; profile?: unknown };
        const resume = StructuredResume.safeParse(p.resume);
        if (resume.success) {
          const profile = ProfileSummary.safeParse(p.profile);
          inherited = { resume: resume.data, profile: profile.success ? profile.data : null };
        }
      }
      if (body.continueFrom) {
        const parent = store.getRun(body.continueFrom);
        if (!parent) return json(res, 404, { error: `run ${body.continueFrom} not found` });
        const pb = parent.blackboard as unknown as Blackboard;
        // Everything the parent ranked, plus anything it had already inherited,
        // so a third pass excludes both earlier ones rather than only the last.
        excludeJobIds = [...new Set([...(pb.exclude_job_ids ?? []), ...(pb.ranked_job_ids ?? [])])];
        broaden = true;
        body.brief = body.brief?.trim() || parent.brief;
        if (pb.resume) inherited = { resume: pb.resume, profile: pb.profile ?? null };
        if (!body.locations && pb.preferences?.locations?.length) {
          body.locations = pb.preferences.locations.join(", ");
        }
        if (body.remoteOk === undefined) body.remoteOk = pb.preferences?.remote_ok;
      }

      // Set before the run so tier resolution and the funnel caps pick it up.
      if (body.preset === "cheap" || body.preset === "balanced" || body.preset === "thorough") {
        process.env.JOBSEARCH_PRESET = body.preset;
      }
      if (!body.brief?.trim()) return json(res, 400, { error: "brief is required" });

      let resumeText = body.resumeText?.trim() || undefined;
      if (!resumeText && body.resumePath?.trim()) {
        try {
          const { text } = await extractText(path.resolve(body.resumePath.trim()));
          resumeText = text;
        } catch (err) {
          return json(res, 400, { error: `could not read ${body.resumePath}: ${(err as Error).message}` });
        }
      }

      const runId = `run_${Math.random().toString(16).slice(2, 10)}`;
      hub.open(runId, "search");
      json(res, 202, { runId });

      // Fire and forget: the client follows the SSE stream. Errors land on the
      // stream as a run_finished with status "failed", never as a dropped
      // connection with no explanation.
      void systemFor(runId)
        .search({
          runId,
          brief: body.brief,
          resumeText,
          usePlanner: body.usePlanner !== false,
          locations: body.locations
            ? body.locations.split(/[,\n]/).map((x) => x.trim()).filter(Boolean)
            : [],
          remoteOk: body.remoteOk !== false,
          autoDiscover: body.autoDiscover,
          discover: body.discover
            ? body.discover.split(/[,\n]/).map((x) => x.trim()).filter(Boolean)
            : undefined,
          budget: body.budget ? { max_cost_usd: body.budget } : undefined,
          excludeJobIds,
          broaden,
          parsedResume: inherited,
        })
        .catch((err: Error) => {
          hub.emit(runId, { type: "run_finished", status: "failed", summary: err.message, skipped: [] });
        })
        .finally(() => hub.close(runId));
      return;
    }

    /* ── start a tailoring run ────────────────────────────────────────── */
    if (req.method === "POST" && pathname === "/api/tailor") {
      const body = await readJson<{ searchRunId?: string; jobId?: string }>(req);
      if (!body.searchRunId || !body.jobId) return json(res, 400, { error: "searchRunId and jobId are required" });

      const runId = `${body.searchRunId}_tailor_${body.jobId.slice(0, 8)}`;
      const existing = hub.get(runId);
      if (existing && !existing.done) return json(res, 409, { error: "already running", runId });

      hub.open(runId, "tailor", body.searchRunId);
      json(res, 202, { runId });

      void systemFor(runId)
        .tailor({ searchRunId: body.searchRunId, jobId: body.jobId })
        .catch((err: Error) => {
          hub.emit(runId, { type: "run_finished", status: "failed", summary: err.message, skipped: [] });
        })
        .finally(() => hub.close(runId));
      return;
    }

    /* ── answer a question and resume ─────────────────────────────────── */
    if (req.method === "POST" && pathname === "/api/answer") {
      const body = await readJson<{ runId?: string; id?: string; text?: string }>(req);
      if (!body.runId || !body.id || !body.text) {
        return json(res, 400, { error: "runId, id and text are required" });
      }
      store.answerEscalation(body.id, body.text);
      json(res, 200, { ok: true, open: store.listEscalations(body.runId, true).length });
      return;
    }

    /* ── event stream ─────────────────────────────────────────────────── */
    if (req.method === "GET" && pathname === "/api/events") {
      const runId = url.searchParams.get("run");
      if (!runId) return json(res, 400, { error: "run is required" });
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        // Without this, a proxy or the browser may hold the first frames.
        "x-accel-buffering": "no",
      });
      res.write(": open\n\n");
      hub.subscribe(runId, res);
      return;
    }

    /* ── reads ────────────────────────────────────────────────────────── */
    if (req.method === "GET" && pathname === "/api/runs") {
      const runs = store.listRuns(50).map((r) => ({
        id: r.id,
        brief: r.brief,
        status: r.status,
        created_at: r.created_at,
        kind: r.id.includes("_tailor_") ? "tailor" : "search",
      }));
      return json(res, 200, { runs });
    }

    if (req.method === "GET" && pathname === "/api/run") {
      const runId = url.searchParams.get("id");
      if (!runId) return json(res, 400, { error: "id is required" });
      const run = store.getRun(runId);
      if (!run) return json(res, 404, { error: `run ${runId} not found` });

      const board = run.blackboard as unknown as Blackboard;
      // A tailoring run carries the parent search's matches but no ranking of
      // its own, so fall back to ordering by score rather than by insertion.
      const ids = board.ranked_job_ids?.length
        ? board.ranked_job_ids
        : [...(board.matches ?? [])].sort((a, b) => b.overall - a.overall).map((m) => m.job_id);

      return json(res, 200, {
        id: run.id,
        brief: run.brief,
        status: run.status,
        budget: run.budget,
        skipped: board.skipped ?? [],
        results: ids
          .map((id) => {
            const job = store.getJob(id);
            const match = (board.matches ?? []).find((m) => m.job_id === id);
            if (!job || !match) return null;
            const analysis = store.getAnalysis(id);
            return {
              // Extracted per posting and previously never surfaced. A night
              // shift or a security deposit is the thing a candidate most
              // needs to see before they spend an evening applying.
              red_flags: analysis?.red_flags ?? [],
              years_required: analysis?.years_required ?? null,
              job_id: id,
              title: job.title,
              company: job.company,
              location: job.location,
              work_mode: job.work_mode,
              url: job.url,
              overall: match.overall,
              dimensions: match.dimensions,
              gaps: match.gaps,
              matched_skills: match.matched_skills,
              reasoning: match.reasoning,
              reconciliation: match.reconciliation,
              scored_by: match.scored_by,
              confidence: match.confidence,
              deterministic: match.deterministic,
            };
          })
          .filter(Boolean),
        questions: store.listEscalations(runId).map((e) => ({
          id: e.id,
          question: e.question,
          kind: e.kind,
          options: e.options,
          blocking: e.blocking,
          answer: e.answer,
        })),
        render: board.render ?? null,
        critiques: board.critiques ?? [],
        bindings: board.bindings ?? null,
        edit_plan: board.edit_plan ?? null,
        trace: store.listTrace(runId),
      });
    }

    if (req.method === "GET" && pathname === "/api/file") {
      const runId = url.searchParams.get("run");
      const name = url.searchParams.get("name");
      if (!runId || !name) return json(res, 400, { error: "run and name are required" });
      // Resolved and re-checked against the output root: a crafted `name` must
      // not be able to read outside it.
      const root = path.resolve(env.outDir, runId);
      const file = path.resolve(root, path.basename(name));
      if (!file.startsWith(root + path.sep)) return json(res, 400, { error: "bad path" });
      try {
        const data = await fsp.readFile(file);
        res.writeHead(200, {
          "content-type": file.endsWith(".pdf")
            ? "application/pdf"
            : file.endsWith(".docx")
              ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              : "application/json",
          "content-disposition": `inline; filename="${path.basename(file)}"`,
        });
        res.end(data);
      } catch {
        json(res, 404, { error: "not found" });
      }
      return;
    }

    json(res, 404, { error: `no route for ${req.method} ${pathname}` });
  }

  function serveStatic(res: http.ServerResponse, name: string, type: string): void {
    const file = path.join(WEB_DIR, name);
    if (!fs.existsSync(file)) {
      json(res, 500, { error: `missing asset ${name}` });
      return;
    }
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    fs.createReadStream(file).pipe(res);
  }

  return { server, store };
}

/** Rough total tenure, for the suggested brief only. */
function estimateYears(experience: Array<{ start: string; end: string }>): number {
  const months = (v: string): number | null => {
    if (/present/i.test(v)) {
      const d = new Date();
      return d.getFullYear() * 12 + d.getMonth();
    }
    const m = /^(\d{4})-(\d{2})$/.exec(v);
    return m ? Number(m[1]) * 12 + Number(m[2]) - 1 : null;
  };
  let total = 0;
  for (const e of experience) {
    const a = months(e.start);
    const b = months(e.end);
    if (a !== null && b !== null && b > a) total += b - a;
  }
  return Math.round((total / 12) * 10) / 10;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

async function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error(`upload exceeds ${Math.round(limit / 1e6)}MB`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // A resume pasted into a textarea is the largest thing this accepts.
    if (size > 2_000_000) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {} as T;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

/* ── entrypoint ───────────────────────────────────────────────────────── */

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const fixtures = process.argv.includes("--fixtures");
  const forcedOffline = process.argv.includes("--offline");
  const port = Number(process.env.PORT ?? 4173);
  const offline = fixtures || forcedOffline || !env.hasApiKey;

  const { server } = createServer({ fixtures, offline: forcedOffline });
  server.listen(port, () => {
    console.log(`\n  job-search-aiagent console  http://localhost:${port}`);
    console.log(
      `  model:  ${offline ? "heuristics (no API key needed)" : "Anthropic, tiered"}\n` +
        `  jobs:   ${fixtures ? "local samples in fixtures/jobs" : "real ATS boards in the registry"}`,
    );
    console.log(`  store:  ${env.dbPath}\n`);
  });
}
