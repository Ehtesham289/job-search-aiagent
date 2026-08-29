import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteStore } from "../src/state/sqlite.js";
import { expandTitle, normalizeSkill, seedMemory, skillOverlap, titleSimilarity } from "../src/tools/skills.js";
import { candidateSignal, rubricScore, seniorityDelta } from "../src/agents/matchScorer.js";
import { applyHardFilters } from "../src/agents/filters.js";
import { totalYears } from "../src/agents/resumeParser.js";
import { HashingEmbedder, cosineSim } from "../src/tools/embed.js";
import type { JDAnalysis, JobPosting } from "../src/schemas/job.js";
import type { QueryPlan } from "../src/schemas/query.js";
import type { StructuredResume } from "../src/schemas/profile.js";
import type { SourceRecord } from "../src/schemas/source.js";

let dir: string;
let store: SqliteStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "job-search-aiagent-score-"));
  store = new SqliteStore(path.join(dir, "t.sqlite"));
  seedMemory(store);
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("synonym resolution", () => {
  it("resolves the aliases that actually cost matches", () => {
    expect(normalizeSkill(store, "node")).toBe("node.js");
    expect(normalizeSkill(store, "K8s")).toBe("kubernetes");
    expect(normalizeSkill(store, "Postgres")).toBe("postgresql");
    expect(normalizeSkill(store, "golang")).toBe("go");
  });

  it("expands the Indian title variants the spec calls out", () => {
    expect(expandTitle(store, "SDE II")).toContain("software engineer");
    expect(expandTitle(store, "Member of Technical Staff")).toContain("software engineer");
    expect(expandTitle(store, "API Engineer")).toContain("backend engineer");
  });
});

describe("skill overlap", () => {
  // Shrunk toward a 0.3 prior with weight 2: (earned + 0.6) / (total + 2).
  const shrink = (earned: number, total: number) => (earned + 2 * 0.3) / (total + 2);

  it("weights must-haves far above nice-to-haves, and reports both sides", () => {
    const r = skillOverlap(store, ["Node", "Postgres"], ["node.js", "postgresql", "kubernetes"], ["redis"]);
    expect(r.matched).toContain("node.js");
    expect(r.missing).toEqual(["kubernetes"]);
    expect(r.score).toBeCloseTo(shrink(2, 3.2), 3);
  });

  it("matches through containment, so 'postgresql 14' still counts", () => {
    const r = skillOverlap(store, ["PostgreSQL 14"], ["postgresql"], []);
    expect(r.matched).toEqual(["postgresql"]);
    expect(r.missing).toEqual([]);
    expect(r.score).toBeCloseTo(shrink(1, 1), 3);
  });

  it("does not treat one vague requirement as strong evidence", () => {
    // The property the shrinkage exists for: matching the single requirement a
    // thin posting states must not beat matching most of a detailed one.
    const thin = skillOverlap(store, ["excel"], ["excel"], []);
    const detailed = skillOverlap(
      store,
      ["excel", "node.js", "postgresql", "aws"],
      ["excel", "node.js", "postgresql", "aws", "kubernetes", "kafka"],
      [],
    );
    expect(thin.score).toBeLessThan(detailed.score);
    expect(thin.score).toBeLessThan(1);
  });

  it("is zero when the JD lists nothing, rather than falsely perfect", () => {
    expect(skillOverlap(store, ["node.js"], [], []).score).toBe(0);
  });
});

