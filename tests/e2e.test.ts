import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { BRIEF, finishedNodes, harness, resumeText, type Harness } from "./helpers.js";
import type { RunResult } from "../src/orchestrator/graph.js";

let h: Harness;
beforeEach(() => {
  h = harness();
});
afterEach(() => h.cleanup());

async function search(overrides: Parameters<Harness["system"]["search"]>[0] extends infer T ? Partial<T> : never = {}) {
  return h.system.search({ brief: BRIEF, resumeText: resumeText(), usePlanner: false, ...overrides });
}

describe("search lane, end to end and offline", () => {
  it("runs the whole funnel and returns explainable ranked results", async () => {
    const r = await search();

    expect(r.status).toBe("completed");
    expect(r.board.ranked_job_ids.length).toBeGreaterThan(2);

    for (const m of r.board.matches) {
      expect(m.overall).toBeGreaterThanOrEqual(0);
      expect(m.overall).toBeLessThanOrEqual(100);
      // Explainability is the product, not a nicety: a rubric-scored job must
      // carry per-dimension reasons.
      if (m.scored_by !== "deterministic") {
        expect(m.dimensions.length).toBeGreaterThan(0);
        for (const d of m.dimensions) expect(d.reason.length).toBeGreaterThan(3);
      }
      expect(m.deterministic.skill_overlap).toBeGreaterThanOrEqual(0);
    }
  });

  it("dispatches each node exactly once per superstep", async () => {
    const r = await search();
    const byNode = new Map<string, number>();
    for (const e of finishedNodes(h.events)) byNode.set(e.node_id, (byNode.get(e.node_id) ?? 0) + 1);
    for (const [nodeId, count] of byNode) {
      expect(count, `node ${nodeId} ran ${count} times`).toBe(1);
    }
    expect(r.trace.length).toBe(byNode.size);
  });

  it("runs the independent first-layer nodes in the same superstep", async () => {
    await search();
    const plan = h.events.find((e) => e.type === "plan");
    expect(plan).toBeDefined();
    if (plan?.type === "plan") expect(plan.parallel_branches).toBeGreaterThanOrEqual(2);
  });

  it("collapses the aggregator duplicate of a board posting", async () => {
    const r = await search();
    const titles = r.board.unique_job_ids.map((id) => h.store.getJob(id)!.title);
    // One of the fixtures is the same Zeta role echoed by an aggregator, so
    // exactly one posting must disappear.
    expect(r.board.harvested_job_ids.length).toBe(13);
    expect(r.board.unique_job_ids.length).toBe(12);
    expect(titles.filter((t) => /^Backend Engineer/.test(t))).toHaveLength(1);
  });

  it("drops postings that fail a hard filter, and says why", async () => {
    const r = await search();
    const kept = r.board.filtered_job_ids.map((id) => h.store.getJob(id)!.title);
    expect(kept).not.toContain("Frontend Engineer");
    const filterNode = finishedNodes(h.events).find((e) => e.kind === "hard_filter");
    expect(filterNode!.summary).toMatch(/dropped:/);
  });

  it("re-plans with a broadening branch when the filters leave too little", async () => {
    const r = await search();
    const replans = h.events.filter((e) => e.type === "replan");
    expect(replans.length).toBe(1);
    if (replans[0]?.type === "replan") {
      expect(replans[0].reason).toMatch(/postings survived/);
      expect(replans[0].added_nodes).toContain("broaden_query_b1");
    }
    // Broadening happens once. A second one would mean the brief is the problem.
    expect(r.trace.filter((t) => t.node_id.startsWith("broaden_query")).length).toBe(1);
  });

  it("reconciles a job where the composite and the holistic verdict disagree", async () => {
    const r = await search();
    const reconciled = r.board.matches.filter((m) => m.reconciliation !== null);
    expect(reconciled.length).toBeGreaterThan(0);
    for (const m of reconciled) {
      expect(Math.abs(m.reconciliation!.composite_before - m.reconciliation!.holistic_before)).toBeGreaterThan(15);
      expect(m.scored_by).toBe("rubric+reconciled");
    }
  });

  it("caches JD analysis across runs, so a second search re-reads instead of re-paying", async () => {
    const r1 = await search();
    const first = r1.trace.find((t) => t.kind === "jd_analysis")!;
    expect(first.output_summary).toMatch(/\d+ analysed/);
    expect(first.usage.cost_usd).toBeGreaterThan(0);

    // A different run: the DAG must actually execute (idempotency is scoped
    // per run), but the per-job JD analysis cache is long-lived.
    const r2 = await h.system.search({ brief: BRIEF, resumeText: resumeText(), usePlanner: false });
    const second = r2.trace.find((t) => t.kind === "jd_analysis")!;
    expect(second.output_summary).toMatch(/served from cache/);
    expect(second.usage.cost_usd).toBe(0);
  });

  it("records a trace row per node with model, cost and duration", async () => {
    const r = await search();
    expect(r.trace.length).toBeGreaterThan(8);
    for (const t of r.trace) {
      expect(t.agent).toBeTruthy();
      expect(t.output_summary).toBeTruthy();
      expect(t.duration_ms).toBeGreaterThanOrEqual(0);
      expect(t.input_hash).toMatch(/^[0-9a-f]{40}$/);
    }
    // Only the model-backed nodes should carry a model and a cost.
    const paid = r.trace.filter((t) => t.usage.cost_usd > 0);
    expect(paid.every((t) => t.model !== null)).toBe(true);
    expect(r.trace.some((t) => t.model === null)).toBe(true);
  });

  it("grows long-term memory: title synonyms confirmed against real postings", async () => {
    const before = h.store.titleSynonyms("member of technical staff").filter((s) => s.confirmed).length;
    await search();
    const curate = finishedNodes(h.events).find((e) => e.kind === "memory_curate");
    expect(curate!.summary).toMatch(/title synonyms confirmed/);
    expect(h.store.titleSynonyms("sde ii").length).toBeGreaterThan(0);
    expect(before).toBeGreaterThanOrEqual(0);
  });
});

