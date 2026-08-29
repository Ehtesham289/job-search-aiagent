import { z } from "zod";
import pLimit from "p-limit";
import { env } from "../config/env.js";
import { adapterFor } from "../tools/ats/adapters.js";
import { dedupeJobs, makeJob, stripTitleNoise } from "../tools/ats/normalize.js";
import { fetchText } from "../tools/http.js";
import { htmlToText } from "../tools/parse/html.js";
import { tokenize } from "../tools/embed.js";
import type { JobPosting } from "../schemas/job.js";
import type { QueryPlan } from "../schemas/query.js";
import type { SourceRecord } from "../schemas/source.js";
import { type AgentContext, type AgentInput, type AgentOutput, emptyOutput } from "./types.js";

/**
 * §2.4 Harvester — fan-out workers, one per source. Deliberately not an LLM:
 * fetching and normalizing are code. The model appears once, as a fallback for
 * a page with neither an ATS API nor JSON-LD.
 *
 * Failure is isolated by construction. A dead source marks itself unhealthy in
 * the registry and the run continues with fewer results; it never fails a run.
 */
export async function harvest(ctx: AgentContext, input: AgentInput): Promise<AgentOutput> {
  const out = emptyOutput();
  const plan = input.board.query_plan;

  const sources = selectSources(ctx, input.board.source_ids);
  if (sources.length === 0) {
    out.summary = "no healthy sources in the registry; nothing to harvest";
    out.degraded = "empty registry";
    out.board = { skipped: ["harvest: registry contained no verified sources"] };
    return out;
  }

  const perSource = input.params.limit ?? 150;
  const limit = pLimit(env.harvestConcurrency);

  // §4 fan-in timeout: the deadline is absolute, so one slow board cannot hold
  // the run open. Workers past the deadline are abandoned, not awaited.
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), env.harvestFanInMs);
  const outerAbort = () => controller.abort();
  ctx.signal?.addEventListener("abort", outerAbort, { once: true });

  const collected: JobPosting[] = [];
  const unhealthy: string[] = [];
  let okSources = 0;

  try {
    const results = await Promise.allSettled(
      sources.map((source) =>
        limit(async () => {
          const worker = await harvestOne(ctx, source, perSource, plan, controller.signal);
          ctx.store.recordSourceHealth(source.id, worker.ok, worker.latencyMs, worker.error);
          if (!worker.ok) {
            unhealthy.push(source.id);
            ctx.emit({
              type: "node_progress",
              node_id: input.node.id,
              message: `${source.company}: ${worker.error ?? "failed"} — degrading, run continues`,
            });
            return;
          }
          okSources++;
          collected.push(...worker.jobs);
          ctx.emit({
            type: "node_progress",
            node_id: input.node.id,
            message: `${source.company}: ${worker.jobs.length} postings`,
          });
        }),
      ),
    );
    // Promise.allSettled means a thrown worker cannot take the fan-in down.
    for (const r of results) {
      if (r.status === "rejected") unhealthy.push("unknown");
    }
  } finally {
    clearTimeout(deadline);
    ctx.signal?.removeEventListener("abort", outerAbort);
  }

  for (const job of collected) ctx.store.upsertJob(job);

  const timedOut = controller.signal.aborted && !ctx.signal?.aborted;
  out.board = {
    harvested_job_ids: collected.map((j) => j.id),
    unhealthy_source_ids: unhealthy,
    ...(timedOut ? { skipped: [`harvest: fan-in timeout at ${env.harvestFanInMs}ms; slow sources abandoned`] } : {}),
  };
  out.summary =
    `${collected.length} raw postings from ${okSources}/${sources.length} sources` +
    (unhealthy.length ? `, ${unhealthy.length} unhealthy` : "") +
    (timedOut ? " (fan-in timeout)" : "");
  if (unhealthy.length > 0) out.degraded = `${unhealthy.length} sources failed`;
  return out;
}

interface WorkerResult {
  jobs: JobPosting[];
  ok: boolean;
  error?: string;
  latencyMs: number;
}

