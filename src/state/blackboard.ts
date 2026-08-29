import type { Escalation } from "../schemas/common.js";
import type { MatchReport } from "../schemas/match.js";
import type { ProfileSummary, StructuredResume } from "../schemas/profile.js";
import type { QueryPlan, SearchPreferences } from "../schemas/query.js";
import type { BindingReport, CritiqueReport, EditPlan, RenderResult, TailoredResume } from "../schemas/tailoring.js";

export interface PreScore {
  job_id: string;
  vector_similarity: number;
  skill_overlap: number;
  /** How close the posting's title is to a title the candidate has held. */
  title_similarity: number;
  seniority_delta: number;
  composite: number;
  /** Computed by the skill graph, so a report always has explainable gaps
   *  even when the rubric leg does not fill them in. */
  matched_skills: string[];
  missing_skills: string[];
}

/**
 * The shared run state. Every field is either a validated schema type or a
 * list of ids pointing into the store — no agent ever reads another agent's
 * prose from here, which is what stops error compounding down a long chain.
 */
export interface Blackboard {
  brief: string;
  resume: StructuredResume | null;
  profile: ProfileSummary | null;
  query_plan: QueryPlan | null;
  /** Stated by the user; overrides anything the résumé implies. */
  preferences: SearchPreferences;

  /**
   * Companies the user asked to discover. Its own field because it used to
   * ride on the shared `params.note`, which the plan also carries — so a
   * planning hint got read as a company name and became a nonsense question.
   */
  discover_targets: string[];
  /** Search the open web for employers nobody named. */
  auto_discover: boolean;
  /** Registry ids selected for this run. */
  source_ids: string[];
  /** Ids of sources that failed; they degrade the result set, never fail it. */
  unhealthy_source_ids: string[];
  discovered_source_ids: string[];

  /**
   * Jobs an earlier run already showed the user, excluded at the hard filter.
   *
   * This is what makes "find more" mean more, rather than the same shortlist
   * re-scored: the rubric only ever sees the top ~30 that survive the funnel,
   * so without an exclusion set a second pass ranks the same thirty again.
   */
  exclude_job_ids: string[];

  harvested_job_ids: string[];
  unique_job_ids: string[];
  filtered_job_ids: string[];
  analyzed_job_ids: string[];
  prescores: PreScore[];
  matches: MatchReport[];
  ranked_job_ids: string[];

  /* tailoring lane */
  selected_job_id: string | null;
  edit_plan: EditPlan | null;
  bindings: BindingReport | null;
  draft: TailoredResume | null;
  critiques: CritiqueReport[];
  revision: number;
  render: RenderResult | null;

  escalations: Escalation[];
  /** Answers keyed by escalation id, supplied by the user on resume. */
  answers: Record<string, string>;
  /** Honest record of what the run did not finish. */
  skipped: string[];
}

export function emptyBlackboard(brief: string): Blackboard {
  return {
    brief,
    resume: null,
    profile: null,
    query_plan: null,
    preferences: { locations: [], remote_ok: true, willing_to_relocate: true },
    discover_targets: [],
    auto_discover: false,
    source_ids: [],
    unhealthy_source_ids: [],
    discovered_source_ids: [],
    exclude_job_ids: [],
    harvested_job_ids: [],
    unique_job_ids: [],
    filtered_job_ids: [],
    analyzed_job_ids: [],
    prescores: [],
    matches: [],
    ranked_job_ids: [],
    selected_job_id: null,
    edit_plan: null,
    bindings: null,
    draft: null,
    critiques: [],
    revision: 0,
    render: null,
    escalations: [],
    answers: {},
    skipped: [],
  };
}

const LIST_KEYS = [
  "discover_targets", "source_ids", "unhealthy_source_ids", "discovered_source_ids", "exclude_job_ids",
  "harvested_job_ids", "unique_job_ids", "filtered_job_ids", "analyzed_job_ids", "skipped",
] as const satisfies readonly (keyof Blackboard)[];

const APPEND_KEYS = ["critiques", "escalations"] as const satisfies readonly (keyof Blackboard)[];
/** Keyed by job_id: a fan-out contributes new entries, and a later node
 *  (reconciliation) rewrites existing ones in place rather than duplicating. */
const UPSERT_BY_JOB_KEYS = ["prescores", "matches"] as const satisfies readonly (keyof Blackboard)[];

/**
 * Reducer for parallel supersteps. Id lists union (a fan-out of harvesters each
 * contributes some), record lists append, everything else is last-write-wins.
 */
export function mergeBlackboard(current: Blackboard, update: Partial<Blackboard>): Blackboard {
  const next = { ...current } as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(update) as Array<[keyof Blackboard, unknown]>) {
    if (value === undefined) continue;
    if ((LIST_KEYS as readonly string[]).includes(key)) {
      const merged = new Set([...(current[key] as string[]), ...(value as string[])]);
      next[key] = [...merged];
    } else if ((APPEND_KEYS as readonly string[]).includes(key)) {
      next[key] = [...(current[key] as unknown[]), ...(value as unknown[])];
    } else if ((UPSERT_BY_JOB_KEYS as readonly string[]).includes(key)) {
      const byId = new Map((current[key] as Array<{ job_id: string }>).map((x) => [x.job_id, x]));
      for (const item of value as Array<{ job_id: string }>) byId.set(item.job_id, item);
      next[key] = [...byId.values()];
    } else if (key === "answers") {
      next.answers = { ...current.answers, ...(value as Record<string, string>) };
    } else {
      next[key] = value;
    }
  }
  return next as unknown as Blackboard;
}