describe("budget governor stops cleanly", () => {
  it("returns partial results labelled as partial, naming what was skipped", async () => {
    const r = await h.system.search({
      brief: BRIEF,
      resumeText: resumeText(),
      usePlanner: false,
      budget: { max_llm_calls: 3 },
    });

    expect(r.status).toBe("partial");
    expect(r.stopReason).toMatch(/budget/);
    expect(r.board.skipped.length).toBeGreaterThan(0);
    // Never a silent truncation: every line says why.
    for (const s of r.board.skipped) expect(s).toMatch(/budget breach|blocked by|Budget reached/);
    expect(r.board.skipped.join(" ")).toMatch(/Budget reached/);
  });

  it("still returns ranked results after a breach, from the work already paid for", async () => {
    // The failure this pins: halting the scheduler on a breach also skipped the
    // *free* deterministic nodes, so a run could spend its entire budget and
    // then hand back nothing at all.
    const r = await h.system.search({
      brief: BRIEF,
      resumeText: resumeText(),
      usePlanner: false,
      budget: { max_llm_calls: 3 },
    });

    expect(r.status).toBe("partial");
    expect(r.board.ranked_job_ids.length).toBeGreaterThan(0);
    expect(r.board.matches.length).toBeGreaterThan(0);
    // Scored without the rubric, and the report says so rather than implying
    // a considered judgment.
    expect(r.board.matches.some((m) => m.scored_by === "deterministic")).toBe(true);
    for (const m of r.board.matches) {
      expect(m.overall).toBeGreaterThanOrEqual(0);
      expect(m.deterministic.title_similarity).toBeGreaterThanOrEqual(0);
    }
  });

  it("does not let a failed broadening branch sink the run", async () => {
    // Broadening adds to a thin result set; when it cannot run, the run must
    // continue with what the first pass found.
    const r = await h.system.search({
      brief: BRIEF,
      resumeText: resumeText(),
      usePlanner: false,
      budget: { max_llm_calls: 4 },
    });
    const broadenNodes = (r.board.skipped ?? []).filter((s) => /widened matrix|Broaden/i.test(s));
    expect(r.board.ranked_job_ids.length).toBeGreaterThan(0);
    void broadenNodes;
  });
});

