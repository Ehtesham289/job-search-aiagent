import { z } from "zod";
import { BindingReport, type EvidenceBinding } from "../../schemas/tailoring.js";
import type { StructuredResume } from "../../schemas/profile.js";
import { renderResumeWithIds } from "./gapAnalysis.js";
import { type AgentContext, type AgentInput, type AgentOutput, emptyOutput, escalation } from "../types.js";

/**
 * 2.7 Step 2 - Evidence Binding.
 *
 * This is what makes non-fabrication structural rather than a polite
 * instruction in a prompt. Every planned edit must name the exact place in the
 * ORIGINAL resume that justifies it. An edit with no binding is dropped and
 * returned to the user as a question.
 *
 * The model's claim to have found evidence is not taken on trust: the quotes
 * and source ids are verified against the original in code afterwards, which
 * is why a confidently hallucinated binding still fails.
 */
const SYSTEM = `For each planned edit, find the evidence in the original resume that justifies it.

For every edit, return:
- bound: true only if the original resume already demonstrates what the edit claims
- source_ids: the exact ids from the resume that carry that evidence
- quotes: verbatim spans copied from those elements. Copy character for character.
- unbound_reason: when bound is false, one sentence naming what is missing

Be strict. These are NOT evidence:
- A related technology ("used Docker" does not evidence Kubernetes)
- A plausible inference from a job title
- Something the candidate probably did
- Evidence for a weaker version of the claim

If in doubt, mark it unbound. An unbound edit becomes a question to the candidate,
which is a good outcome. A wrongly bound edit becomes a lie on their resume.`;

const ModelBindings = z.object({
  bindings: z.array(
    z.object({
      edit_id: z.string(),
      bound: z.boolean(),
      source_ids: z.array(z.string()),
      quotes: z.array(z.string()),
      unbound_reason: z.string().nullable(),
      confidence: z.number().min(0).max(1),
    }),
  ),
});

type ModelBinding = z.infer<typeof ModelBindings>["bindings"][number];

export async function evidenceBinding(ctx: AgentContext, input: AgentInput): Promise<AgentOutput> {
  const out = emptyOutput();
  const plan = input.board.edit_plan;
  const resume = input.board.resume;
  if (!plan || !resume) {
    out.summary = "evidence binding needs an edit plan and a resume";
    out.degraded = "missing inputs";
    return out;
  }

  const res = await ctx.llm.structured({
    agent: "evidence_binding",
    tier: "strong",
    systemPrompt: SYSTEM,
    input: [
      "ORIGINAL RESUME",
      renderResumeWithIds(resume),
      "",
      "PLANNED EDITS",
      ...plan.edits.map(
        (e) => `${e.id} [${e.kind}] target=${e.target_id ?? "none"} - ${e.intent} (addresses: ${e.addresses})`,
      ),
    ].join("\n"),
    schema: ModelBindings,
    schemaName: "evidence_bindings",
    // One binding per edit, each carrying verbatim quotes from the original,
    // so this is larger than the plan it verifies.
    maxTokens: 12_000,
    signal: ctx.signal,
  });
  out.usage = res.usage;
  out.model = res.model;
  out.llmCalls = 1;
  out.attempts = res.attempts;
  out.validationFailures = res.validationFailures;

  // Verification in code. A model asserting `bound: true` proves nothing; a
  // quote that actually appears in the original does.
  const index = buildIndex(resume);
  const bindings: EvidenceBinding[] = [];
  for (const edit of plan.edits) {
    const claimed = res.value.bindings.find((b) => b.edit_id === edit.id);
    if (!claimed) {
      bindings.push({
        edit_id: edit.id,
        bound: false,
        source_ids: [],
        quotes: [],
        unbound_reason: "no binding was produced for this edit",
        confidence: 0,
      });
      continue;
    }
    bindings.push(verifyBinding(claimed, index));
  }

  const report = BindingReport.parse({ job_id: plan.job_id, bindings });
  const unbound = bindings.filter((b) => !b.bound);

  // The unbound edits become specific, answerable questions - never
  // "something went wrong".
  for (const b of unbound) {
    const edit = plan.edits.find((e) => e.id === b.edit_id);
    if (!edit) continue;
    out.escalations.push(
      escalation(input.node.id, "evidence_binding", {
        question:
          `The job asks for ${edit.addresses}. Your resume does not show it. ` +
          `Have you done this? If so, where - which role or project?`,
        kind: "evidence_gap",
        context: { edit_id: edit.id, intent: edit.intent, reason: b.unbound_reason },
        options: ["I haven't done this - leave it out", "I have - I'll say where"],
        blocking: false,
      }),
    );
  }
  for (const gap of plan.unaddressable_gaps.slice(0, 3)) {
    out.escalations.push(
      escalation(input.node.id, "evidence_binding", {
        question: `The JD requires ${gap}, which I could not find anywhere in your resume. Have you used it? Where?`,
        kind: "evidence_gap",
        context: { gap },
        options: ["No", "Yes - I'll say where"],
        blocking: false,
      }),
    );
  }

  out.board = { bindings: report };
  out.summary = `${bindings.length - unbound.length} bound, ${unbound.length} unbound -> ${out.escalations.length} question(s) raised`;
  return out;
}

