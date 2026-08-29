import { z } from "zod";
import { QueryPlan } from "../schemas/query.js";
import { expandTitle, normalizeSkills } from "../tools/skills.js";
import { defaultEmbedder } from "../tools/embed.js";
import { type AgentContext, type AgentInput, type AgentOutput, emptyOutput } from "./types.js";

/**
 * §2.2 Query Strategist — the agent that fixes "searching by title alone
 * returns generic results". Titles in India especially are noise: "SDE" and
 * "Member of Technical Staff" are the same job. Title x skill signature x
 * seniority band is what makes results specific.
 */
const SYSTEM = `You expand a job seeker's intent into a search matrix for job boards.

You are given a brief, a candidate profile, and synonym/neighbourhood evidence
already retrieved from long-term memory. Use that evidence — it comes from titles
this system has actually seen — rather than inventing variants.

Produce:
- canonical_role: the one role name a recruiter would recognise.
- title_variants: strings that appear verbatim in real postings for this role,
  including regional and company-specific forms (SDE II, Member of Technical Staff,
  Software Development Engineer). Not paraphrases; things people literally post.
- adjacent_roles: nearby roles worth surfacing, where the candidate would be a
  credible applicant. Empty is a valid answer.
- skill_signature: the technologies that co-occur with this role in postings. This is
  what makes results specific, so favour concrete tools over abstractions.
- seniority_band: years of experience the candidate should target, from the profile.
- exclusions: terms that indicate a posting is the wrong role entirely.
- queries: one entry per board family. Board search syntax is plain keywords; keep
  each q short (2-6 terms). Give every query a one-line rationale.

If the brief is vague, prefer breadth in title_variants and narrowness in exclusions.
Set confidence below 0.6 when the brief does not determine the role.`;

const ModelQueryPlan = z.object({
  canonical_role: z.string(),
  title_variants: z.array(z.string()),
  adjacent_roles: z.array(z.string()),
  skill_signature: z.array(z.string()),
  seniority_band: z.object({ min_years: z.number().nullable(), max_years: z.number().nullable() }),
  exclusions: z.array(z.string()),
  locations: z.array(z.string()),
  queries: z.array(
    z.object({
      source_type: z.enum(["ats", "aggregator", "company_page", "board"]),
      q: z.string(),
      location: z.string().nullable(),
      remote_ok: z.boolean(),
      rationale: z.string(),
    }),
  ),
  confidence: z.number().min(0).max(1),
  uncertainty_notes: z.array(z.string()),
});