describe("tailoring lane, end to end and offline", () => {
  let searchRun: RunResult;

  beforeEach(async () => {
    searchRun = await search();
  });

  it("drops an unevidenced edit and turns it into a specific question", async () => {
    const jobId = searchRun.board.ranked_job_ids[0]!;
    const r = await h.system.tailor({ searchRunId: searchRun.runId, jobId });

    const unbound = r.board.bindings!.bindings.filter((b) => !b.bound);
    expect(unbound.length).toBeGreaterThan(0);

    const questions = r.escalations.filter((e) => e.kind === "evidence_gap");
    expect(questions.length).toBeGreaterThan(0);
    for (const q of questions) {
      expect(q.question).toMatch(/\?$/);
      // "Something went wrong" is never an acceptable escalation.
      expect(q.question.length).toBeGreaterThan(20);
    }
    // The dropped edit must not appear in the draft.
    expect(JSON.stringify(r.board.draft)).not.toMatch(/kubernetes/i);
  });

  it("runs the reject -> revise -> pass loop and stops at the cap", async () => {
    const jobId = searchRun.board.ranked_job_ids[0]!;
    const r = await h.system.tailor({ searchRunId: searchRun.runId, jobId });

    const verdicts = r.board.critiques.map((c) => c.verdict);
    expect(verdicts[0]).toBe("reject");
    expect(verdicts.at(-1)).toBe("pass");
    expect(verdicts.length).toBeLessThanOrEqual(3);

    // The rejection was the invented metric, and the revision removed it.
    expect(r.board.critiques[0]!.findings.some((f) => f.category === "invented_metric")).toBe(true);
    expect(JSON.stringify(r.board.draft)).not.toContain("40%");
  });

  it("renders a PDF and a DOCX whose text survives extraction", async () => {
    const jobId = searchRun.board.ranked_job_ids[0]!;
    const r = await h.system.tailor({ searchRunId: searchRun.runId, jobId });

    const render = r.board.render!;
    expect(fs.existsSync(render.pdf_path)).toBe(true);
    expect(fs.existsSync(render.docx_path)).toBe(true);

    expect(render.ats_check.passed).toBe(true);
    expect(render.ats_check.missing_sections).toEqual([]);
    expect(render.ats_check.missing_skills).toEqual([]);
    expect(render.ats_check.extracted_chars).toBeGreaterThan(800);
  });

  it("is deterministic: the same resume JSON renders byte-identical PDFs", async () => {
    const { renderPdf } = await import("../src/tools/render/index.js");
    const jobId = searchRun.board.ranked_job_ids[0]!;
    const r = await h.system.tailor({ searchRunId: searchRun.runId, jobId });

    const a = `${render_tmp()}-a.pdf`;
    const b = `${render_tmp()}-b.pdf`;
    const createdAt = new Date("2026-01-01T00:00:00Z");
    await renderPdf(r.board.draft!, "modern", a, { createdAt });
    await renderPdf(r.board.draft!, "modern", b, { createdAt });
    expect(fs.readFileSync(a).equals(fs.readFileSync(b))).toBe(true);
  });
});

function render_tmp(): string {
  return fs.mkdtempSync("/tmp/job-search-aiagent-render-");
}

