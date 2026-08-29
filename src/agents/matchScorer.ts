import { z } from "zod";
import pLimit from "p-limit";
import { env } from "../config/env.js";
import { MatchReport, RubricVerdict } from "../schemas/match.js";
import type { MatchDimension } from "../schemas/match.js";
import type { JDAnalysis, JobPosting } from "../schemas/job.js";
import type { StructuredResume } from "../schemas/profile.js";
import type { QueryPlan } from "../schemas/query.js";
import { cosineSim } from "../tools/embed.js";
import { seniorityYears, skillOverlap, titleSimilarity } from "../tools/skills.js";
import { totalYears } from "./resumeParser.js";
import { addUsage, emptyUsage } from "../llm/client.js";
import { type AgentContext, type AgentInput, type AgentOutput, emptyOutput } from "./types.js";
import type { PreScore } from "../state/blackboard.js";

/* ── The funnel (§2.6) ─────────────────────────────────────────────────────
 * 1. hard filters (code)            — filters.ts
 * 2. vector similarity (code)       — here
 * 3. skill graph overlap (code)     — here
 * 4. LLM rubric, top ~30 only       — here
 * 5. self-consistency reconciliation— here
 *
 * Legs 2 and 3 are the reason this is affordable: 200 jobs cost nothing to
 * prescore, and only the survivors are worth a model call.
 */

const WEIGHTS = { skill: 0.32, vector: 0.2, title: 0.28, seniority: 0.2 } as const;

/* ── Who is searching ──────────────────────────────────────────────────────
 *
 * Every leg of the funnel below needs the same four things about the person:
 * titles they are plausible for, skills they bring, prose to embed, and years
 * of experience. A résumé supplies all four. A brief supplies three.
 *
 * Requiring the résumé made the difference fatal: a search for "customer
 * support in Bengaluru" harvested four thousand postings, filtered them to
 * thirteen good ones, and then returned nothing at all, because scoring
 * refused to run. Thirteen relevant jobs the user could not see is a worse
 * answer than thirteen jobs ranked on less information.
 *
 * So the signal is derived from whatever exists, and carries its own
 * provenance so the scores can be labelled for what they actually measure.
 */
export interface CandidateSignal {
  /** Titles a posting's title is compared against. */
  titles: string[];
  /** Skills overlapped against the JD's requirements. */
  skills: string[];
  /** Prose embedded for vector similarity. */
  sections: string[];
  /** Null when nobody has said — which is not the same as zero. */
  years: number | null;
  basis: "resume" | "brief";
}

/**
 * The query plan is the right brief-side source: the query strategist already
 * turned the brief into a canonical role, title variants and a skill
 * signature, and the hard filter has already been trusting them. Reading them
 * back here invents nothing that the search was not already built on.
 */
export function candidateSignal(board: {
  resume: StructuredResume | null;
  query_plan: QueryPlan | null;
  brief: string;
}): CandidateSignal | null {
  if (board.resume) {
    const r = board.resume;
    return {
      titles: [...new Set(r.experience.map((e) => e.title).filter(Boolean))],
      skills: [...r.skills.primary, ...r.skills.secondary],
      sections: resumeSections(r),
      years: totalYears(r),
      basis: "resume",
    };
  }

  const plan = board.query_plan;
  if (!plan) return null;

  const titles = [...new Set([plan.canonical_role, ...plan.title_variants, ...plan.adjacent_roles].filter(Boolean))];
  const sections = [
    board.brief,
    titles.join(", "),
    plan.skill_signature.join(", "),
  ].filter((s) => s.trim().length > 20);

  return {
    titles,
    skills: plan.skill_signature,
    sections,
    // Deliberately null even though the plan carries a seniority band: that
    // band is the strategist's guess at what the ROLE needs, not a claim about
    // the candidate. Scoring someone against a band inferred from the job they
    // asked for would grade them against themselves.
    years: null,
    basis: "brief",
  };
}

/**
 * Weights for the legs that are actually available. With no résumé there is no
 * seniority signal, so its share is redistributed across the other three
 * rather than scored as a zero — which would have penalised every job equally
 * and, worse, dragged every composite down by a fifth.
 */