describe("title similarity", () => {
  it("is 1 for the same role, however it is decorated", () => {
    expect(titleSimilarity(store, ["Customer Support Associate"], "Customer Support Associate")).toBe(1);
    expect(titleSimilarity(store, ["Backend Engineer"], "Senior Backend Engineer (Remote)")).toBe(1);
  });

  it("resolves through the synonym graph", () => {
    expect(titleSimilarity(store, ["SDE II"], "Software Engineer")).toBe(1);
  });

  it("is partial for a neighbouring role and zero for an unrelated one", () => {
    const near = titleSimilarity(store, ["Customer Support Associate"], "Customer Success Executive");
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(1);
    expect(titleSimilarity(store, ["Customer Support Associate"], "Structural Welder")).toBe(0);
  });

  it("is zero when there is nothing to compare", () => {
    expect(titleSimilarity(store, [], "Anything")).toBe(0);
    expect(titleSimilarity(store, ["Anything"], "")).toBe(0);
  });
});

describe("seniority distance", () => {
  const analysis = (min: number | null, max: number | null): JDAnalysis =>
    ({
      job_id: "j", must_have: [], nice_to_have: [], years_required: { min, max },
      true_seniority: "mid", implicit_requirements: [], red_flags: [], domain: [],
      responsibilities: [], keywords: [], confidence: 1, analyzed_at: "", model: "",
    }) as JDAnalysis;

  it("is zero inside the band", () => {
    expect(seniorityDelta(4, analysis(3, 6))).toBe(0);
  });

  it("is negative when underqualified and positive when over", () => {
    expect(seniorityDelta(2, analysis(4, 7))).toBe(-2);
    expect(seniorityDelta(11, analysis(3, 6))).toBe(5);
  });

  it("falls back to the seniority band when years are unstated", () => {
    expect(seniorityDelta(4, analysis(null, null))).toBe(0);
  });
});

describe("total experience", () => {
  const resume = (exp: Array<[string, string]>): StructuredResume =>
    ({
      contact: { name: "x", email: null, phone: null, location: null, links: [] },
      summary: null,
      experience: exp.map(([start, end], i) => ({
        id: `exp_${i}`, company: "c", title: "t", location: null, start, end, bullets: [],
      })),
      skills: { primary: [], secondary: [] }, education: [], projects: [], certifications: [],
    }) as StructuredResume;

  it("sums non-overlapping roles", () => {
    expect(totalYears(resume([["2019-01", "2021-01"], ["2021-01", "2023-01"]]))).toBeCloseTo(4, 1);
  });

  it("does not double-count overlapping roles", () => {
    expect(totalYears(resume([["2019-01", "2023-01"], ["2020-01", "2022-01"]]))).toBeCloseTo(4, 1);
  });
});

describe("hard filters", () => {
  const plan: QueryPlan = {
    canonical_role: "Backend Engineer",
    title_variants: ["Backend Engineer", "SDE II"],
    adjacent_roles: [],
    skill_signature: ["node.js"],
    seniority_band: { min: 3, max: 6 },
    exclusions: ["Frontend", "QA"],
    locations: ["Bengaluru"],
    queries: [{ source_type: "ats", q: "x", location: "Bengaluru", remote_ok: true, rationale: "r" }],
    confidence: 1,
    uncertainty_notes: [],
  };

  const job = (over: Partial<JobPosting>): JobPosting =>
    ({
      id: "j", dedupe_key: "k", source_id: "s", ats_type: "greenhouse",
      company: "Acme", title: "Backend Engineer", location: "Bengaluru, India",
      work_mode: "onsite", posted_at: new Date().toISOString(), url: "u", apply_url: null,
      description_text: "x".repeat(500), description_html: null, compensation: null,
      department: null, employment_type: null, fetched_at: "",
      ...over,
    }) as JobPosting;

  it("keeps a matching posting", () => {
    expect(applyHardFilters(job({}), plan).keep).toBe(true);
  });

  it("drops an excluded title and names the exclusion", () => {
    const v = applyHardFilters(job({ title: "Frontend Engineer" }), plan);
    expect(v.keep).toBe(false);
    expect(v.reason).toContain("Frontend");
  });

  it("does not treat one shared generic word as a title match", () => {
    expect(applyHardFilters(job({ title: "Sales Engineer" }), plan).keep).toBe(false);
  });

  it("lets a remote posting through a location constraint", () => {
    expect(applyHardFilters(job({ location: "Remote", work_mode: "remote" }), plan).keep).toBe(true);
  });

  it("drops a stale posting, but not in relaxed mode", () => {
    const stale = job({ posted_at: new Date(Date.now() - 200 * 864e5).toISOString() });
    expect(applyHardFilters(stale, plan).keep).toBe(false);
    expect(applyHardFilters(stale, plan, true).keep).toBe(true);
  });

  it("drops a description too short to analyse honestly, even relaxed", () => {
    const thin = job({ description_text: "Apply here." });
    expect(applyHardFilters(thin, plan).keep).toBe(false);
    expect(applyHardFilters(thin, plan, true).keep).toBe(false);
  });
});