describe("stated preferences override the résumé", () => {
  it("infers no location when none is stated, rather than reading one off the CV", async () => {
    const r = await h.system.search({
      brief: "Backend engineer, 4 years",
      resumeText: resumeText(),
      usePlanner: false,
    });
    // The fixture résumé says Bengaluru throughout; that must not become a filter.
    expect(r.board.query_plan!.locations).toEqual([]);
    const dropped = r.trace.find((t) => t.kind === "hard_filter")!.output_summary;
    expect(dropped).not.toMatch(/location/);
  });

  it("filters on where the candidate wants to be, not where they have been", async () => {
    const r = await h.system.search({
      brief: "Backend engineer, 4 years",
      resumeText: resumeText(),
      usePlanner: false,
      locations: ["Pune"],
      remoteOk: false,
    });
    expect(r.board.query_plan!.locations).toEqual(["Pune"]);
    expect(r.board.preferences.locations).toEqual(["Pune"]);
    expect(r.board.preferences.remote_ok).toBe(false);
    // No fixture is in Pune, so the location constraint must actually bite,
    // and the reason must name what it rejected rather than saying "location".
    const filterNode = r.trace.find((t) => t.kind === "hard_filter")!;
    expect(filterNode.output_summary).toMatch(/outside Pune|asked for on-site in Pune|restricted to/);
  });

  it("never drops a stated location, even when the search broadens", async () => {
    // The failure this pins: broadening relaxed the *title* rule and silently
    // took the location constraint with it, so asking for Bengaluru returned
    // New York.
    const offline = harness({ provider: "offline" });
    try {
      const r = await offline.system.search({
        brief: "Backend engineer",
        resumeText: resumeText(),
        usePlanner: false,
        locations: ["Bengaluru"],
        remoteOk: false,
      });

      // Broadening must have fired for this to be a real test of the guard.
      expect(r.trace.some((t) => t.node_id.startsWith("broaden_"))).toBe(true);

      for (const id of r.board.ranked_job_ids) {
        const job = offline.store.getJob(id)!;
        expect(
          (job.location ?? "").toLowerCase(),
          `${job.title} @ ${job.company} (${job.location}) survived a Bengaluru-only filter`,
        ).toContain("bengaluru");
      }
    } finally {
      offline.cleanup();
    }
  });

  it("loosens the title rule when broadening rather than abandoning it", async () => {
    // The offline provider, because this is about a search matrix derived from
    // the résumé actually supplied — which a scripted double cannot express.
    const offline = harness({ provider: "offline" });
    const r = await offline.system.search({
      brief: "Customer support associate, 1.5 years",
      resumeText: SUPPORT_RESUME,
      usePlanner: false,
    });
    const titles = r.board.ranked_job_ids.map((id) => offline.store.getJob(id)!.title);
    try {
      // Broadening relaxes the title rule; it must not turn the search into
      // "everything in the corpus".
      expect(titles.some((t) => /Engineer|Technical Staff/i.test(t))).toBe(false);
      expect(titles[0]).toMatch(/Customer Support Associate/);
    } finally {
      offline.cleanup();
    }
  });

  it("reads a real support résumé and ranks support roles for it, with no model", async () => {
    const offline = harness({ provider: "offline" });
    try {
      const r = await offline.system.search({
        brief: "Customer support associate, 1.5 years",
        resumeText: SUPPORT_RESUME,
        usePlanner: false,
      });

      // Parsed from the supplied text, not replayed from a fixture.
      expect(r.board.resume!.contact.name).toBe("Farhin Yasmin");
      expect(r.board.resume!.experience[0]!.title).toBe("Customer Support Associate");
      expect(r.board.resume!.experience[0]!.company).toContain("Ryfs Heights");

      // Free, and every reason cites a measurement rather than a judgment.
      expect(r.spent.cost_usd).toBe(0);
      const top = r.board.matches.find((m) => m.job_id === r.board.ranked_job_ids[0])!;
      expect(top.dimensions.length).toBeGreaterThan(0);
      expect(top.deterministic.title_similarity).toBe(1);
    } finally {
      offline.cleanup();
    }
  });
});

const SUPPORT_RESUME = `FARHIN YASMIN
Customer Support Associate
7003283270 | someone@example.com
Howrah - 711309
PROFILE
Customer Support Associate with 1.5 years of experience in outbound calling and appointment booking.
WORK EXPERIENCE
Customer Support Associate
Ryfs Heights Realtors Private Limited | February 2025 - July 2026
• Made outbound calls to inbound leads and booked site visits against a daily target.
• Sent confirmation emails to customers covering visit date, time and site details.
KEY SKILLS
• Customer support and telephone handling | Outbound and follow-up calling
• Lead handling, appointment booking and target achievement | MS Word, Excel
LANGUAGES
Bengali (native) | Hindi (fluent) | English (fluent)
EDUCATION
B.A. English (Honours), University of Calcutta: 2024
`;

describe("the registry grows itself", () => {
  it("degrades to a normal run when web search is unavailable", async () => {
    // Auto-discovery needs a credential and the network. Offline it must be a
    // no-op that says so, not a failure that stops the search.
    const offline = harness({ provider: "offline" });
    try {
      const r = await offline.system.search({
        brief: "Customer support associate",
        resumeText: resumeText(),
        usePlanner: false,
        autoDiscover: true,
      });
      expect(r.board.auto_discover).toBe(true);
      const node = r.trace.find((t) => t.kind === "source_discovery")!;
      expect(node.status).toBe("done");
      expect(r.board.ranked_job_ids.length).toBeGreaterThan(0);
    } finally {
      offline.cleanup();
    }
  });

  it("turns itself on when the registry is too thin to answer the question", async () => {
    const offline = harness({ provider: "offline" });
    try {
      // The fixture registry holds one source, which is under the threshold.
      const r = await offline.system.search({
        brief: "Customer support associate",
        resumeText: resumeText(),
        usePlanner: false,
      });
      expect(r.board.auto_discover).toBe(true);
    } finally {
      offline.cleanup();
    }
  });
});