async function harvestOne(
  ctx: AgentContext,
  source: SourceRecord,
  limit: number,
  plan: QueryPlan | null,
  signal: AbortSignal,
): Promise<WorkerResult> {
  const adapter = adapterFor(source.ats_type);
  if (!adapter) {
    return { jobs: [], ok: false, error: `no adapter for ats_type '${source.ats_type}'`, latencyMs: 0 };
  }

  // Pull generously, then keep the most relevant `limit`. Truncating an
  // alphabetical board would silently drop the matching jobs.
  const outcome = await adapter.harvest({
    source,
    signal,
    limit: Math.max(limit * 4, 200),
    query: plan
      ? {
          titles: [...new Set([...plan.title_variants, ...plan.adjacent_roles])].filter(Boolean),
          locations: plan.locations,
          remoteOk: plan.queries.some((q) => q.remote_ok),
        }
      : undefined,
  });
  if (!outcome.ok) return { jobs: [], ok: false, error: outcome.error, latencyMs: outcome.latencyMs };

  if (outcome.jobs.length === 0 && source.career_url) {
    const fallback = await llmFallback(ctx, source, signal);
    return { jobs: fallback.slice(0, limit), ok: true, latencyMs: outcome.latencyMs };
  }

  const ranked = plan ? rankByRelevance(outcome.jobs, plan) : outcome.jobs;
  return { jobs: ranked.slice(0, limit), ok: true, latencyMs: outcome.latencyMs };
}

/** Title-level relevance only — the real filtering is the §2.6 funnel. This
 *  exists so a per-source cap keeps the right jobs. */
export function rankByRelevance(jobs: JobPosting[], plan: QueryPlan): JobPosting[] {
  const wanted = new Set(plan.title_variants.concat(plan.adjacent_roles).flatMap((t) => tokenize(t)));
  const excluded = new Set(plan.exclusions.flatMap((t) => tokenize(t)));
  return [...jobs].sort((a, b) => titleScore(b, wanted, excluded) - titleScore(a, wanted, excluded));
}

function titleScore(job: JobPosting, wanted: Set<string>, excluded: Set<string>): number {
  const toks = tokenize(stripTitleNoise(job.title));
  let score = 0;
  for (const t of toks) {
    if (wanted.has(t)) score += 2;
    if (excluded.has(t)) score -= 5;
  }
  return score;
}

const FallbackJobs = z.object({
  jobs: z.array(
    z.object({
      title: z.string(),
      location: z.string().nullable(),
      url: z.string().nullable(),
      description: z.string(),
    }),
  ),
});

/**
 * The one place a model touches harvesting: a career page with no ATS API and
 * no JSON-LD. Cheap tier, extraction only, and its output goes through exactly
 * the same normalization as every adapter's.
 */
async function llmFallback(ctx: AgentContext, source: SourceRecord, signal: AbortSignal): Promise<JobPosting[]> {
  const res = await fetchText(source.career_url!, { signal, retries: 1 });
  if (!res.ok) return [];
  const text = htmlToText(res.body).slice(0, 40_000);
  if (text.length < 200) return [];

  try {
    const parsed = await ctx.llm.structured({
      agent: "harvester_fallback",
      tier: "fast",
      systemPrompt:
        "You extract job postings from the text of a careers page. Copy titles, locations and " +
        "descriptions verbatim. Do not invent postings, and do not summarise descriptions. " +
        "If the page lists no concrete openings, return an empty array.",
      input: `Careers page (${source.career_url}):\n\n${text}`,
      schema: FallbackJobs,
      schemaName: "harvest_fallback",
      maxTokens: 8000,
      signal,
    });
    return parsed.value.jobs.map((j, i) =>
      makeJob({
        externalId: j.url ?? `${source.career_url}#${i}`,
        sourceId: source.id,
        atsType: "unknown",
        company: source.company,
        title: j.title,
        location: j.location,
        postedAt: null,
        url: j.url ?? source.career_url!,
        applyUrl: j.url,
        descriptionHtml: null,
        descriptionText: j.description,
      }),
    );
  } catch {
    // A failed fallback degrades this source; it does not fail the harvest.
    return [];
  }
}

function selectSources(ctx: AgentContext, preferred: string[]): SourceRecord[] {
  const explicit = preferred.map((id) => ctx.store.getSource(id)).filter((s): s is SourceRecord => s !== null);
  const verified = ctx.store.listSources({ status: "verified" });
  const merged = new Map<string, SourceRecord>();
  for (const s of [...explicit, ...verified]) {
    if (s.status === "dead") continue;
    // A company the user switched off stays off even when this run names it
    // explicitly: `discover` adds boards to the registry, and silently
    // harvesting one that was deliberately excluded would make the switch a
    // suggestion rather than a setting.
    if (!s.enabled) continue;
    merged.set(s.id, s);
  }
  return [...merged.values()];
}

/** §7 step 4 — deduping is a code node, not an agent. */
export async function dedupe(_ctx: AgentContext, input: AgentInput): Promise<AgentOutput> {
  const out = emptyOutput();
  const jobs = input.board.harvested_job_ids
    .map((id) => _ctx.store.getJob(id))
    .filter((j): j is JobPosting => j !== null);
  const unique = dedupeJobs(jobs);
  out.board = { unique_job_ids: unique.map((j) => j.id) };
  out.summary = `${jobs.length} → ${unique.length} unique`;
  return out;
}