function weightsFor(signal: CandidateSignal): { skill: number; vector: number; title: number; seniority: number } {
  if (signal.years !== null) return { ...WEIGHTS };
  const kept = WEIGHTS.skill + WEIGHTS.vector + WEIGHTS.title;
  return {
    skill: WEIGHTS.skill / kept,
    vector: WEIGHTS.vector / kept,
    title: WEIGHTS.title / kept,
    seniority: 0,
  };
}

export function resumeSections(resume: StructuredResume): string[] {
  const out: string[] = [];
  if (resume.summary) out.push(resume.summary);
  out.push([...resume.skills.primary, ...resume.skills.secondary].join(", "));
  for (const e of resume.experience) out.push(`${e.title} at ${e.company}. ${e.bullets.map((b) => b.text).join(" ")}`);
  for (const p of resume.projects) out.push(`${p.name}. ${p.description} ${p.tech.join(", ")}`);
  return out.filter((s) => s.trim().length > 20);
}

export function jdSections(job: JobPosting, analysis: JDAnalysis | null): string[] {
  const out: string[] = [`${job.title}. ${job.department ?? ""}`];
  if (analysis) {
    if (analysis.must_have.length) out.push(analysis.must_have.map((m) => m.skill).join(", "));
    out.push(...analysis.responsibilities);
    if (analysis.domain.length) out.push(analysis.domain.join(", "));
  }
  // Chunked description as a floor, so a missing analysis still scores.
  const text = job.description_text;
  for (let i = 0; i < text.length && i < 12_000; i += 1500) out.push(text.slice(i, i + 1500));
  return out.filter((s) => s.trim().length > 20);
}

/**
 * Asymmetric coverage: for each JD section, how well is it covered by the best
 * matching resume section. Averaging pairwise similarity instead would let a
 * long resume dilute a strong match.
 */
export function sectionSimilarity(ctx: AgentContext, resumeSecs: string[], jdSecs: string[]): number {
  if (resumeSecs.length === 0 || jdSecs.length === 0) return 0;
  const rv = resumeSecs.map((s) => ctx.embedder.embed(s));
  let total = 0;
  for (const jd of jdSecs) {
    const v = ctx.embedder.embed(jd);
    let best = 0;
    for (const r of rv) best = Math.max(best, cosineSim(v, r));
    total += best;
  }
  return total / jdSecs.length;
}

/** How far the candidate sits from the role's band; 0 is a perfect fit. */
export function seniorityDelta(candidateYears: number, analysis: JDAnalysis | null): number {
  if (!analysis) return 0;
  const min = analysis.years_required.min ?? Math.max(0, seniorityYears(analysis.true_seniority) - 2);
  const max = analysis.years_required.max ?? seniorityYears(analysis.true_seniority) + 3;
  if (candidateYears < min) return candidateYears - min; // negative: underqualified
  if (candidateYears > max) return candidateYears - max; // positive: overqualified
  return 0;
}

function seniorityScore(delta: number): number {
  // Underqualification is penalised harder than overqualification: a two-year
  // gap below the band gets you screened out; two years above rarely does.
  const penalty = delta < 0 ? Math.abs(delta) * 0.18 : delta * 0.09;
  return Math.max(0, 1 - penalty);
}

/**
 * A free ordering of candidate jobs, using only signals that need no JD
 * analysis: how close the posting's title is to one the candidate has held,
 * and how close its text is to their résumé.
 *
 * This is what lets the expensive half of the funnel be bounded. Analysing
 * every posting that clears the filters costs the same whether 12 survive or
 * 300, and on a large registry that is ~86% of a search's bill for jobs that
 * were never going to reach the rubric.
 */
export function cheapRank(ctx: AgentContext, signal: CandidateSignal, jobIds: string[]): string[] {
  const candidateVec = ctx.embedder.embed(signal.sections.join(" ").slice(0, 12_000));

  return [...jobIds]
    .map((id) => {
      const job = ctx.store.getJob(id);
      if (!job) return { id, score: -1 };
      const title = titleSimilarity(ctx.store, signal.titles, job.title);
      const text = cosineSim(candidateVec, ctx.embedder.embed(job.description_text.slice(0, 6_000)));
      return { id, score: 0.6 * title + 0.4 * text };
    })
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.id);
}

