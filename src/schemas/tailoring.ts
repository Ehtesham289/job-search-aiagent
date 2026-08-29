import { z } from "zod";
import { Confidence } from "./common.js";
import { StructuredResume } from "./profile.js";

/* ── Step 1: Gap Analysis ─────────────────────────────────────────────────
 * An edit *plan*. No prose is written at this stage; that separation is what
 * lets Evidence Binding veto an edit before anyone has fallen in love with
 * the sentence.
 */
export const EditKind = z.enum([
  "rewrite_bullet",
  "promote_bullet",
  "surface_skill",
  "rewrite_summary",
  "reorder_section",
  "add_keyword",
]);

export const PlannedEdit = z.object({
  id: z.string(),
  kind: EditKind,
  /** Which part of the original this edit acts on. */
  target_id: z.string().nullable(),
  /** What the edit should achieve, in requirements language, not prose. */
  intent: z.string(),
  /** The JD requirement this edit serves. */
  addresses: z.string(),
  priority: z.number().int().min(1).max(5),
});
export type PlannedEdit = z.infer<typeof PlannedEdit>;

export const EditPlan = z.object({
  job_id: z.string(),
  edits: z.array(PlannedEdit).max(25),
  missing_keywords: z.array(z.string()).default([]),
  /** Requirements the resume plainly does not cover. Feeds user questions. */
  unaddressable_gaps: z.array(z.string()).default([]),
  confidence: Confidence,
});
export type EditPlan = z.infer<typeof EditPlan>;

/* ── Step 2: Evidence Binding ─────────────────────────────────────────────
 * Non-fabrication as structure rather than as a polite instruction.
 */
export const EvidenceBinding = z.object({
  edit_id: z.string(),
  bound: z.boolean(),
  /** Ids from the ORIGINAL structured resume. Must be non-empty when bound. */
  source_ids: z.array(z.string()).default([]),
  /** Verbatim spans from the original that justify the edit. */
  quotes: z.array(z.string()).default([]),
  /** Populated when bound is false; becomes the user-facing question. */
  unbound_reason: z.string().nullable().default(null),
  confidence: Confidence,
});
export type EvidenceBinding = z.infer<typeof EvidenceBinding>;

export const BindingReport = z.object({
  job_id: z.string(),
  bindings: z.array(EvidenceBinding),
});
export type BindingReport = z.infer<typeof BindingReport>;

/* ── Step 3: Draft ────────────────────────────────────────────────────────
 * Structured resume JSON, never formatted text. Rendering is §3.
 */
export const TailoredExperience = z.object({
  id: z.string(),
  company: z.string(),
  title: z.string(),
  location: z.string().nullable(),
  start: z.string(),
  end: z.string(),
  bullets: z.array(z.string()),
  /** Original bullet ids the rewritten bullets derive from. */
  source_ids: z.array(z.string()),
});

export const TailoredResume = z.object({
  contact: StructuredResume.shape.contact,
  summary: z.string(),
  experience: z.array(TailoredExperience),
  skills: z.object({
    primary: z.array(z.string()),
    secondary: z.array(z.string()),
  }),
  education: z.array(
    z.object({
      institution: z.string(),
      degree: z.string(),
      field: z.string().nullable(),
      end: z.string().nullable(),
      detail: z.string().nullable(),
    }),
  ),
  projects: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        tech: z.array(z.string()),
        source_ids: z.array(z.string()),
      }),
    )
    .default([]),
  /** Copied through verbatim from the original, never authored. For many
   *  candidates a certification is the strongest evidence they have. */
  certifications: z
    .array(z.object({ name: z.string(), issuer: z.string().nullable() }))
    .default([]),
  /** Which planned edits actually made it into this draft. */
  applied_edit_ids: z.array(z.string()).default([]),
});
export type TailoredResume = z.infer<typeof TailoredResume>;

/* ── Step 4: Critic ───────────────────────────────────────────────────────
 * Adversarial. Sees the original and the draft, never the drafter's reasoning.
 */
export const CritiqueCategory = z.enum([
  "untraceable_claim",
  "inflated_seniority",
  "invented_metric",
  "stretched_dates",
  "keyword_stuffing",
  "ats_structure",
  "tone",
]);

export const Finding = z.object({
  category: CritiqueCategory,
  severity: z.enum(["reject", "warn"]),
  /** Exactly what is wrong, quoting the offending text. */
  quote: z.string(),
  explanation: z.string(),
  /** Where in the tailored JSON, e.g. `experience[1].bullets[0]`. */
  location: z.string(),
  suggested_fix: z.string().nullable(),
});
export type Finding = z.infer<typeof Finding>;

export const CritiqueReport = z.object({
  verdict: z.enum(["pass", "reject"]),
  findings: z.array(Finding).default([]),
  confidence: Confidence,
});
export type CritiqueReport = z.infer<typeof CritiqueReport>;

/* ── Step 5: Render ───────────────────────────────────────────────────────*/
export const RenderResult = z.object({
  pdf_path: z.string(),
  docx_path: z.string(),
  template: z.string(),
  /** Post-render ATS round trip. A pretty PDF that loses text is a failed render. */
  ats_check: z.object({
    passed: z.boolean(),
    extracted_chars: z.number(),
    missing_sections: z.array(z.string()),
    missing_skills: z.array(z.string()),
    notes: z.array(z.string()),
  }),
});
export type RenderResult = z.infer<typeof RenderResult>;
