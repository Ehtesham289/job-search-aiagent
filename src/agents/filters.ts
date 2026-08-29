import { tokenize } from "../tools/embed.js";
import { stripTitleNoise } from "../tools/ats/normalize.js";
import { locationCompatible } from "../tools/geo.js";
import type { JobPosting } from "../schemas/job.js";
import type { QueryPlan } from "../schemas/query.js";
import { MatchReport } from "../schemas/match.js";
import type { PreScore } from "../state/blackboard.js";
import { type AgentContext, type AgentInput, type AgentOutput, emptyOutput } from "./types.js";

/**
 * §2.6 leg 1 — deterministic hard filters. Non-negotiable constraints, zero
 * model involvement, and every drop carries a reason so the funnel is
 * auditable rather than mysterious.
 */
export interface FilterVerdict {
  keep: boolean;
  /** Specific to this posting — names the title, the place, the age. */
  reason: string;
  /**
   * The same reason with the specifics removed, so thousands of drops collapse
   * into a handful of countable groups.
   *
   * Written out per branch rather than derived by blanking the quoted part of
   * `reason`. Blanking produced lines like `4146× title '…' matches no variant
   * or adjacent role` — an ellipsis exactly where the reader is looking for
   * the explanation, which reads like a truncation bug rather than a summary.
   */
  group: string;
}

export function applyHardFilters(job: JobPosting, plan: QueryPlan, relaxed = false): FilterVerdict {
  const title = stripTitleNoise(job.title).toLowerCase();
  const titleTokens = new Set(tokenize(title));

  for (const ex of plan.exclusions) {
    const exTokens = tokenize(ex);
    if (exTokens.length && exTokens.every((t) => titleTokens.has(t))) {
      return {
        keep: false,
        reason: `title matches exclusion '${ex}'`,
        group: "title matches one of the exclusions in the search plan",
      };
    }
  }

  const wanted = [...plan.title_variants, ...plan.adjacent_roles].map((t) => tokenize(t));
  // Strict: at least two shared title tokens, so a lone "engineer" or
  // "associate" is not a match. Relaxed: one is enough — broadening loosens
  // the threshold rather than abandoning titles, which is what let a search
  // for support roles fill up with software engineering.
  const needed = relaxed ? 1 : 2;
  const overlaps = wanted.some((toks) => {
    if (toks.length === 0) return false;
    const hit = toks.filter((t) => titleTokens.has(t)).length;
    return hit >= Math.min(needed, toks.length);
  });
  if (!overlaps) {
    return {
      keep: false,
      reason: relaxed
        ? `title '${job.title}' shares no word with any variant, even broadened`
        : `title '${job.title}' matches no variant or adjacent role`,
      group: relaxed
        ? "title shares no word with the roles you asked for, even after broadening"
        : "title is a different role from the ones you asked for",
    };
  }

  if (plan.locations.length > 0) {
    // Not gated on `relaxed`: broadening widens which *titles* count, and must
    // never quietly drop a constraint the candidate stated.
    const remoteOk = plan.queries.some((q) => q.remote_ok);
    const verdict = locationCompatible(job.location, job.work_mode === "remote", plan.locations, remoteOk);
    if (!verdict.compatible) return { keep: false, reason: verdict.reason, group: verdict.group };
  }

  if (job.description_text.trim().length < 200) {
    return {
      keep: false,
      reason: "description too short to analyse honestly",
      group: "the board returned too little description text to judge the job on",
    };
  }

  if (job.posted_at) {
    const age = Date.now() - Date.parse(job.posted_at);
    // 120 days: past that, most postings are closed or stale reposts.
    if (Number.isFinite(age) && age > 120 * 24 * 3600 * 1000 && !relaxed) {
      return {
        keep: false,
        reason: `posted ${Math.round(age / 86_400_000)} days ago`,
        group: "posted more than 120 days ago, so probably closed or a stale repost",
      };
    }
  }

  return { keep: true, reason: "passed", group: "passed" };
}

