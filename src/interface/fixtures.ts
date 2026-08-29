import path from "node:path";
import { ScriptedProvider, type ProviderRequest } from "../llm/provider.js";
import { sha1 } from "../tools/embed.js";
import type { Store } from "../state/store.js";
import type { SourceRecord } from "../schemas/source.js";
import { HeuristicProvider } from "../llm/heuristics.js";

/**
 * Offline harness: a local `fixture` source of job postings on disk, plus two
 * different stand-ins for the model.
 *
 * `fixtureProvider` is a **test double**. It replays canned answers regardless
 * of input, which is exactly what a test wants — deterministic, and able to
 * plant a specific fault (an invented metric) to prove the critic catches it.
 * It must never be what a user meets, because a canned résumé returned for
 * somebody else's upload is a plausible, confident lie.
 *
 * `offlineProvider` is what the console and CLI use. It does real deterministic
 * work on the real input (see `src/llm/heuristics.ts`).
 */
export const FIXTURE_SOURCE_ID = sha1("source|fixtures");

export function fixtureSource(dir = path.resolve("fixtures/jobs")): SourceRecord {
  return {
    id: FIXTURE_SOURCE_ID,
    company: "Fixtures",
    enabled: true,
    domain: null,
    career_url: dir,
    ats_type: "fixture",
    ats_slug: null,
    confidence: 1,
    status: "verified",
    reason: null,
    verified_at: new Date().toISOString(),
    health: { attempts: 0, failures: 0, last_ok_at: null, last_error: null, avg_latency_ms: 0 },
  };
}

export function installFixtures(store: Store, dir?: string): void {
  store.upsertSource(fixtureSource(dir));
}

/* ── The scripted model ───────────────────────────────────────────────────
 * Each entry is keyed by the schema name the agent asked for. Where an agent
 * is called once per job, the entry is a function of the request, so the
 * scripted answers actually vary with their input rather than being a single
 * canned blob replayed N times.
 */
/** What a user gets offline: heuristics over their actual input. */
export function offlineProvider(): HeuristicProvider {
  return new HeuristicProvider();
}

export function fixtureProvider(): ScriptedProvider {
  return new ScriptedProvider(
    new Map<string, unknown[] | ((req: ProviderRequest) => unknown)>([
      ["structured_resume", scriptedResume],
      ["task_graph", scriptedPlan],
      ["query_plan", scriptedQueryPlan],
      ["jd_analysis", scriptedJdAnalysis],
      ["rubric_verdict", scriptedRubric],
      ["edit_plan", scriptedEditPlan],
      ["evidence_bindings", scriptedBindings],
      ["tailored_resume", scriptedDraft],
      ["critique_report", scriptedCritique],
      ["harvest_fallback", [{ jobs: [] }]],
    ]),
  );
}

const scriptedResume = () => ({
  contact: {
    name: "Ehtesham Alam",
    email: "ehtesham.alam@example.com",
    phone: "+91 98765 43210",
    location: "Bengaluru, India",
    links: [{ label: "GitHub", url: "github.com/example" }],
  },
  summary:
    "Backend engineer with four years building and operating transactional services in Node.js and PostgreSQL. Comfortable owning a service from schema design through on-call.",
  experience: [
    {
      company: "Wexa Payments",
      title: "Software Development Engineer II",
      location: "Bengaluru",
      start: "Mar 2023",
      end: "present",
      bullets: [
        "Owned the settlements service handling merchant payouts, written in Node.js and TypeScript on PostgreSQL.",
        "Redesigned the ledger schema to remove a nightly reconciliation job that had become the main source of on-call pages.",
        "Introduced contract tests across four internal REST APIs, cutting integration failures found in staging.",
        "Ran the service through a migration from EC2 to ECS on AWS, including the Docker packaging and rollout plan.",
        "Part of the weekly on-call rotation for the payments platform.",
      ],
    },
    {
      company: "Trellis Logistics",
      title: "Software Engineer",
      location: "Bengaluru",
      start: "Jul 2021",
      end: "Feb 2023",
      bullets: [
        "Built the shipment tracking API in Node.js, serving carrier webhooks and the customer dashboard.",
        "Added Redis-backed caching in front of the carrier lookup path, which had been the slowest endpoint.",
        "Wrote the Terraform for the team's staging environment on AWS.",
        "Mentored two interns through their first production changes.",
      ],
    },
  ],
  skills: {
    primary: ["Node.js", "TypeScript", "PostgreSQL", "REST APIs", "AWS", "Docker"],
    secondary: ["Redis", "Terraform", "Git", "Jest"],
  },
  education: [
    {
      institution: "Visvesvaraya Technological University",
      degree: "B.E.",
      field: "Computer Science",
      start: null,
      end: "2021",
      detail: null,
    },
  ],
  projects: [
    {
      name: "pgqueue",
      description:
        "A small Postgres-backed job queue in TypeScript, used in both roles above. SKIP LOCKED, retries, dead-letter table.",
      tech: ["TypeScript", "PostgreSQL"],
      url: null,
    },
  ],
  certifications: [],
  confidence: 0.92,
  uncertainty_notes: [],
});