export interface ResumeIndex {
  byId: Map<string, string>;
  normalizedById: Map<string, string>;
}

export function buildIndex(resume: StructuredResume): ResumeIndex {
  const byId = new Map<string, string>();
  if (resume.summary) byId.set("summary", resume.summary);
  byId.set("skills.primary", resume.skills.primary.join(", "));
  byId.set("skills.secondary", resume.skills.secondary.join(", "));
  for (const e of resume.experience) {
    byId.set(e.id, `${e.title} ${e.company} ${e.location ?? ""} ${e.start} ${e.end}`);
    for (const b of e.bullets) byId.set(b.id, b.text);
  }
  for (const p of resume.projects) byId.set(p.id, `${p.name} ${p.description} ${p.tech.join(" ")}`);
  for (const ed of resume.education) {
    byId.set(ed.id, `${ed.degree} ${ed.field ?? ""} ${ed.institution} ${ed.detail ?? ""}`);
  }

  const normalizedById = new Map([...byId].map(([k, v]) => [k, normalize(v)]));
  return { byId, normalizedById };
}

/**
 * A binding survives only if its ids exist and at least one quote is really in
 * the original. Fuzzy on whitespace and punctuation, exact on words.
 */
export function verifyBinding(claim: ModelBinding, index: ResumeIndex): EvidenceBinding {
  if (!claim.bound) {
    return {
      edit_id: claim.edit_id,
      bound: false,
      source_ids: [],
      quotes: [],
      unbound_reason: claim.unbound_reason ?? "the model reported no supporting evidence",
      confidence: claim.confidence,
    };
  }

  const knownIds = claim.source_ids.filter((id) => index.byId.has(id));
  if (knownIds.length === 0) {
    return {
      edit_id: claim.edit_id,
      bound: false,
      source_ids: [],
      quotes: [],
      unbound_reason: `cited source ids do not exist in the resume: ${claim.source_ids.join(", ") || "(none given)"}`,
      confidence: 0,
    };
  }

  const haystack = knownIds.map((id) => index.normalizedById.get(id) ?? "").join("   ");
  const verifiedQuotes = claim.quotes.filter((q) => {
    const n = normalize(q);
    // Below ~8 characters a "quote" matches by accident.
    return n.length >= 8 && haystack.includes(n);
  });

  if (verifiedQuotes.length === 0) {
    return {
      edit_id: claim.edit_id,
      bound: false,
      source_ids: knownIds,
      quotes: [],
      unbound_reason: "no quoted evidence actually appears in the cited resume elements",
      confidence: 0,
    };
  }

  return {
    edit_id: claim.edit_id,
    bound: true,
    source_ids: knownIds,
    quotes: verifiedQuotes,
    unbound_reason: null,
    confidence: claim.confidence,
  };
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
