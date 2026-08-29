import { z } from "zod";
import { EditPlan } from "../../schemas/tailoring.js";
import { analyseOne } from "../jdAnalyst.js";
import { addUsage } from "../../llm/client.js";
import { type AgentContext, type AgentInput, type AgentOutput, emptyOutput } from "../types.js";

/**
 * 2.7 Step 1 - Gap Analysis.
 *
 * Produces an edit *plan* and nothing else. No prose is written here, and that
 * separation is the point: an edit that has not been written yet is one nobody
 * has fallen in love with, so Evidence Binding can veto it cheaply.
 */
const SYSTEM = `You plan how to tailor a resume to one job. You do NOT write any resume text.

You are given a structured resume (every bullet has an id), the job's structured
requirements, and the match report. Produce a list of edits.

Each edit says WHAT should change and WHY, in requirements language:
- kind: rewrite_bullet | promote_bullet | surface_skill | rewrite_summary | reorder_section | add_keyword
- target_id: the id of the resume element it acts on, or null for edits that add something
- intent: what the edit must achieve. "Foreground the Kubernetes work in exp_2_b3",
  not "Led migration of 40 services to Kubernetes".
- addresses: the specific JD requirement this serves
- priority: 1 (highest) to 5

Hard rules:
- Never propose an edit that would require experience the resume does not show.
  If the JD needs something the resume does not evidence, it belongs in
  unaddressable_gaps, not in edits.
- Do not propose more than 12 edits. A resume rewritten everywhere reads as
  written for no one.
- missing_keywords are terms the JD screens on that the resume never uses. List
  them; do not decide yet whether they can be added.`;

const ModelEditPlan = z.object({
  edits: z.array(
    z.object({
      kind: z.enum([
        "rewrite_bullet",
        "promote_bullet",
        "surface_skill",
        "rewrite_summary",
        "reorder_section",
        "add_keyword",
      ]),
      target_id: z.string().nullable(),
      intent: z.string(),
      addresses: z.string(),
      priority: z.number().int().min(1).max(5),
    }),
  ),
  missing_keywords: z.array(z.string()),
  unaddressable_gaps: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});

export async function gapAnalysis(ctx: AgentContext, input: AgentInput): Promise<AgentOutput> {
  const out = emptyOutput();
  const jobId = input.params.note ?? input.board.selected_job_id;
  const resume = input.board.resume;

  if (!jobId || !resume) {
    out.summary = "gap analysis needs a selected job and a parsed resume";
    out.degraded = "missing inputs";
    return out;
  }

  const job = ctx.store.getJob(jobId);
  if (!job) {
    out.summary = `job ${jobId} not in the store`;
    out.degraded = "missing job";
    return out;
  }

  const { analysis, output: jdOut } = await analyseOne(ctx, jobId);
  out.usage = addUsage(out.usage, jdOut.usage);
  out.llmCalls += jdOut.llmCalls;

  const match = input.board.matches.find((m) => m.job_id === jobId);

  const res = await ctx.llm.structured({
    agent: "gap_analysis",
    // Tailoring is the strongest tier's job.
    tier: "strong",
    systemPrompt: SYSTEM,
    input: [
      "RESUME (ids are stable; refer to them exactly)",
      renderResumeWithIds(resume),
      "",
      `JOB: ${job.title} at ${job.company}`,
      analysis
        ? `Required: ${analysis.must_have.map((m) => `${m.skill} ("${m.evidence}")`).join("; ")}\n` +
          `Preferred: ${analysis.nice_to_have.map((m) => m.skill).join(", ") || "none"}\n` +
          `Years: ${analysis.years_required.min ?? "?"}-${analysis.years_required.max ?? "?"}; seniority: ${analysis.true_seniority}\n` +
          `Screens on: ${analysis.keywords.join(", ")}\n` +
          `Implicit: ${analysis.implicit_requirements.join("; ")}`
        : `Description:\n${job.description_text.slice(0, 8000)}`,
      match
        ? `\nMATCH REPORT: overall ${match.overall}. Gaps: ${match.gaps.join(", ") || "none recorded"}. ` +
          `Matched: ${match.matched_skills.join(", ") || "none recorded"}.`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
    schema: ModelEditPlan,
    schemaName: "edit_plan",
    // An edit plan scales with the résumé: four roles of dense bullets is a
    // long list of edits, each with a rationale. 4,000 truncated on a real
    // CV — recoverable now, but every wasted round trip is ~40s, so it
    // starts where a full résumé actually lands.
    maxTokens: 12_000,
    signal: ctx.signal,
  });
  out.usage = addUsage(out.usage, res.usage);
  out.model = res.model;
  out.llmCalls++;
  out.attempts = res.attempts;
  out.validationFailures = res.validationFailures;

  const plan = EditPlan.parse({
    job_id: jobId,
    edits: res.value.edits.slice(0, 12).map((e, i) => ({ id: `edit_${i + 1}`, ...e })),
    missing_keywords: res.value.missing_keywords,
    unaddressable_gaps: res.value.unaddressable_gaps,
    confidence: res.value.confidence,
  });

  out.board = { edit_plan: plan, selected_job_id: jobId };
  out.summary = `${plan.edits.length} planned edits, ${plan.missing_keywords.length} missing keywords, ${plan.unaddressable_gaps.length} unaddressable gaps`;
  return out;
}

/** The one view of the resume the tailoring lane works from - ids included,
 *  because every downstream claim must cite one. */
export function renderResumeWithIds(resume: NonNullable<AgentInput["board"]["resume"]>): string {
  const lines: string[] = [];
  if (resume.summary) lines.push(`[summary] ${resume.summary}`);
  lines.push(`[skills.primary] ${resume.skills.primary.join(", ")}`);
  lines.push(`[skills.secondary] ${resume.skills.secondary.join(", ")}`);
  for (const e of resume.experience) {
    lines.push(`[${e.id}] ${e.title}, ${e.company} (${e.start} - ${e.end})${e.location ? `, ${e.location}` : ""}`);
    for (const b of e.bullets) lines.push(`  [${b.id}] ${b.text}`);
  }
  for (const p of resume.projects) lines.push(`[${p.id}] ${p.name}: ${p.description} (${p.tech.join(", ")})`);
  for (const ed of resume.education) {
    lines.push(`[${ed.id}] ${ed.degree}${ed.field ? `, ${ed.field}` : ""} - ${ed.institution} (${ed.end ?? "?"})`);
  }
  return lines.join("\n");
}