export async function prescore(ctx: AgentContext, input: AgentInput): Promise<AgentOutput> {
  const out = emptyOutput();
  const signal = candidateSignal(input.board);
  if (!signal) {
    out.summary = "neither a resume nor a query plan; nothing to score against";
    out.degraded = "no candidate signal";
    return out;
  }
  if (signal.basis === "brief") {
    // Not a failure — a narrower question, and the results say which one was
    // answered rather than presenting brief relevance as candidate fit.
    out.degraded = "no resume: ranked on brief relevance, not candidate fit";
  }

  const weights = weightsFor(signal);
  const candidateSecs = signal.sections;
  const candidateSkills = signal.skills;
  const candidateTitles = signal.titles;
  const years = signal.years;

  // Every job that survived the filters, not only those that got a JD
  // analysis. Analysis enriches a score — skill overlap and the seniority band
  // come from it — but title similarity and embedding similarity do not need
  // it, and a job whose analysis failed or was skipped for budget should still
  // be rankable rather than silently vanishing from the results.
  const candidates =
    input.board.filtered_job_ids.length > 0 ? input.board.filtered_job_ids : input.board.analyzed_job_ids;

  const scores: PreScore[] = [];
  let withAnalysis = 0;
  for (const jobId of candidates) {
    const job = ctx.store.getJob(jobId);
    if (!job) continue;
    const analysis = ctx.store.getAnalysis(jobId);
    if (analysis) withAnalysis++;

    const vector = sectionSimilarity(ctx, candidateSecs, jdSections(job, analysis));
    const overlap = skillOverlap(
      ctx.store,
      candidateSkills,
      analysis?.must_have.map((m) => m.skill) ?? [],
      analysis?.nice_to_have.map((m) => m.skill) ?? [],
    );
    // With no stated experience there is no distance to measure; 0 reads as
    // "in band", and the leg carries no weight anyway.
    const delta = years === null ? 0 : seniorityDelta(years, analysis);
    const title = titleSimilarity(ctx.store, candidateTitles, job.title);

    scores.push({
      job_id: jobId,
      vector_similarity: round(vector),
      skill_overlap: round(overlap.score),
      title_similarity: round(title),
      seniority_delta: round(delta),
      composite: round(
        weights.skill * overlap.score +
          weights.vector * vector +
          weights.title * title +
          weights.seniority * seniorityScore(delta),
      ),
      matched_skills: overlap.matched,
      missing_skills: overlap.missing,
    });

    ctx.store.putEmbedding("job", jobId, `${job.title} — ${job.company}`, ctx.embedder.embed(job.description_text.slice(0, 8000)));
  }

  scores.sort((a, b) => b.composite - a.composite);
  const topK = input.params.limit ?? env.rubricTopK;

  out.board = { prescores: scores.slice(0, topK) };
  const against = signal.basis === "resume" ? "resume" : "brief (no resume supplied)";
  out.summary =
    `${scores.length} prescored against ${against} (${withAnalysis} with a JD analysis) → ` +
    `top ${Math.min(topK, scores.length)} (best composite ${scores[0]?.composite ?? 0})`;
  return out;
}

/* ── Leg 4: the rubric ──────────────────────────────────────────────────── */

const SYSTEM_RUBRIC = `You score one candidate against one job and explain the score.

Dimensions, each 0-100:
- core_skills: does the candidate demonstrably have what the JD requires?
- seniority_fit: is the scope of their work the scope this role needs?
- domain_relevance: have they worked on this kind of product or problem?
- scope_and_impact: is the size of what they have owned comparable?
- location_and_mode: does the working arrangement actually work?

Each dimension needs a one-line reason citing something concrete from the resume
or the JD. "Good match" is not a reason.

Also give a holistic score: your own overall read, formed independently of the
dimensions. Do not average the dimensions — this number exists precisely so
that disagreement with the computed composite can be detected.

Be calibrated. 90+ means a recruiter would call this week. 50 means plausible
but unremarkable. Below 30 means do not apply. Most candidates are not 85s.`;