const scriptedPlan = () => ({
  nodes: [
    { id: "query", kind: "query_strategy", label: "Expand the brief into a search matrix", depends_on: [], note: null, limit: null, optional: false },
    { id: "discover", kind: "source_discovery", label: "Find and verify new career pages", depends_on: [], note: null, limit: null, optional: true },
    { id: "harvest", kind: "harvest", label: "Pull postings from every source", depends_on: ["query", "discover"], note: null, limit: null, optional: false },
    { id: "dedupe", kind: "dedupe", label: "Collapse duplicate postings", depends_on: ["harvest"], note: null, limit: null, optional: false },
    { id: "filter", kind: "hard_filter", label: "Apply non-negotiable constraints", depends_on: ["dedupe"], note: null, limit: null, optional: false },
    { id: "analyze", kind: "jd_analysis", label: "Structure each surviving JD", depends_on: ["filter"], note: null, limit: null, optional: false },
    { id: "prescore", kind: "prescore", label: "Vector and skill-graph shortlist", depends_on: ["analyze"], note: null, limit: null, optional: false },
    { id: "score", kind: "match_score", label: "LLM rubric over the shortlist", depends_on: ["prescore"], note: null, limit: null, optional: false },
    { id: "reconcile", kind: "reconcile", label: "Resolve disagreements", depends_on: ["score"], note: null, limit: null, optional: false },
    { id: "rank", kind: "rank", label: "Order the final results", depends_on: ["reconcile"], note: null, limit: null, optional: false },
    { id: "curate", kind: "memory_curate", label: "Commit learnings", depends_on: ["rank"], note: null, limit: null, optional: false },
  ],
  success_criteria: ["at least 3 ranked results", "every result carries an explainable score"],
  notes: ["scripted fixture plan"],
});

const scriptedQueryPlan = (req: ProviderRequest) => {
  const broadened = req.turns.some((t) => t.content.includes("BROADEN"));
  return {
    canonical_role: "Backend Engineer",
    title_variants: broadened
      ? ["Backend Engineer", "Backend Developer", "Software Engineer", "SDE II", "Member of Technical Staff", "Platform Engineer", "Full Stack Engineer"]
      : ["Backend Engineer", "Backend Developer", "Software Engineer", "SDE II", "Member of Technical Staff", "Platform Engineer"],
    adjacent_roles: broadened ? ["Infrastructure Engineer", "Site Reliability Engineer", "Full Stack Engineer"] : ["Infrastructure Engineer"],
    skill_signature: ["Node.js", "TypeScript", "PostgreSQL", "REST", "AWS", "Docker", "Redis"],
    seniority_band: broadened ? { min_years: 1, max_years: 8 } : { min_years: 3, max_years: 6 },
    exclusions: broadened ? ["Frontend"] : ["Frontend", "QA", "Support", "Sales"],
    locations: ["Bengaluru"],
    queries: [
      { source_type: "ats", q: "backend engineer node postgresql", location: "Bengaluru", remote_ok: true, rationale: "primary title plus the two strongest skill terms" },
      { source_type: "ats", q: "SDE II backend", location: "Bengaluru", remote_ok: true, rationale: "the Indian variant of the same role" },
      { source_type: "aggregator", q: "member of technical staff backend", location: null, remote_ok: true, rationale: "startup phrasing that title-only search misses" },
    ],
    confidence: 0.88,
    uncertainty_notes: [],
  };
};

