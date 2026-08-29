import { z } from "zod";
import { AtsType } from "./source.js";
import { Money, Seniority, WorkMode, YearRange, Confidence } from "./common.js";

/** Canonical posting. Harvesters normalize into exactly this — no adapter leaks. */
export const JobPosting = z.object({
  id: z.string(),
  /** Stable across sources: sha1(company|normalized_title|normalized_location). */
  dedupe_key: z.string(),
  source_id: z.string(),
  ats_type: AtsType,
  company: z.string(),
  title: z.string(),
  location: z.string().nullable(),
  work_mode: WorkMode,
  posted_at: z.string().nullable(),
  url: z.string(),
  apply_url: z.string().nullable(),
  description_text: z.string(),
  description_html: z.string().nullable(),
  compensation: Money.nullable(),
  department: z.string().nullable(),
  employment_type: z.string().nullable(),
  fetched_at: z.string(),
});
export type JobPosting = z.infer<typeof JobPosting>;

/** §2.5 — extraction, not reasoning. Cheap model, cached forever on the job. */
export const SkillRequirement = z.object({
  skill: z.string(),
  evidence: z.string(),
});

export const JDAnalysis = z.object({
  job_id: z.string(),
  must_have: z.array(SkillRequirement).default([]),
  nice_to_have: z.array(SkillRequirement).default([]),
  years_required: YearRange,
  true_seniority: Seniority,
  implicit_requirements: z.array(z.string()).default([]),
  red_flags: z.array(z.string()).default([]),
  domain: z.array(z.string()).default([]),
  responsibilities: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default([]),
  confidence: Confidence,
  /** Set by the cache layer, not the model. */
  analyzed_at: z.string().default(() => new Date().toISOString()),
  model: z.string().default("unknown"),
});
export type JDAnalysis = z.infer<typeof JDAnalysis>;
