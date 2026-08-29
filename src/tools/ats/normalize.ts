import { sha1 } from "../embed.js";
import { normalizeWhitespace } from "../parse/html.js";
import type { JobPosting } from "../../schemas/job.js";
import type { AtsType } from "../../schemas/source.js";
import type { Money } from "../../schemas/common.js";

const REMOTE = /\b(remote|work from home|wfh|anywhere|distributed)\b/i;
const HYBRID = /\bhybrid\b/i;

export function inferWorkMode(location: string | null, text: string): JobPosting["work_mode"] {
  const hay = `${location ?? ""} ${text.slice(0, 3000)}`;
  if (HYBRID.test(hay)) return "hybrid";
  if (REMOTE.test(hay)) return "remote";
  if (location && location.trim().length > 0) return "onsite";
  return "unknown";
}

/**
 * The same job is posted to a company board, an aggregator, and a job feed with
 * three different ids. Company + normalized title + normalized location is the
 * key that actually collapses them.
 */
export function dedupeKey(company: string, title: string, location: string | null): string {
  return sha1([slug(company), slug(stripTitleNoise(title)), slug(cityOf(location))].join("|"));
}

const REMOTE_WORD = /\b(remote|anywhere|worldwide|distributed|wfh|work from home)\b/gi;

/**
 * The same posting appears as "Bengaluru" on the company board and
 * "Bengaluru, India" on an aggregator, and as "Remote - Bengaluru" on a third.
 * Keying on the full string leaves all three in the results, so the key uses
 * the city alone — falling back to "remote" only when no city is named.
 */
export function cityOf(location: string | null): string {
  if (!location) return "";
  const withoutRemote = location.replace(REMOTE_WORD, " ").replace(/[()]/g, " ");
  const first = withoutRemote
    .split(/[,|/·]|\s[-\u2013\u2014]\s/)
    .map((s) => s.trim())
    .find((s) => s.length > 1);
  return first ?? "remote";
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Requisition ids, office suffixes and bracketed noise defeat naive dedupe. */
export function stripTitleNoise(title: string): string {
  return title
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[-–—|,]\s*(remote|hybrid|onsite|full[- ]time|part[- ]time|contract)\b.*$/i, " ")
    .replace(/\b(req(uisition)?\s*#?\s*\d+|jr-?\d+|\d{4,})\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function makeJob(input: {
  externalId: string;
  sourceId: string;
  atsType: AtsType;
  company: string;
  title: string;
  location: string | null;
  postedAt: string | null;
  url: string;
  applyUrl: string | null;
  descriptionHtml: string | null;
  descriptionText: string;
  compensation?: Money | null;
  department?: string | null;
  employmentType?: string | null;
}): JobPosting {
  const text = normalizeWhitespace(input.descriptionText);
  return {
    id: sha1(`${input.atsType}|${input.sourceId}|${input.externalId}`),
    dedupe_key: dedupeKey(input.company, input.title, input.location),
    source_id: input.sourceId,
    ats_type: input.atsType,
    company: input.company.trim(),
    title: input.title.trim(),
    location: input.location?.trim() || null,
    work_mode: inferWorkMode(input.location, text),
    posted_at: input.postedAt,
    url: input.url,
    apply_url: input.applyUrl,
    description_text: text,
    description_html: input.descriptionHtml,
    compensation: input.compensation ?? null,
    department: input.department ?? null,
    employment_type: input.employmentType ?? null,
    fetched_at: new Date().toISOString(),
  };
}

/**
 * §7 step 4 — deduping is code, not a model call. Keeps the richest record for
 * each key: the one whose description survived the fetch most intact.
 */
export function dedupeJobs(jobs: JobPosting[]): JobPosting[] {
  const best = new Map<string, JobPosting>();
  for (const job of jobs) {
    const existing = best.get(job.dedupe_key);
    if (!existing || score(job) > score(existing)) best.set(job.dedupe_key, job);
  }
  return [...best.values()];
}

function score(j: JobPosting): number {
  // Prefer a direct ATS record over an aggregator echo, and longer descriptions
  // over teasers — a JD Analyst reading a teaser produces confident nonsense.
  const atsBonus = j.ats_type === "jsonld" || j.ats_type === "unknown" ? 0 : 5000;
  return atsBonus + Math.min(j.description_text.length, 20_000) + (j.apply_url ? 100 : 0);
}
