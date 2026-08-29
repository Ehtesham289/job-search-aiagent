import { z } from "zod";
import { Confidence } from "./common.js";

export const MatchDimension = z.enum([
  "core_skills",
  "seniority_fit",
  "domain_relevance",
  "scope_and_impact",
  "location_and_mode",
]);

export const DimensionScore = z.object({
  dimension: MatchDimension,
  score: z.number().min(0).max(100),
  /** One line. Any longer and it stops being explainable. */
  reason: z.string().min(3).max(400),
});

/** The LLM rubric leg of the funnel (§2.6 step 4). */
export const RubricVerdict = z.object({
  dimensions: z.array(DimensionScore).min(1),
  /** Independent gut-check used by the self-consistency test in step 5. */
  holistic: z.number().min(0).max(100),
  matched_skills: z.array(z.string()).default([]),
  gaps: z.array(z.string()).default([]),
  reasoning: z.array(z.string()).default([]),
  confidence: Confidence,
});
export type RubricVerdict = z.infer<typeof RubricVerdict>;

export const MatchReport = z.object({
  job_id: z.string(),
  overall: z.number().min(0).max(100),
  /** The rubric's independent gut-check, kept so step 5 can detect
   *  disagreement with the composite. Null when no rubric ran. */
  holistic: z.number().min(0).max(100).nullable().default(null),
  dimensions: z.array(DimensionScore).default([]),
  matched_skills: z.array(z.string()).default([]),
  gaps: z.array(z.string()).default([]),
  reasoning: z.array(z.string()).default([]),
  /** Deterministic legs, kept separate so a bad rubric run is diagnosable. */
  deterministic: z.object({
    vector_similarity: z.number(),
    skill_overlap: z.number(),
    title_similarity: z.number().default(0),
    seniority_delta: z.number(),
    hard_filters_passed: z.boolean(),
  }),
  /** Present only when step 5 fired. */
  reconciliation: z
    .object({
      composite_before: z.number(),
      holistic_before: z.number(),
      resolved: z.number(),
      note: z.string(),
    })
    .nullable()
    .default(null),
  /**
   * `brief_relevance` is the honest label for a search with no résumé: the
   * number ranks the posting against what the candidate *asked for*, not
   * against who they are. It is a different question from fit, and calling it
   * a match score would misrepresent it.
   */
  scored_by: z.enum(["deterministic", "rubric", "rubric+reconciled", "brief_relevance"]),
  confidence: Confidence,
});
export type MatchReport = z.infer<typeof MatchReport>;
