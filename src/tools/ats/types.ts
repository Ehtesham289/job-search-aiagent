import type { AtsType } from "../../schemas/source.js";
import type { JobPosting } from "../../schemas/job.js";
import type { SourceRecord } from "../../schemas/source.js";

/**
 * What the run is looking for. Board adapters ignore it — a company's
 * Greenhouse board is enumerable, so the funnel does the filtering later. A
 * *search* source has no board to enumerate: it can only answer a question,
 * so it needs to be told the question.
 */
export interface HarvestQuery {
  /** Title variants and adjacent roles, most canonical first. */
  titles: string[];
  locations: string[];
  remoteOk: boolean;
}

export interface HarvestContext {
  source: SourceRecord;
  signal?: AbortSignal;
  /** Cap per source so one enormous board cannot eat the whole run. */
  limit: number;
  /** Present when the run has a query plan; absent on a bare registry sweep. */
  query?: HarvestQuery;
}

export interface HarvestOutcome {
  jobs: JobPosting[];
  ok: boolean;
  error?: string;
  latencyMs: number;
}

export interface AtsAdapter {
  readonly type: AtsType;
  /** URL patterns that identify this ATS without fetching anything. */
  matches(url: string): { slug: string } | null;
  harvest(ctx: HarvestContext): Promise<HarvestOutcome>;
}
