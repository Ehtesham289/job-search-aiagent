import { z } from "zod";

/**
 * A month, loosely. Models write "Jan 2022" as readily as "2022-01", and a
 * strict pattern here buys a repair turn on almost every resume parse. Accept
 * the string and normalize deterministically (`normalizeMonth`) instead —
 * §"an LLM call is a step, not a system".
 */
export const MonthOrDate = z.string().describe("YYYY-MM, YYYY-MM-DD, or 'present'");

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/** Returns `YYYY-MM`, `present`, or null when nothing month-shaped is there. */
export function normalizeMonth(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (/^(present|current|now|ongoing)$/.test(s)) return "present";
  let m = /^(\d{4})-(\d{1,2})(-\d{1,2})?$/.exec(s);
  if (m) return `${m[1]}-${m[2]!.padStart(2, "0")}`;
  m = /^([a-z]{3})[a-z]*\.?\s+(\d{4})$/.exec(s);
  if (m && MONTHS[m[1]!]) return `${m[2]}-${MONTHS[m[1]!]}`;
  m = /^(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return `${m[2]}-${m[1]!.padStart(2, "0")}`;
  m = /^(\d{4})$/.exec(s);
  if (m) return `${m[1]}-01`;
  return null;
}

/**
 * Like `normalizeMonth`, but a bare year stays a bare year. Education lines
 * usually carry only a year, and rendering "2021-01" puts a month on the
 * resume that the candidate never wrote.
 */
export function normalizeGraduation(raw: string | null | undefined): string | null {
  const t = raw?.trim();
  if (t && /^\d{4}$/.test(t)) return t;
  return normalizeMonth(raw);
}

export const Confidence = z.number().min(0).max(1);

export const Money = z.object({
  min: z.number().nullable(),
  max: z.number().nullable(),
  currency: z.string().length(3).nullable(),
  period: z.enum(["year", "month", "hour"]).nullable(),
});
export type Money = z.infer<typeof Money>;

/**
 * Not integers: résumés and postings both say "1.5 years" and "18 months",
 * and an int() constraint here rejected a perfectly good model response and
 * failed the node.
 */
export const YearRange = z.object({
  min: z.number().min(0).max(60).nullable(),
  max: z.number().min(0).max(60).nullable(),
});
export type YearRange = z.infer<typeof YearRange>;

export const Seniority = z.enum(["intern", "junior", "mid", "senior", "staff", "principal", "lead", "manager"]);
export type Seniority = z.infer<typeof Seniority>;

export const WorkMode = z.enum(["onsite", "hybrid", "remote", "unknown"]);

/**
 * Every agent output that can be wrong carries its own confidence and the
 * reason it might be. The orchestrator gates escalation on these, so they are
 * required rather than optional — an agent that cannot say how sure it is has
 * not finished its job.
 */
export const Assessed = z.object({
  confidence: Confidence,
  uncertainty_notes: z.array(z.string()).default([]),
});

/** A question the system hands back to the user. Never "something went wrong". */
export const Escalation = z.object({
  id: z.string(),
  node_id: z.string(),
  agent: z.string(),
  /** Specific, answerable. "The JD asks for Kubernetes. Have you used it? Where?" */
  question: z.string().min(10),
  kind: z.enum(["evidence_gap", "ambiguous_parse", "unresolved_critique", "source_unresolved", "budget"]),
  context: z.record(z.string(), z.unknown()).default({}),
  /** Suggested answers where the answer space is closed. */
  options: z.array(z.string()).default([]),
  blocking: z.boolean().default(false),
});
export type Escalation = z.infer<typeof Escalation>;

export const Provenance = z.object({
  source_id: z.string(),
  fetched_at: z.string(),
  url: z.string().nullable(),
});