describe("rubric weighting", () => {
  it("weights core skills highest and normalises over the dimensions present", () => {
    const all = rubricScore({
      dimensions: [
        { dimension: "core_skills", score: 100, reason: "r" },
        { dimension: "seniority_fit", score: 0, reason: "r" },
        { dimension: "domain_relevance", score: 0, reason: "r" },
        { dimension: "scope_and_impact", score: 0, reason: "r" },
        { dimension: "location_and_mode", score: 0, reason: "r" },
      ],
      holistic: 0, matched_skills: [], gaps: [], reasoning: [], confidence: 1,
    });
    expect(all).toBeCloseTo(35, 5);

    const partial = rubricScore({
      dimensions: [{ dimension: "core_skills", score: 80, reason: "r" }],
      holistic: 0, matched_skills: [], gaps: [], reasoning: [], confidence: 1,
    });
    expect(partial).toBeCloseTo(80, 5);
  });
});

describe("embedder", () => {
  const e = new HashingEmbedder(512);

  it("is deterministic across calls", () => {
    expect([...e.embed("node.js postgresql")]).toEqual([...e.embed("node.js postgresql")]);
  });

  it("ranks a related JD above an unrelated one", () => {
    const resume = e.embed("backend engineer node.js postgresql rest api aws docker settlements ledger");
    const near = e.embed("backend engineer node.js postgresql rest apis aws containers payments");
    const far = e.embed("registered nurse patient care intensive care unit clinical documentation");
    expect(cosineSim(resume, near)).toBeGreaterThan(cosineSim(resume, far));
  });

  it("returns a zero vector for empty text rather than throwing", () => {
    expect(cosineSim(e.embed(""), e.embed("anything"))).toBe(0);
  });
});

describe("source health", () => {
  it("marks a source dead after repeated failures with no successes", () => {
    store.upsertSource({
      id: "s1", company: "Acme", domain: null, career_url: null, ats_type: "greenhouse",
      ats_slug: "acme", confidence: 1, status: "verified", enabled: true, reason: null, verified_at: null,
      health: { attempts: 0, failures: 0, last_ok_at: null, last_error: null, avg_latency_ms: 0 },
    });
    for (let i = 0; i < 3; i++) store.recordSourceHealth("s1", false, 100, "HTTP 500");
    const s = store.getSource("s1")!;
    expect(s.status).toBe("dead");
    expect(s.reason).toContain("500");
  });

  it("keeps a flaky-but-working source alive", () => {
    store.upsertSource({
      id: "s2", company: "Beta", domain: null, career_url: null, ats_type: "lever",
      ats_slug: "beta", confidence: 1, status: "verified", enabled: true, reason: null, verified_at: null,
      health: { attempts: 0, failures: 0, last_ok_at: null, last_error: null, avg_latency_ms: 0 },
    });
    store.recordSourceHealth("s2", true, 200);
    store.recordSourceHealth("s2", false, 100, "timeout");
    store.recordSourceHealth("s2", false, 100, "timeout");
    store.recordSourceHealth("s2", false, 100, "timeout");
    const s = store.getSource("s2")!;
    expect(s.status).toBe("verified");
    expect(s.health.failures).toBe(3);
    expect(s.health.avg_latency_ms).toBeCloseTo(125, 0);
  });
});