/** Derived from the JD text so the fixture analyses actually differ per job. */
const scriptedJdAnalysis = (req: ProviderRequest) => {
  const text = req.turns.map((t) => t.content).join(" ");
  const has = (s: string) => new RegExp(s, "i").test(text);
  const must: Array<{ skill: string; evidence: string }> = [];
  const add = (skill: string, pattern: string) => {
    if (has(pattern)) must.push({ skill, evidence: `mentioned in the requirements: ${skill}` });
  };
  add("Node.js", "node\\.?js");
  add("TypeScript", "typescript");
  add("PostgreSQL", "postgres");
  add("AWS", "aws");
  add("Docker", "docker");
  add("REST API", "rest api");
  add("React", "react");
  add("Selenium", "selenium|playwright");

  const seniorMatch = /(\d+)\s*-\s*(\d+)\s*years/i.exec(text);
  const min = seniorMatch ? Number(seniorMatch[1]) : has("8\\+|8-12") ? 8 : 3;
  const max = seniorMatch ? Number(seniorMatch[2]) : min + 3;

  return {
    must_have: must,
    nice_to_have: has("kafka|message queue") ? [{ skill: "message queue", evidence: "listed under nice to have" }] : [],
    years_required: { min, max },
    true_seniority: min >= 8 ? "staff" : min >= 5 ? "senior" : "mid",
    implicit_requirements: has("on-?call") ? ["on-call rotation"] : [],
    red_flags: [],
    domain: has("payment|ledger|banking") ? ["fintech"] : [],
    responsibilities: text
      .split("\n")
      .filter((l) => l.trim().startsWith("-"))
      .slice(0, 6)
      .map((l) => l.replace(/^-\s*/, "").trim()),
    keywords: must.map((m) => m.skill),
    confidence: must.length >= 2 ? 0.85 : 0.5,
  };
};

/** Deliberately disagrees with the composite on one job, so the fixture run
 *  actually exercises the self-consistency reconciliation path. */
const scriptedRubric = (req: ProviderRequest) => {
  const full = req.turns.map((t) => t.content).join(" ");
  // Judge the JOB half only. The prompt also carries the candidate profile,
  // and matching against that scores every posting as a perfect fit.
  const text = full.slice(full.indexOf("\nJOB\n") >= 0 ? full.indexOf("\nJOB\n") : 0);
  const strong = /node\.?js|postgres/i.test(text) && !/frontend|qa engineer|test automation/i.test(text);
  const overqualifiedRole = /8-12 years|technical leadership/i.test(text);
  const base = overqualifiedRole ? 42 : strong ? 82 : 55;
  const disagree = /Razorpay|Senior Backend/i.test(text);

  return {
    dimensions: [
      { dimension: "core_skills", score: base + 4, reason: strong ? "Node.js, TypeScript and PostgreSQL all appear in both the resume and the JD" : "limited overlap with the stated stack" },
      { dimension: "seniority_fit", score: overqualifiedRole ? 25 : base, reason: overqualifiedRole ? "the JD wants 8-12 years and formal technical leadership; the candidate has four" : "four years sits inside the stated band" },
      { dimension: "domain_relevance", score: /payment|ledger|fintech/i.test(text) ? base + 8 : base - 10, reason: "prior work on settlements and payouts" },
      { dimension: "scope_and_impact", score: base - 5, reason: "owned a service end to end including its on-call" },
      { dimension: "location_and_mode", score: /bengaluru|remote/i.test(text) ? 95 : 40, reason: "location matches" },
    ],
    holistic: disagree ? base + 30 : base,
    matched_skills: strong ? ["Node.js", "PostgreSQL", "TypeScript", "AWS", "Docker"] : [],
    gaps: /kubernetes/i.test(text) ? ["Kubernetes"] : [],
    reasoning: [
      strong ? "The stack is a direct match and the candidate has operated what they built." : "The overlap is thin.",
    ],
    confidence: 0.8,
  };
};

const scriptedEditPlan = () => ({
  edits: [
    { kind: "rewrite_summary", target_id: "summary", intent: "Foreground ledger and payments ownership", addresses: "services that move money", priority: 1 },
    { kind: "rewrite_bullet", target_id: "exp_1_b1", intent: "Lead with PostgreSQL schema ownership", addresses: "PostgreSQL schema design", priority: 1 },
    { kind: "rewrite_bullet", target_id: "exp_1_b4", intent: "Name Docker and AWS explicitly in the migration bullet", addresses: "AWS and containerised deploys", priority: 2 },
    { kind: "surface_skill", target_id: null, intent: "Promote REST APIs into primary skills", addresses: "REST APIs consumed by partner banks", priority: 3 },
    { kind: "add_keyword", target_id: null, intent: "Add Kubernetes to skills", addresses: "Docker, ECS or Kubernetes", priority: 4 },
  ],
  missing_keywords: ["Kubernetes", "Kafka"],
  unaddressable_gaps: ["Kubernetes in production"],
  confidence: 0.83,
});