export async function queryStrategist(ctx: AgentContext, input: AgentInput): Promise<AgentOutput> {
  const out = emptyOutput();
  const { board, params } = input;
  const profile = board.profile;
  const prefs = board.preferences;

  // Tool call 1: synonym graph lookup over long-term memory.
  const seedTitles = [...(profile?.canonical_titles ?? []), ...guessTitles(board.brief)];
  const synonymEvidence = [...new Set(seedTitles.flatMap((t) => expandTitle(ctx.store, t)))];

  // Tool call 2: embedding neighbourhood over historical job titles the
  // registry has actually seen. Empty on a cold registry, which is fine —
  // the agent falls back on the brief alone and says so.
  const neighbourhood = ctx.store
    .searchEmbeddings("title", ctx.embedder.embed(`${board.brief} ${seedTitles.join(" ")}`), 15)
    .filter((h) => h.score > 0.25)
    .map((h) => h.label);

  const broaden = params.broaden;
  const inputText = [
    `Brief: ${board.brief}`,
    profile
      ? `Profile: ${profile.total_years} years; titles held: ${profile.canonical_titles.join(" / ")}; ` +
        `skills: ${profile.top_skills.join(", ")}; locations: ${profile.locations.join(", ") || "unstated"}`
      : "Profile: none supplied",
    `Synonym graph says these are the same role: ${synonymEvidence.join(", ") || "(nothing in memory yet)"}`,
    `Titles seen in postings nearby: ${neighbourhood.join(", ") || "(registry is cold)"}`,
    prefs.locations.length
      ? `WANTED LOCATIONS (stated by the candidate, authoritative): ${prefs.locations.join(", ")}` +
        `${prefs.remote_ok ? " — remote is acceptable" : " — on-site only"}`
      : `WANTED LOCATIONS: not stated — do not infer one from the résumé; leave locations empty` +
        `${prefs.remote_ok ? " and treat remote as acceptable" : ""}`,
    broaden
      ? `BROADEN: the previous matrix returned too few results (${params.note ?? "reason unrecorded"}). ` +
        `Widen title_variants and adjacent_roles, relax the seniority band by two years on each side, ` +
        `and cut exclusions to the ones that are genuinely disqualifying.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const res = await ctx.llm.structured({
    agent: "query_strategist",
    // Originating the matrix is the judgment call this agent exists for, and
    // measurably needs the top tier: on a support résumé, opus produced the
    // Indian-market vocabulary (Telecaller, Voice Process, CRE, BPO Executive)
    // that the cheap tier missed entirely. Widening an existing matrix is a
    // smaller job, so a broadening pass runs a tier down.
    tier: broaden ? "mid" : "strong",
    systemPrompt: SYSTEM,
    input: inputText,
    schema: ModelQueryPlan,
    schemaName: "query_plan",
    maxTokens: 3000,
    signal: ctx.signal,
  });
  out.usage = res.usage;
  out.model = res.model;
  out.llmCalls = 1;
  out.attempts = res.attempts;
  out.validationFailures = res.validationFailures;

  const v = res.value;
  const plan = QueryPlan.parse({
    canonical_role: v.canonical_role,
    // Deterministic union with what memory already knows: the model can add
    // variants, never lose the ones the system has confirmed.
    title_variants: dedupeStrings([...v.title_variants, ...synonymEvidence]).slice(0, 12),
    adjacent_roles: dedupeStrings(v.adjacent_roles).slice(0, 8),
    skill_signature: normalizeSkills(ctx.store, v.skill_signature).slice(0, 20),
    seniority_band: { min: v.seniority_band.min_years, max: v.seniority_band.max_years },
    exclusions: dedupeStrings(v.exclusions),
    // Enforced in code, not merely asked for in the prompt: a stated
    // preference is not something the model gets to reinterpret.
    locations: prefs.locations.length ? dedupeStrings(prefs.locations) : [],
    queries: v.queries.slice(0, 40).map((q) => ({ ...q, remote_ok: prefs.remote_ok })),
    confidence: v.confidence,
    uncertainty_notes: v.uncertainty_notes,
  });

  // Feed the neighbourhood index so the next run's lookup is better than this
  // one's — §2.9's compounding, applied to titles.
  for (const t of plan.title_variants) {
    ctx.store.putEmbedding("title", t.toLowerCase(), t, defaultEmbedder.embed(t));
  }
  for (const t of plan.title_variants) {
    if (t.toLowerCase() !== plan.canonical_role.toLowerCase()) {
      ctx.store.putTitleSynonym(t, plan.canonical_role, 0.6, false);
    }
  }

  out.board = { query_plan: plan };
  out.summary =
    `${plan.title_variants.length} title variants, ${plan.skill_signature.length} skill terms, ` +
    `${plan.exclusions.length} exclusions, ${plan.queries.length} queries` +
    (broaden ? " (broadened)" : "");
  return out;
}

function dedupeStrings(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const k = x.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x.trim());
  }
  return out;
}

/**
 * Seed titles for the synonym lookup, pulled from the brief.
 *
 * This used to fall back to a hardcoded "software engineer" when the brief
 * matched none of its known roles — which quietly injected engineering titles
 * into every non-engineering search. There is no sensible default job; when
 * the brief names no role, the profile's own titles are the seed, and if there
 * are none either, the lookup simply has nothing to expand.
 */
function guessTitles(brief: string): string[] {
  const b = brief.toLowerCase();
  return KNOWN_ROLES.filter((role) => b.includes(role));
}

/** Roles common enough to be worth spotting in a free-text brief. Not a
 *  taxonomy — just a shortlist that saves a synonym lookup from starting cold. */
const KNOWN_ROLES = [
  "customer support", "customer service", "customer success", "technical support",
  "telecaller", "telecalling", "inside sales", "business development", "operations executive",
  "backend engineer", "frontend engineer", "full stack engineer", "software engineer",
  "data engineer", "data analyst", "data scientist", "machine learning engineer",
  "site reliability engineer", "devops engineer", "platform engineer", "mobile engineer",
  "android engineer", "ios engineer", "security engineer", "qa engineer", "quality analyst",
  "product manager", "engineering manager", "project manager", "business analyst",
  "accountant", "recruiter", "human resources", "content writer", "digital marketing",
  "graphic designer", "ui designer", "ux designer",
];