const ModelRubric = z.object({
  dimensions: z.array(
    z.object({
      dimension: z.enum(["core_skills", "seniority_fit", "domain_relevance", "scope_and_impact", "location_and_mode"]),
      score: z.number().min(0).max(100),
      reason: z.string(),
    }),
  ),
  holistic: z.number().min(0).max(100),
  matched_skills: z.array(z.string()),
  gaps: z.array(z.string()),
  reasoning: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});

const DIMENSION_WEIGHTS: Record<z.infer<typeof MatchDimension>, number> = {
  core_skills: 0.35,
  seniority_fit: 0.2,
  domain_relevance: 0.2,
  scope_and_impact: 0.15,
  location_and_mode: 0.1,
};

export function rubricScore(v: RubricVerdict): number {
  let sum = 0;
  let weight = 0;
  for (const d of v.dimensions) {
    const w = DIMENSION_WEIGHTS[d.dimension] ?? 0;
    sum += d.score * w;
    weight += w;
  }
  return weight === 0 ? 0 : sum / weight;
}

export async function matchScore(ctx: AgentContext, input: AgentInput): Promise<AgentOutput> {
  const out = emptyOutput();
  const resume = input.board.resume;
  if (input.board.prescores.length === 0) {
    out.summary = "nothing to score";
    return out;
  }

  // The rubric scores a person against a role. With no résumé there is no
  // person to score, and asking the model to invent one is exactly the
  // fabrication this system exists to avoid. The deterministic legs still
  // ranked the postings, so those results stand on their own — labelled as
  // relevance to the brief rather than fit to a candidate.
  if (!resume) {
    out.board = { matches: input.board.prescores.map(briefRelevanceReport) };
    out.summary =
      `${input.board.prescores.length} ranked on brief relevance; ` +
      `the rubric needs a résumé and was skipped`;
    out.degraded = "no resume: relevance only, no candidate fit scoring";
    return out;
  }

  const profileText = compactProfile(resume);
  const limit = pLimit(5);
  let usage = emptyUsage();
  let model: string | null = null;
  let calls = 0;
  const reports: MatchReport[] = [];

  await Promise.all(
    input.board.prescores.map((pre) =>
      limit(async () => {
        const job = ctx.store.getJob(pre.job_id);
        if (!job) return;
        const analysis = ctx.store.getAnalysis(pre.job_id);

        // Budget breach mid-fan-out: emit the deterministic report rather than
        // dropping the job. Partial results, honestly labelled (§4).
        if (ctx.remaining().llm_calls <= 0 || ctx.remaining().cost_usd <= 0) {
          reports.push(deterministicReport(pre));
          return;
        }

        try {
          const res = await ctx.llm.structured({
            agent: "match_scorer",
            tier: "mid",
            systemPrompt: SYSTEM_RUBRIC,
            input: rubricInput(profileText, job, analysis, pre),
            schema: ModelRubric,
            schemaName: "rubric_verdict",
            maxTokens: 2000,
            signal: ctx.signal,
          });
          usage = addUsage(usage, res.usage);
          model = res.model;
          calls++;

          const verdict = RubricVerdict.parse(res.value);
          reports.push(assemble(pre, verdict));
        } catch {
          reports.push(deterministicReport(pre));
        }
      }),
    ),
  );

  out.usage = usage;
  out.model = model;
  out.llmCalls = calls;
  out.board = { matches: reports };
  out.summary = `${calls} rubric scores, ${reports.length - calls} fell back to deterministic`;
  return out;
}

function assemble(pre: PreScore, v: RubricVerdict): MatchReport {
  const rubric = rubricScore(v);
  const deterministic = pre.composite * 100;
  // The composite is mostly the rubric, anchored by the deterministic legs so
  // a generous model cannot float a job with no skill overlap to the top.
  const composite = 0.65 * rubric + 0.35 * deterministic;

  return MatchReport.parse({
    job_id: pre.job_id,
    overall: Math.round(composite),
    holistic: v.holistic,
    dimensions: v.dimensions,
    matched_skills: v.matched_skills.length ? v.matched_skills : pre.matched_skills,
    // Gaps are the requirements the skill graph could NOT match — falling back
    // to the full must-have list would report every requirement as a gap.
    gaps: v.gaps.length ? v.gaps : pre.missing_skills.slice(0, 6),
    reasoning: v.reasoning,
    deterministic: {
      vector_similarity: pre.vector_similarity,
      skill_overlap: pre.skill_overlap,
      title_similarity: pre.title_similarity,
      seniority_delta: pre.seniority_delta,
      hard_filters_passed: true,
    },
    reconciliation: null,
    scored_by: "rubric",
    confidence: v.confidence,
  });
}