export async function hardFilter(ctx: AgentContext, input: AgentInput): Promise<AgentOutput> {
  const out = emptyOutput();
  const plan = input.board.query_plan;
  if (!plan) {
    out.summary = "no query plan; hard filters skipped";
    out.degraded = "missing query plan";
    out.board = { filtered_job_ids: input.board.unique_job_ids };
    return out;
  }

  const relaxed = input.params.broaden;
  const kept: string[] = [];
  const reasons = new Map<string, { count: number; example: string }>();

  // Jobs a previous pass already ranked. Dropped here rather than at the end,
  // so the analysis and rubric budgets are spent entirely on postings the user
  // has not seen.
  const seen = new Set(input.board.exclude_job_ids);

  for (const id of input.board.unique_job_ids) {
    const job = ctx.store.getJob(id);
    if (!job) continue;
    if (seen.has(id)) {
      const g = "already shown by an earlier pass of this search";
      const prev = reasons.get(g);
      if (prev) prev.count++;
      else reasons.set(g, { count: 1, example: job.title });
      continue;
    }
    const verdict = applyHardFilters(job, plan, relaxed);
    if (verdict.keep) {
      kept.push(id);
    } else {
      const seen = reasons.get(verdict.group);
      // One concrete title per group. A count alone says the filter did
      // something; the example says what, and is usually enough to tell a
      // working filter from a mis-specified search at a glance.
      if (seen) seen.count++;
      else reasons.set(verdict.group, { count: 1, example: job.title });
    }
  }

  const top = [...reasons.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 3);
  out.board = { filtered_job_ids: kept };
  out.summary =
    `${input.board.unique_job_ids.length} → ${kept.length}` +
    (top.length
      ? ` (dropped: ${top
          .map(([group, { count, example }]) => `${count}× ${group}, e.g. “${example}”`)
          .join("; ")})`
      : "") +
    (relaxed ? " [relaxed]" : "");
  return out;
}

/** Final ordering. Pure code: the scores were already earned upstream. */
export async function rank(ctx: AgentContext, input: AgentInput): Promise<AgentOutput> {
  const out = emptyOutput();

  // Belt and braces for the case validation now rejects: if the rubric never
  // ran but the deterministic legs did, rank those instead of returning
  // nothing. Fifty-three prescored jobs discarded because one node was missing
  // from the plan is the worst possible outcome — the work was done and paid
  // for, and every signal needed to order it was already on the blackboard.
  let matchList = input.board.matches;
  if (matchList.length === 0 && input.board.prescores.length > 0) {
    matchList = input.board.prescores.map(deterministicFallback);
    out.board = { matches: matchList };
    out.degraded = "no rubric scores on the blackboard; ranked on the deterministic legs alone";
  }

  const matches = [...matchList].sort((a, b) => {
    if (b.overall !== a.overall) return b.overall - a.overall;
    // Ties break toward the more confident report, then the fresher posting.
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    const ja = ctx.store.getJob(a.job_id)?.posted_at ?? "";
    const jb = ctx.store.getJob(b.job_id)?.posted_at ?? "";
    return jb.localeCompare(ja);
  });

  out.board = { ...out.board, ranked_job_ids: matches.map((m) => m.job_id) };
  out.summary = matches.length
    ? `${matches.length} ranked, top score ${matches[0]!.overall}, median ${median(matches.map((m) => m.overall))}`
    : "0 ranked results";

  ctx.emit({
    type: "partial_results",
    label: "Ranked results",
    items: matches.slice(0, 10).map((m) => {
      const job = ctx.store.getJob(m.job_id);
      return `${m.overall}%  ${job?.title ?? m.job_id} — ${job?.company ?? ""}`;
    }),
  });
  return out;
}

/** A prescore promoted to a MatchReport, labelled for what it is. */
function deterministicFallback(pre: PreScore): MatchReport {
  return MatchReport.parse({
    job_id: pre.job_id,
    overall: Math.round(pre.composite * 100),
    holistic: null,
    dimensions: [],
    matched_skills: pre.matched_skills,
    gaps: pre.missing_skills.slice(0, 6),
    reasoning: ["Ranked on the deterministic legs only — the rubric step did not run for this job."],
    deterministic: {
      vector_similarity: pre.vector_similarity,
      skill_overlap: pre.skill_overlap,
      title_similarity: pre.title_similarity,
      seniority_delta: pre.seniority_delta,
      hard_filters_passed: true,
    },
    reconciliation: null,
    scored_by: "deterministic",
    confidence: 0.35,
  });
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}
