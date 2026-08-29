import { z } from "zod";
import { Assessed, YearRange } from "./common.js";

export const SourceType = z.enum(["ats", "aggregator", "company_page", "board"]);
export type SourceType = z.infer<typeof SourceType>;

/**
 * What the candidate wants, as distinct from what their résumé records.
 *
 * These were previously inferred from the résumé, which quietly assumed nobody
 * ever moves. People relocate for a better offer, and a system that reads their
 * current address as a constraint will never show them the offer worth moving
 * for. Stated preferences are authoritative and override anything inferred.
 */
export const SearchPreferences = z.object({
  /** Empty means "anywhere" — not "wherever the résumé says". */
  locations: z.array(z.string()).default([]),
  remote_ok: z.boolean().default(true),
  /** True when the candidate is open to relocating to the listed places. */
  willing_to_relocate: z.boolean().default(true),
});
export type SearchPreferences = z.infer<typeof SearchPreferences>;

export const SearchQuery = z.object({
  source_type: SourceType,
  q: z.string(),
  location: z.string().nullable(),
  remote_ok: z.boolean().default(true),
  /** Why this query exists — shows up in the trace so a bad matrix is debuggable. */
  rationale: z.string(),
});

/**
 * §2.2 — the search matrix. Title alone returns generic results; title x skill
 * signature x seniority band is what makes them specific.
 */
export const QueryPlan = z
  .object({
    canonical_role: z.string(),
    title_variants: z.array(z.string()).min(1).max(12),
    adjacent_roles: z.array(z.string()).max(8).default([]),
    skill_signature: z.array(z.string()).min(1).max(20),
    seniority_band: YearRange,
    exclusions: z.array(z.string()).default([]),
    locations: z.array(z.string()).default([]),
    queries: z.array(SearchQuery).min(1).max(40),
  })
  .extend(Assessed.shape);
export type QueryPlan = z.infer<typeof QueryPlan>;