/**
 * A posting's relevance to the brief, with no claim about the candidate.
 * Confidence is capped low on purpose: this is a real answer to a smaller
 * question, and the number should not read like a considered match.
 */
function briefRelevanceReport(pre: PreScore): MatchReport {
  return MatchReport.parse({
    job_id: pre.job_id,
    overall: Math.round(pre.composite * 100),
    holistic: null,
    dimensions: [],
    matched_skills: pre.matched_skills,
    gaps: [],
    reasoning: [
      "Ranked on how well the posting matches your brief — title, required skills and description.",
      "No résumé was supplied, so this is not a measure of your fit. Upload one for scored fit and tailoring.",
    ],
    deterministic: {
      vector_similarity: pre.vector_similarity,
      skill_overlap: pre.skill_overlap,
      title_similarity: pre.title_similarity,
      seniority_delta: pre.seniority_delta,
      hard_filters_passed: true,
    },
    reconciliation: null,
    scored_by: "brief_relevance",
    confidence: 0.3,
  });
}

function deterministicReport(pre: PreScore): MatchReport {
  return MatchReport.parse({
    job_id: pre.job_id,
    overall: Math.round(pre.composite * 100),
    holistic: null,
    dimensions: [],
    matched_skills: pre.matched_skills,
    gaps: pre.missing_skills.slice(0, 6),
    reasoning: ["Scored without the rubric: budget exhausted or the rubric call failed."],
    deterministic: {
      vector_similarity: pre.vector_similarity,
      skill_overlap: pre.skill_overlap,
      title_similarity: pre.title_similarity,
      seniority_delta: pre.seniority_delta,
      hard_filters_passed: true,
    },
    reconciliation: null,
    scored_by: "deterministic",
    // A score with no rubric behind it should not present as certain.
    confidence: 0.35,
  });
}

/* ── Leg 5: self-consistency reconciliation ─────────────────────────────── */

const SYSTEM_RECONCILE = `Two scores for the same candidate-job pair disagree.

One is a composite of a weighted rubric and deterministic signals (skill-graph
overlap, embedding similarity, seniority distance). The other is a holistic read.

Decide which is closer to the truth and why. You may land between them, but say
what the other score was picking up on that yours was not. Return the same
structure as before, with the dimensions corrected where the disagreement
showed they were wrong.`;

