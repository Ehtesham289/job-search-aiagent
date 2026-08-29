import { z } from "zod";
import { TailoredResume } from "../../schemas/tailoring.js";
import type { CritiqueReport, EditPlan, BindingReport } from "../../schemas/tailoring.js";
import type { StructuredResume } from "../../schemas/profile.js";
import { renderResumeWithIds } from "./gapAnalysis.js";
import { type AgentContext, type AgentInput, type AgentOutput, emptyOutput } from "../types.js";

/**
 * 2.7 Step 3 - Draft.
 *
 * Rewrites only the bound edits, and emits structured resume JSON rather than
 * formatted text. Formatting is the renderer's job (3); a model asked for a
 * formatted document produces something that looks right and parses wrong.
 *
 * On a revision pass the critic's findings come in, but the drafter never sees
 * its own previous reasoning - only its previous output and what was wrong
 * with it.
 */
const SYSTEM = `You rewrite a resume for one job, emitting structured JSON only.

You get the original resume, an edit plan, and the verified evidence for each
edit. Apply ONLY the edits marked bound. Ignore unbound edits entirely; they
have been dropped on purpose.

Rules that are not negotiable:
- Every claim in your output must be traceable to the original resume. You may
  rephrase, re-emphasise, and reorder. You may not add facts.
- Never invent or adjust a metric. If the original says "reduced latency", your
  version says "reduced latency" - not "reduced latency by 40%".
- Never change dates, employers, or titles.
- Never inflate scope: "contributed to" does not become "led".
- Keywords go in only where the work genuinely involved them. A keyword list
  glued to the end of a bullet reads as stuffing and gets rejected.
- Keep every experience entry from the original, in the same order, unless an
  edit explicitly reorders it.
- source_ids on each experience entry list the ORIGINAL bullet ids the rewritten
  bullets came from.
- applied_edit_ids lists the edit ids you actually used.

Write in the register of the original resume. A resume that suddenly reads like
marketing copy is a worse resume, whatever the keyword coverage.`;

const ModelDraft = z.object({
  summary: z.string(),
  experience: z.array(
    z.object({
      id: z.string(),
      company: z.string(),
      title: z.string(),
      location: z.string().nullable(),
      start: z.string(),
      end: z.string(),
      bullets: z.array(z.string()),
      source_ids: z.array(z.string()),
    }),
  ),
  skills: z.object({ primary: z.array(z.string()), secondary: z.array(z.string()) }),
  projects: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      tech: z.array(z.string()),
      source_ids: z.array(z.string()),
    }),
  ),
  applied_edit_ids: z.array(z.string()),
});

export async function draft(ctx: AgentContext, input: AgentInput): Promise<AgentOutput> {
  const out = emptyOutput();
  const { resume, edit_plan: plan, bindings, critiques } = input.board;

  if (!resume || !plan || !bindings) {
    out.summary = "draft needs a resume, an edit plan and evidence bindings";
    out.degraded = "missing inputs";
    return out;
  }

  const bound = bindings.bindings.filter((b) => b.bound);
  const boundEdits = plan.edits.filter((e) => bound.some((b) => b.edit_id === e.id));
  const revision = input.board.revision;
  const lastCritique = critiques.at(-1) ?? null;

  const res = await ctx.llm.structured({
    agent: "resume_drafter",
    tier: "strong",
    systemPrompt: SYSTEM,
    input: buildDraftInput(resume, plan, bindings, boundEdits, lastCritique, input.board.draft, revision),
    schema: ModelDraft,
    schemaName: "tailored_resume",
    maxTokens: 12_000,
    effort: "high",
    signal: ctx.signal,
  });
  out.usage = res.usage;
  out.model = res.model;
  out.llmCalls = 1;
  out.attempts = res.attempts;
  out.validationFailures = res.validationFailures;

  const v = res.value;
  const tailored = TailoredResume.parse({
    // Contact details are copied through untouched. There is no version of
    // "tailoring" that should rewrite someone's phone number.
    contact: resume.contact,
    summary: v.summary,
    experience: v.experience,
    skills: v.skills,
    education: resume.education.map((e) => ({
      institution: e.institution,
      degree: e.degree,
      field: e.field,
      end: e.end,
      detail: e.detail,
    })),
    projects: v.projects,
    // Copied, not drafted: a model has no business restating someone's
    // certifications, and dropping them loses real evidence.
    certifications: resume.certifications.map((c) => ({ name: c.name, issuer: c.issuer })),
    applied_edit_ids: v.applied_edit_ids,
  });

  out.board = { draft: tailored, revision: revision + 1 };
  out.summary =
    revision === 0
      ? `draft written: ${boundEdits.length} bound edits applied across ${tailored.experience.length} roles`
      : `revision ${revision}: ${lastCritique?.findings.length ?? 0} findings addressed`;
  return out;
}

function buildDraftInput(
  resume: StructuredResume,
  plan: EditPlan,
  bindings: BindingReport,
  boundEdits: EditPlan["edits"],
  critique: CritiqueReport | null,
  previous: AgentInput["board"]["draft"],
  revision: number,
): string {
  const parts: string[] = [
    "ORIGINAL RESUME",
    renderResumeWithIds(resume),
    "",
    "EDITS TO APPLY (bound, with verified evidence)",
    ...boundEdits.map((e) => {
      const b = bindings.bindings.find((x) => x.edit_id === e.id);
      return (
        `${e.id} [${e.kind}] target=${e.target_id ?? "none"}\n` +
        `  intent: ${e.intent}\n` +
        `  addresses: ${e.addresses}\n` +
        `  evidence (${b?.source_ids.join(", ")}): ${b?.quotes.map((q) => `"${q}"`).join(" | ")}`
      );
    }),
    "",
    `KEYWORDS THE JD SCREENS ON: ${plan.missing_keywords.join(", ") || "none identified"}`,
    `DROPPED (no evidence - do not address these): ${
      bindings.bindings.filter((b) => !b.bound).map((b) => b.edit_id).join(", ") || "none"
    }`,
  ];

  if (revision > 0 && critique && previous) {
    parts.push(
      "",
      `REVISION ${revision}. Your previous draft was rejected. Findings:`,
      ...critique.findings.map(
        (f) =>
          `- [${f.severity}] ${f.category} at ${f.location}\n` +
          `  offending text: "${f.quote}"\n` +
          `  problem: ${f.explanation}` +
          (f.suggested_fix ? `\n  suggestion: ${f.suggested_fix}` : ""),
      ),
      "",
      "YOUR PREVIOUS DRAFT",
      JSON.stringify(previous, null, 1),
      "",
      "Fix exactly these findings. Leave everything else identical.",
    );
  }

  return parts.join("\n");
}