describe("word-boundary skill matching", () => {
  it("does not let 'excel' match 'excellent'", () => {
    // This matched almost every posting ever written, because nearly all of
    // them ask for excellent communication.
    const r = skillOverlap(store, ["Microsoft Excel"], ["excellent communication"], []);
    expect(r.matched).toEqual([]);
    expect(r.missing).toEqual(["excellent communication"]);
  });

  it("still matches a genuine prefix or suffix on a word boundary", () => {
    expect(skillOverlap(store, ["PostgreSQL 14"], ["postgresql"], []).matched).toEqual(["postgresql"]);
    expect(skillOverlap(store, ["node.js"], ["node.js runtime"], []).matched).toEqual(["node.js runtime"]);
  });
});

/**
 * A search with a brief and no résumé used to harvest thousands of postings,
 * filter them down to a good shortlist, and then return nothing at all,
 * because every scoring leg hard-required a résumé. The shortlist is the
 * user's answer; it has to survive.
 */
describe("scoring without a résumé", () => {
  const plan: QueryPlan = {
    canonical_role: "Customer Support Associate",
    title_variants: ["Customer Support Associate", "Customer Support Specialist"],
    adjacent_roles: ["Customer Success Manager"],
    skill_signature: ["zendesk", "ticketing"],
    seniority_band: { min: 0, max: 3 },
    exclusions: [],
    locations: ["Bengaluru"],
    queries: [{ source_type: "ats", q: "x", location: "Bengaluru", remote_ok: true, rationale: "r" }],
    confidence: 1,
    uncertainty_notes: [],
  };

  it("derives a candidate signal from the query plan", () => {
    const s = candidateSignal({ resume: null, query_plan: plan, brief: "customer support in Bengaluru" });
    expect(s).not.toBeNull();
    expect(s!.basis).toBe("brief");
    expect(s!.titles).toContain("Customer Support Associate");
    expect(s!.titles).toContain("Customer Success Manager");
    expect(s!.skills).toEqual(["zendesk", "ticketing"]);
  });

  it("claims no seniority it was never told", () => {
    const s = candidateSignal({ resume: null, query_plan: plan, brief: "customer support" })!;
    // The plan's band describes the ROLE, not the person. Reading it back as
    // the candidate's experience would grade them against themselves.
    expect(s.years).toBeNull();
  });

  it("prefers the résumé when there is one", () => {
    const resume = {
      contact: { name: "x", email: null, phone: null, location: null, links: [] },
      summary: null,
      experience: [{ id: "e0", company: "c", title: "Support Lead", location: null, start: "2020-01", end: "2024-01", bullets: [] }],
      skills: { primary: ["freshdesk"], secondary: [] },
      education: [], projects: [], certifications: [],
    } as unknown as StructuredResume;
    const s = candidateSignal({ resume, query_plan: plan, brief: "x" })!;
    expect(s.basis).toBe("resume");
    expect(s.titles).toEqual(["Support Lead"]);
    expect(s.years).toBeGreaterThan(3);
  });

  it("returns nothing when there is neither résumé nor plan", () => {
    expect(candidateSignal({ resume: null, query_plan: null, brief: "x" })).toBeNull();
  });
});

/**
 * Excluding a company is a preference, not a health verdict. The distinction
 * matters because re-verification and re-discovery both rewrite the source
 * record, and either one silently re-enabling a company the user turned off
 * would make the switch a suggestion rather than a setting.
 */