const scriptedBindings = () => ({
  bindings: [
    { edit_id: "edit_1", bound: true, source_ids: ["summary"], quotes: ["Backend engineer with four years building and operating transactional services"], unbound_reason: null, confidence: 0.9 },
    { edit_id: "edit_2", bound: true, source_ids: ["exp_1_b2"], quotes: ["Redesigned the ledger schema"], unbound_reason: null, confidence: 0.95 },
    { edit_id: "edit_3", bound: true, source_ids: ["exp_1_b4"], quotes: ["migration from EC2 to ECS on AWS"], unbound_reason: null, confidence: 0.92 },
    { edit_id: "edit_4", bound: true, source_ids: ["exp_1_b3"], quotes: ["contract tests across four internal REST APIs"], unbound_reason: null, confidence: 0.88 },
    // Deliberately unbound: the resume never mentions Kubernetes. This is the
    // case the whole Evidence Binding step exists for.
    { edit_id: "edit_5", bound: false, source_ids: [], quotes: [], unbound_reason: "the resume never mentions Kubernetes", confidence: 0.95 },
  ],
});

/** First call plants an invented metric; the revision removes it. That makes
 *  the fixture run exercise the reject -> revise -> pass loop for real. */
const scriptedDraft = (req: ProviderRequest) => {
  const isRevision = req.turns.some((t) => t.content.includes("REVISION"));
  const firstBullet = isRevision
    ? "Owned the settlements service handling merchant payouts, built on Node.js and TypeScript over PostgreSQL."
    : "Owned the settlements service handling merchant payouts, cutting payout latency by 40% on Node.js and PostgreSQL.";

  return {
    summary:
      "Backend engineer with four years building and operating transactional services in Node.js and PostgreSQL, including a merchant settlements ledger owned from schema design through on-call.",
    experience: [
      {
        id: "exp_1",
        company: "Wexa Payments",
        title: "Software Development Engineer II",
        location: "Bengaluru",
        start: "2023-03",
        end: "present",
        bullets: [
          firstBullet,
          "Redesigned the ledger schema to remove a nightly reconciliation job that had been the main source of on-call pages.",
          "Introduced contract tests across four internal REST APIs, cutting integration failures found in staging.",
          "Migrated the service from EC2 to ECS on AWS, owning the Docker packaging and the rollout plan.",
          "Part of the weekly on-call rotation for the payments platform.",
        ],
        source_ids: ["exp_1_b1", "exp_1_b2", "exp_1_b3", "exp_1_b4", "exp_1_b5"],
      },
      {
        id: "exp_2",
        company: "Trellis Logistics",
        title: "Software Engineer",
        location: "Bengaluru",
        start: "2021-07",
        end: "2023-02",
        bullets: [
          "Built the shipment tracking API in Node.js, serving carrier webhooks and the customer dashboard.",
          "Added Redis-backed caching in front of the carrier lookup path, previously the slowest endpoint.",
          "Wrote the Terraform for the team's staging environment on AWS.",
        ],
        source_ids: ["exp_2_b1", "exp_2_b2", "exp_2_b3"],
      },
    ],
    skills: {
      primary: ["Node.js", "TypeScript", "PostgreSQL", "REST APIs", "AWS", "Docker"],
      secondary: ["Redis", "Terraform", "Jest", "Git"],
    },
    projects: [
      {
        name: "pgqueue",
        description: "A Postgres-backed job queue in TypeScript using SKIP LOCKED, with retries and a dead-letter table.",
        tech: ["TypeScript", "PostgreSQL"],
        source_ids: ["prj_1"],
      },
    ],
    applied_edit_ids: isRevision ? ["edit_1", "edit_2", "edit_3", "edit_4"] : ["edit_1", "edit_2", "edit_3", "edit_4"],
  };
};

const scriptedCritique = (req: ProviderRequest) => {
  const draftHasInventedMetric = req.turns.some((t) => t.content.includes("by 40%"));
  return draftHasInventedMetric
    ? {
        verdict: "reject",
        findings: [
          {
            category: "invented_metric",
            severity: "reject",
            quote: "cutting payout latency by 40%",
            explanation: "the original resume contains no latency figure for this work",
            location: "experience[0].bullets[0]",
            suggested_fix: "state the ownership without the number",
          },
        ],
        confidence: 0.9,
      }
    : { verdict: "pass", findings: [], confidence: 0.86 };
};