export async function reconcile(ctx: AgentContext, input: AgentInput): Promise<AgentOutput> {
  const out = emptyOutput();
  const threshold = env.reconcileThreshold;
  const resume = input.board.resume;
  if (!resume) {
    out.summary = "brief-relevance scores have no rubric to disagree with; reconciliation skipped";
    return out;
  }

  const profileText = compactProfile(resume);
  const updated: MatchReport[] = [];
  let usage = emptyUsage();
  let model: string | null = null;
  let calls = 0;
  let flagged = 0;

  for (const report of input.board.matches) {
    const holistic = holisticOf(report);
    if (report.scored_by !== "rubric" || holistic === null || Math.abs(report.overall - holistic) <= threshold) {
      updated.push(report);
      continue;
    }
    flagged++;

    if (ctx.remaining().llm_calls <= 0) {
      // Cannot reconcile: split the difference and say so, rather than
      // silently keeping a score we have reason to distrust.
      updated.push({
        ...report,
        overall: Math.round((report.overall + holistic) / 2),
        reconciliation: {
          composite_before: report.overall,
          holistic_before: holistic,
          resolved: Math.round((report.overall + holistic) / 2),
          note: "Budget exhausted before reconciliation; midpoint taken and flagged.",
        },
        confidence: Math.min(report.confidence, 0.5),
        scored_by: "rubric+reconciled",
      });
      continue;
    }

    const job = ctx.store.getJob(report.job_id);
    const analysis = ctx.store.getAnalysis(report.job_id);
    if (!job) {
      updated.push(report);
      continue;
    }

    try {
      const res = await ctx.llm.structured({
        agent: "match_reconciler",
        tier: "mid",
        systemPrompt: SYSTEM_RECONCILE,
        input:
          `${rubricInput(profileText, job, analysis, null)}\n\n` +
          `Composite score: ${report.overall}\nYour earlier holistic score: ${holistic}\n` +
          `Dimension scores you gave: ${report.dimensions.map((d) => `${d.dimension}=${d.score}`).join(", ")}\n` +
          `Deterministic signals: skill overlap ${report.deterministic.skill_overlap}, ` +
          `embedding similarity ${report.deterministic.vector_similarity}, ` +
          `seniority delta ${report.deterministic.seniority_delta} years`,
        schema: ModelRubric,
        schemaName: "rubric_verdict",
        maxTokens: 2000,
        signal: ctx.signal,
      });
      usage = addUsage(usage, res.usage);
      model = res.model;
      calls++;

      const v = RubricVerdict.parse(res.value);
      const resolved = Math.round(0.65 * rubricScore(v) + 0.35 * v.holistic);
      updated.push({
        ...report,
        overall: resolved,
        holistic: v.holistic,
        dimensions: v.dimensions,
        reasoning: v.reasoning,
        reconciliation: {
          composite_before: report.overall,
          holistic_before: holistic,
          resolved,
          note: v.reasoning[0] ?? "reconciled",
        },
        confidence: v.confidence,
        scored_by: "rubric+reconciled",
      });
    } catch {
      updated.push(report);
    }
  }

  out.usage = usage;
  out.model = model;
  out.llmCalls = calls;
  // The blackboard upserts `matches` by job_id, so rewriting a report in place
  // is a plain assignment — no duplicate entries, no ordering games.
  out.board = { matches: updated };
  out.summary = `${flagged} jobs disagreed by more than ${threshold} points, ${calls} re-scored`;
  return out;
}

/** The rubric's independent verdict, carried on the report for exactly this. */
function holisticOf(report: MatchReport): number | null {
  return report.holistic;
}

function compactProfile(resume: StructuredResume): string {
  return [
    resume.summary ? `Summary: ${resume.summary}` : "",
    `Skills: ${[...resume.skills.primary, ...resume.skills.secondary].join(", ")}`,
    `Experience (${totalYears(resume).toFixed(1)} years total):`,
    ...resume.experience.map(
      (e) => `- ${e.title}, ${e.company} (${e.start} – ${e.end})\n  ${e.bullets.map((b) => b.text).join("\n  ")}`,
    ),
    resume.projects.length ? `Projects: ${resume.projects.map((p) => `${p.name} (${p.tech.join(", ")})`).join("; ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function rubricInput(profileText: string, job: JobPosting, analysis: JDAnalysis | null, pre: PreScore | null): string {
  return [
    `CANDIDATE\n${profileText}`,
    `\nJOB\n${job.title} at ${job.company} — ${job.location ?? "location unstated"} (${job.work_mode})`,
    analysis
      ? `Required: ${analysis.must_have.map((m) => m.skill).join(", ") || "unstated"}\n` +
        `Preferred: ${analysis.nice_to_have.map((m) => m.skill).join(", ") || "none"}\n` +
        `Years: ${analysis.years_required.min ?? "?"}–${analysis.years_required.max ?? "?"}; true seniority: ${analysis.true_seniority}\n` +
        `Responsibilities: ${analysis.responsibilities.slice(0, 8).join("; ")}`
      : `Description:\n${job.description_text.slice(0, 6000)}`,
    pre
      ? `\nDeterministic signals (already computed, do not recompute): skill-graph overlap ${pre.skill_overlap}, ` +
        `embedding similarity ${pre.vector_similarity}, title similarity ${pre.title_similarity}, ` +
        `seniority delta ${pre.seniority_delta} years`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