describe("including and excluding companies", () => {
  const src = (id: string, company: string) => ({
    id, company, domain: null, career_url: null, ats_type: "greenhouse" as const,
    ats_slug: company.toLowerCase(), confidence: 1, status: "verified" as const,
    enabled: true, reason: null, verified_at: null,
    health: { attempts: 0, failures: 0, last_ok_at: null, last_error: null, avg_latency_ms: 0 },
  });

  it("defaults to enabled", () => {
    store.upsertSource(src("e1", "Acme"));
    expect(store.getSource("e1")!.enabled).toBe(true);
  });

  it("excludes a disabled source from the enabled listing but keeps the record", () => {
    store.upsertSource(src("e1", "Acme"));
    store.upsertSource(src("e2", "Beta"));
    store.setSourceEnabled("e2", false);

    const on = store.listSources({ status: "verified", enabled: true });
    expect(on.map((s) => s.id)).toEqual(["e1"]);
    // Still in the registry, still verified — just skipped.
    expect(store.listSources({}).map((s) => s.id).sort()).toEqual(["e1", "e2"]);
    expect(store.getSource("e2")!.status).toBe("verified");
  });

  it("survives a re-upsert, so re-verification cannot switch it back on", () => {
    store.upsertSource(src("e3", "Gamma"));
    store.setSourceEnabled("e3", false);
    // Exactly what discovery does when it re-resolves a known company.
    store.upsertSource({ ...src("e3", "Gamma"), enabled: true, confidence: 0.9 });
    expect(store.getSource("e3")!.enabled).toBe(false);
    expect(store.getSource("e3")!.confidence).toBe(0.9);
  });

  it("does not lose health history while switched off", () => {
    store.upsertSource(src("e4", "Delta"));
    store.recordSourceHealth("e4", true, 120);
    store.setSourceEnabled("e4", false);
    expect(store.getSource("e4")!.health.attempts).toBe(1);
    store.setSourceEnabled("e4", true);
    expect(store.getSource("e4")!.health.attempts).toBe(1);
  });

  it("reports an unknown id rather than pretending it worked", () => {
    expect(store.setSourceEnabled("nope", false)).toBe(false);
  });
});

/**
 * The crash that quietly stopped the registry from growing.
 *
 * `discoverByRole` derives a source id from the ATS slug it found
 * (`definitivehcindia`); `discoverOne` derives it from the company name the
 * user typed (`Definitive Healthcare`). Both store the name the board reports,
 * so the two rows are identical under the unique index on
 * (company, ats_type, ats_slug) while their primary keys differ — and
 * `ON CONFLICT(id)` never saw it. The insert threw, source discovery failed,
 * and a search that needed new employers silently kept the old ones.
 */
describe("the same board discovered by two different routes", () => {
  const board = (id: string, over: Partial<SourceRecord> = {}): SourceRecord =>
    ({
      id, company: "Definitive Healthcare", domain: null, career_url: null,
      ats_type: "greenhouse", ats_slug: "definitivehcindia", confidence: 0.8,
      status: "verified", enabled: true, reason: null, verified_at: null,
      health: { attempts: 0, failures: 0, last_ok_at: null, last_error: null, avg_latency_ms: 0 },
      ...over,
    }) as SourceRecord;

  it("does not throw when the second route brings a different id", () => {
    store.upsertSource(board("id-from-ats-slug"));
    expect(() => store.upsertSource(board("id-from-company-name"))).not.toThrow();
  });

  it("keeps one row for one board rather than duplicating it", () => {
    store.upsertSource(board("id-from-ats-slug"));
    store.upsertSource(board("id-from-company-name", { confidence: 0.95 }));
    const rows = store.listSources({});
    expect(rows).toHaveLength(1);
    // The record is updated in place — the newer confidence wins.
    expect(rows[0]!.confidence).toBe(0.95);
  });

  it("still does not switch a company back on behind the user", () => {
    store.upsertSource(board("id-from-ats-slug"));
    store.setSourceEnabled("id-from-ats-slug", false);
    store.upsertSource(board("id-from-company-name"));
    expect(store.listSources({})[0]!.enabled).toBe(false);
  });
})
