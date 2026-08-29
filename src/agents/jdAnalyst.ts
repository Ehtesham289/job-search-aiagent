import { z } from "zod";
import pLimit from "p-limit";
import { env } from "../config/env.js";
import { JDAnalysis } from "../schemas/job.js";
import { normalizeSkills } from "../tools/skills.js";
import { addUsage, emptyUsage } from "../llm/client.js";
import { candidateSignal, cheapRank } from "./matchScorer.js";
import { type AgentContext, type AgentInput, type AgentOutput, emptyOutput } from "./types.js";

/**
 * §2.5 JD Analyst. Extraction, not reasoning — cheap tier, high volume, and
 * cached forever on the job record. A second run over the same posting costs
 * nothing.
 */
const SYSTEM = `You convert a job description into structured requirements. You are an
extractor: every field must be traceable to the text you were given.

- must_have: requirements the JD states as required. Each needs \`evidence\`: a short
  verbatim quote from the JD. No quote, no entry.
- nice_to_have: preferred/bonus requirements, same evidence rule.
- years_required: the explicit range if stated, otherwise nulls. Do not infer from seniority.
- true_seniority: what the role actually is, judged from scope and responsibilities —
  not from the title. A "Senior Engineer" posting asking for 2 years is mid.
- implicit_requirements: expectations the JD implies without stating, e.g. on-call
  rotation, startup pace, heavy stakeholder management.
- red_flags: things a candidate should see before applying — unpaid trial periods,
  "wear many hats" for a solo role, undisclosed relocation, bond or notice clauses.
- keywords: terms an ATS for this role would screen on.
- confidence: lower it when the JD is boilerplate, translated awkwardly, or mostly
  company marketing with little about the actual job.`;

const ModelAnalysis = z.object({
  must_have: z.array(z.object({ skill: z.string(), evidence: z.string() })),
  nice_to_have: z.array(z.object({ skill: z.string(), evidence: z.string() })),
  years_required: z.object({ min: z.number().nullable(), max: z.number().nullable() }),
  true_seniority: z.enum(["intern", "junior", "mid", "senior", "staff", "principal", "lead", "manager"]),
  implicit_requirements: z.array(z.string()),
  red_flags: z.array(z.string()),
  domain: z.array(z.string()),
  responsibilities: z.array(z.string()),
  keywords: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});

export async function jdAnalysis(ctx: AgentContext, input: AgentInput): Promise<AgentOutput> {
  const out = emptyOutput();
  // Bounded, and ordered by a free signal first. Analysis is the dominant cost
  // of a search, so it runs on the shortlist that can actually reach the
  // rubric — not on everything that cleared the filters.
  const budgetForAnalysis = input.params.limit ?? env.analysisTopK;
  // The free ordering works off a brief just as well as a résumé, so a search
  // without one still spends its analysis budget on the most relevant
  // postings rather than on whichever happened to be harvested first.
  const signal = candidateSignal(input.board);
  const ordered = signal
    ? cheapRank(ctx, signal, input.board.filtered_job_ids)
    : input.board.filtered_job_ids;
  const jobIds = ordered.slice(0, budgetForAnalysis);
  const deferred = ordered.length - jobIds.length;

  let cached = 0;
  let analysed = 0;
  let failed = 0;
  let usage = emptyUsage();
  let model: string | null = null;

  // The guard is enforced inside the client now, per call, so concurrency no
  // longer trades against budget accuracy — only in-flight calls can overshoot.
  const limit = pLimit(6);
  const done: string[] = [];

  await Promise.all(
    jobIds.map((jobId) =>
      limit(async () => {
        if (ctx.store.getAnalysis(jobId)) {
          cached++;
          done.push(jobId);
          return;
        }
        // The governor is consulted inside the fan-out, not only at dispatch:
        // a 200-job analysis is where a budget actually gets spent.
        if (ctx.remaining().llm_calls <= 0 || ctx.remaining().cost_usd <= 0) return;

        const job = ctx.store.getJob(jobId);
        if (!job) return;

        try {
          const res = await ctx.llm.structured({
            agent: "jd_analyst",
            tier: "fast",
            systemPrompt: SYSTEM,
            input:
              `Title: ${job.title}\nCompany: ${job.company}\nLocation: ${job.location ?? "unstated"}\n\n` +
              // Requirements sit near the top of a posting; the tail is
              // benefits, EEO statements and boilerplate. Sending 24k
              // characters of that was most of what a search cost.
              `Description:\n${job.description_text.slice(0, 8_000)}`,
            schema: ModelAnalysis,
            schemaName: "jd_analysis",
            maxTokens: 3000,
            signal: ctx.signal,
          });
          usage = addUsage(usage, res.usage);
          model = res.model;

          const analysis = JDAnalysis.parse({
            job_id: jobId,
            ...res.value,
            // Skill names are canonicalized in code so the overlap leg of the
            // match funnel compares like with like.
            must_have: res.value.must_have.map((s) => ({
              ...s,
              skill: normalizeSkills(ctx.store, [s.skill])[0] ?? s.skill,
            })),
            nice_to_have: res.value.nice_to_have.map((s) => ({
              ...s,
              skill: normalizeSkills(ctx.store, [s.skill])[0] ?? s.skill,
            })),
            years_required: res.value.years_required,
            analyzed_at: new Date().toISOString(),
            model: res.model,
          });
          ctx.store.putAnalysis(analysis);
          analysed++;
          done.push(jobId);
        } catch {
          // One unreadable JD degrades that job, not the batch.
          failed++;
        }
      }),
    ),
  );

  out.usage = usage;
  out.model = model;
  out.llmCalls = analysed;
  out.board = { analyzed_job_ids: done };
  out.summary =
    `${analysed} analysed, ${cached} served from cache, ${failed} failed` +
    (deferred > 0 ? `; ${deferred} ranked on title and text alone (below the analysis cutoff)` : "");
  if (failed > 0) out.degraded = `${failed} JDs could not be structured`;
  return out;
}

/** Used by the tailoring lane, which needs one analysis on demand. */
export async function analyseOne(ctx: AgentContext, jobId: string): Promise<{ analysis: JDAnalysis | null; output: AgentOutput }> {
  const cachedHit = ctx.store.getAnalysis(jobId);
  if (cachedHit) return { analysis: cachedHit, output: emptyOutput("JD analysis served from cache") };

  const board = { filtered_job_ids: [jobId] } as AgentInput["board"];
  const output = await jdAnalysis(ctx, {
    node: { id: "jd_on_demand", kind: "jd_analysis", label: "", depends_on: [], params: { note: null, limit: 1, broaden: false }, idempotency_key: `jd:${jobId}`, max_attempts: 2, optional: false },
    params: { note: null, limit: 1, broaden: false },
    board,
  });
  return { analysis: ctx.store.getAnalysis(jobId), output };
}

export const ESCALATION_CONFIDENCE = env.escalationConfidence;
