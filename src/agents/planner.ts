import { sha1 } from "../tools/embed.js";
import { type Budget, type TaskGraph, type TaskNode } from "../schemas/taskgraph.js";

/**
 * §2.1 Run decomposition. The task graphs every run is built from.
 *
 * These were once a fallback: a model planner drew the search DAG, and dropped
 * to `defaultSearchPlan` whenever it emitted something cyclic or dangling.
 * Measured over nine real plans across seven briefs — ordinary, vague,
 * hyper-specific, a career switch — it returned the same eleven nodes in the
 * same order every time, which is the one thing it existed not to do. The only
 * thing it did vary was each node's `limit`, and always downward: the match
 * rubric at 8-15 against a preset default of 30, JD analysis at 15-60 against
 * 60. So it charged $0.026 and ~23s per run to narrow the funnel, differently
 * each time for the same brief. The cheap/balanced/thorough presets set those
 * same numbers directly, for free and repeatably, so the planner went and the
 * deterministic plans became the only plans.
 */

interface NodeOpts {
  optional?: boolean;
  note?: string | null;
  limit?: number | null;
  broaden?: boolean;
  maxAttempts?: number;
}

export function node(id: string, kind: TaskNode["kind"], label: string, dependsOn: string[], opts: NodeOpts = {}): TaskNode {
  return {
    id,
    kind,
    label,
    depends_on: dependsOn,
    params: { note: opts.note ?? null, limit: opts.limit ?? null, broaden: opts.broaden ?? false },
    // Stable across replans and resumes: identity is the node's id, kind and
    // params — deliberately NOT its dependencies, so re-pointing a dependent
    // during a replan does not invalidate work already committed.
    idempotency_key: sha1(`${id}|${kind}|${opts.note ?? ""}|${opts.limit ?? ""}|${opts.broaden ?? false}`),
    max_attempts: opts.maxAttempts ?? 2,
    optional: opts.optional ?? false,
  };
}

/** The deterministic fallback, and the shape §7 walks through. */
/**
 * `broaden` starts the run with the title match already loosened. A
 * continuation has, by definition, already run the strict pass — everything it
 * can still find is adjacent, so requiring two shared title words again would
 * mostly re-reject what the first pass rejected.
 */
export function defaultSearchPlan(budget: Budget, broaden = false): TaskGraph {
  return {
    nodes: [
      node("query", "query_strategy", "Expand the brief into a search matrix", [], { broaden }),
      node("discover", "source_discovery", "Find and verify new career pages", [], { optional: true }),
      node("harvest", "harvest", "Pull postings from every source", ["query", "discover"]),
      node("dedupe", "dedupe", "Collapse duplicate postings", ["harvest"]),
      node("filter", "hard_filter", "Apply non-negotiable constraints", ["dedupe"], { broaden }),
      node("analyze", "jd_analysis", "Structure each surviving JD", ["filter"]),
      node("prescore", "prescore", "Vector and skill-graph shortlist", ["analyze"]),
      node("score", "match_score", "LLM rubric over the shortlist", ["prescore"]),
      node("reconcile", "reconcile", "Resolve composite/holistic disagreements", ["score"]),
      node("rank", "rank", "Order the final results", ["reconcile"]),
      node("curate", "memory_curate", "Commit learnings to long-term memory", ["rank"]),
    ],
    budget,
    success_criteria: ["at least 10 ranked results", "every result carries an explainable score"],
    notes: ["default plan"],
  };
}

/** The tailoring lane (§2.7). Added once the user picks a job. */
export function tailoringPlan(budget: Budget, jobId: string): TaskGraph {
  return {
    nodes: [
      node("gap", "gap_analysis", "Plan the edits", [], { note: jobId }),
      node("bind", "evidence_binding", "Bind every edit to the original resume", ["gap"], { note: jobId }),
      node("draft", "draft", "Write the bound edits", ["bind"], { note: jobId }),
      node("critic", "critic", "Adversarial review", ["draft"], { note: jobId }),
      node("render", "render", "PDF + DOCX + post-render ATS check", ["critic"], { note: jobId }),
      node("apply", "apply_resolve", "Resolve and verify the apply URL", ["render"], { note: jobId, optional: true }),
      node("curate_tailor", "memory_curate", "Commit learnings to long-term memory", ["render"]),
    ],
    budget,
    success_criteria: ["critic passes or the user is asked a specific question", "post-render ATS check passes"],
    notes: [`tailoring lane for job ${jobId}`],
  };
}

/**
 * §2.1 re-planning: a search that returns four results gets a broadening
 * branch, not an empty page. Deterministic because the remedy is known — the
 * planner's judgment was already spent choosing the original shape.
 */
export function broadenPlan(existing: TaskGraph, reason: string): TaskNode[] {
  const gen = existing.nodes.filter((n) => n.id.startsWith("broaden_")).length + 1;
  const suffix = `_b${gen}`;
  // Every node here is optional. Broadening tries to *add* postings to a thin
  // result set; if it cannot run — no budget left, a failed call — the run must
  // continue with what the first pass already found, not collapse because an
  // enhancement failed.
  return [
    node(`broaden_query${suffix}`, "query_strategy", "Broaden the search matrix", [], {
      broaden: true, note: reason, optional: true,
    }),
    node(`broaden_harvest${suffix}`, "harvest", "Re-harvest with the widened matrix", [`broaden_query${suffix}`], {
      optional: true,
    }),
    node(`broaden_dedupe${suffix}`, "dedupe", "Collapse duplicates", [`broaden_harvest${suffix}`], {
      optional: true,
    }),
    node(`broaden_filter${suffix}`, "hard_filter", "Apply constraints", [`broaden_dedupe${suffix}`], {
      broaden: true, optional: true,
    }),
  ];
}
