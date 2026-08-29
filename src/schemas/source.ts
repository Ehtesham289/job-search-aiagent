import { z } from "zod";
import { Confidence } from "./common.js";

export const AtsType = z.enum([
  "greenhouse",
  "lever",
  "ashby",
  "workable",
  "smartrecruiters",
  "recruitee",
  "workday",
  "jsonld",
  /** A *search* source rather than an employer board: it answers the run's
   *  query instead of enumerating one company. Opt-in only — see linkedin.ts
   *  for what it costs to use. */
  "linkedin",
  /** Local job JSON on disk. Lets the whole pipeline run with no network
   *  and no API key, which is what makes the test suite hermetic. */
  "fixture",
  "unknown",
]);
export type AtsType = z.infer<typeof AtsType>;

/** §2.3 — the compounding asset. */
export const SourceRecord = z.object({
  id: z.string(),
  company: z.string(),
  domain: z.string().nullable(),
  career_url: z.string().nullable(),
  ats_type: AtsType,
  /** Board token / org slug the adapter needs, e.g. `stripe` for Greenhouse. */
  ats_slug: z.string().nullable(),
  confidence: Confidence,
  status: z.enum(["verified", "unresolved", "dead"]),
  /**
   * Whether the user wants this board searched — deliberately separate from
   * `status`.
   *
   * `status` is a fact about the board: did it answer, does it still exist.
   * `enabled` is a preference about the search. Folding the two together (a
   * `"disabled"` status) would mean the next successful re-verification
   * silently switched a company back on after someone had turned it off, and
   * would lose the reason it was verified in the first place.
   */
  enabled: z.boolean().default(true),
  /** Populated when status is `unresolved` — never a bare failure. */
  reason: z.string().nullable(),
  verified_at: z.string().nullable(),
  /** Rolling source health, maintained by the Memory Curator. */
  health: z.object({
    attempts: z.number().int().default(0),
    failures: z.number().int().default(0),
    last_ok_at: z.string().nullable().default(null),
    last_error: z.string().nullable().default(null),
    avg_latency_ms: z.number().default(0),
  }),
});
export type SourceRecord = z.infer<typeof SourceRecord>;
