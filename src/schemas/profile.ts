import { z } from "zod";
import { Assessed, MonthOrDate } from "./common.js";

/**
 * Structured resume. `source_ids` are the spine of non-fabrication: every
 * atom of the original resume gets a stable id at parse time, and every
 * tailored claim must cite one (see §2.7 step 2, Evidence Binding).
 */
export const ResumeBullet = z.object({
  id: z.string(),
  text: z.string(),
});

export const ResumeExperience = z.object({
  id: z.string(),
  company: z.string(),
  title: z.string(),
  location: z.string().nullable(),
  start: MonthOrDate,
  end: MonthOrDate,
  bullets: z.array(ResumeBullet),
});

export const ResumeProject = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  tech: z.array(z.string()).default([]),
  url: z.string().nullable(),
});

export const ResumeEducation = z.object({
  id: z.string(),
  institution: z.string(),
  degree: z.string(),
  field: z.string().nullable(),
  start: MonthOrDate.nullable(),
  end: MonthOrDate.nullable(),
  detail: z.string().nullable(),
});

export const ResumeContact = z.object({
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  location: z.string().nullable(),
  links: z.array(z.object({ label: z.string(), url: z.string() })).default([]),
});

export const StructuredResume = z.object({
  contact: ResumeContact,
  summary: z.string().nullable(),
  experience: z.array(ResumeExperience).default([]),
  skills: z.object({
    primary: z.array(z.string()).default([]),
    secondary: z.array(z.string()).default([]),
  }),
  education: z.array(ResumeEducation).default([]),
  projects: z.array(ResumeProject).default([]),
  certifications: z.array(z.object({ id: z.string(), name: z.string(), issuer: z.string().nullable() })).default([]),
});
export type StructuredResume = z.infer<typeof StructuredResume>;

export const ParsedResume = StructuredResume.extend(Assessed.shape);
export type ParsedResume = z.infer<typeof ParsedResume>;

/** Compact view handed to agents that must not see the whole resume. */
export const ProfileSummary = z.object({
  canonical_titles: z.array(z.string()),
  total_years: z.number(),
  top_skills: z.array(z.string()),
  locations: z.array(z.string()),
  seniority_hint: z.string(),
});
export type ProfileSummary = z.infer<typeof ProfileSummary>;
