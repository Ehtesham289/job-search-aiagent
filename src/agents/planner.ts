import { z } from "zod";
import { sha1 } from "../tools/embed.js";
import { NodeKind, type Budget, type TaskGraph, type TaskNode } from "../schemas/taskgraph.js";
import type { ProfileSummary } from "../schemas/profile.js";
import { validateGraph } from "../orchestrator/dag.js";
import { type AgentContext, type AgentOutput, emptyOutput } from "./types.js";

/**
 * §2.1 Planner. Owns run decomposition, holds no tools: it plans, it does not
 * act. Its output is a DAG whose structural validity is checked in code — a
 * cyclic or dangling plan is a validation failure, and validation failure is a
 * control-flow path, not an exception.
 */
const SYSTEM = `You decompose a job-search run into a task DAG for a multi-agent system.

Available node kinds and what each does:
- query_strategy   expand the brief into a title/skill search matrix (no dependencies)
- source_discovery find and verify company career pages, growing a permanent registry
- harvest          pull postings from every selected source in parallel
- dedupe           collapse the same job posted to several boards (pure code)
- hard_filter      drop postings that fail non-negotiable constraints (pure code)
- jd_analysis      turn each surviving JD into structured requirements (cheap model, cached)
- prescore         vector + skill-graph scoring to pick the shortlist (pure code)
- match_score      LLM rubric over the shortlist only
- reconcile        re-score jobs where composite and holistic verdicts disagree
- rank             order the final results (pure code)
- memory_curate    write durable learnings back to long-term memory

Rules:
- Emit dependencies, not an order. Independent nodes run in parallel automatically,
  so do NOT chain nodes that do not actually depend on each other.
- source_discovery is independent of query_strategy and should run beside it.
- No cycles. Every depends_on must name a node you also emit.
- Every run ends with memory_curate.
- success_criteria are checkable statements, e.g. "at least 10 ranked results".
- Set optional:true only on nodes whose failure should degrade the run rather than
  stop it (source_discovery is the usual one).
- Use one node per kind unless the brief genuinely needs a second branch.`;

const PlannedNode = z.object({
  id: z.string(),
  kind: NodeKind,
  label: z.string(),
  depends_on: z.array(z.string()),
  note: z.string().nullable(),
  limit: z.number().int().nullable(),
  optional: z.boolean(),
});

const PlannerOutput = z.object({
  nodes: z.array(PlannedNode).min(3).max(20),
  success_criteria: z.array(z.string()),
  notes: z.array(z.string()),
});

export interface PlanRequest {
  brief: string;
  profile: ProfileSummary | null;
  registryStats: { verified: number; unresolved: number; dead: number };
  budget: Budget;
}

export async function plan(ctx: AgentContext, req: PlanRequest): Promise<AgentOutput & { graph: TaskGraph }> {
  const out = emptyOutput();

  const input = [
    `Brief: ${req.brief}`,
    req.profile
      ? `Candidate: ${req.profile.total_years} years, titles ${req.profile.canonical_titles.join(" / ")}, ` +
        `top skills ${req.profile.top_skills.slice(0, 12).join(", ")}, seniority hint ${req.profile.seniority_hint}`
      : `Candidate: no resume supplied yet`,
    `Registry: ${req.registryStats.verified} verified sources, ${req.registryStats.unresolved} unresolved, ${req.registryStats.dead} dead`,
    `Budget: $${req.budget.max_cost_usd} / ${Math.round(req.budget.max_wall_time_ms / 1000)}s / ${req.budget.max_llm_calls} LLM calls`,
  ].join("\n");

  let graph: TaskGraph;
  try {
    const res = await ctx.llm.structured({
      agent: "planner",
      // Planning is judgment; §4 puts it on the strongest tier.
      tier: "strong",
      systemPrompt: SYSTEM,
      input,
      schema: PlannerOutput,
      schemaName: "task_graph",
      maxTokens: 4000,
      effort: "high",
      signal: ctx.signal,
    });
    out.usage = res.usage;
    out.model = res.model;
    out.llmCalls = 1;
    out.attempts = res.attempts;
    out.validationFailures = res.validationFailures;

    graph = materialize(res.value.nodes, req.budget, res.value.success_criteria, res.value.notes);
    const problems = validateGraph(graph);
    if (problems.length > 0) {
      // §8: a failed LLM node falls back to a deterministic default rather than
      // failing the run. The default plan is the one in §7's example trace.
      out.summary = `planner emitted an invalid DAG (${problems.map((p) => `${p.node_id}: ${p.problem}`).join("; ")}); using the default plan`;
      out.degraded = out.summary;
      graph = defaultSearchPlan(req.budget);
    } else {
      out.summary = `DAG: ${graph.nodes.length} nodes, ${res.value.success_criteria.length} success criteria`;
    }
  } catch (err) {
    out.summary = `planner unavailable (${(err as Error).message}); using the default plan`;
    out.degraded = out.summary;
    graph = defaultSearchPlan(req.budget);
  }

  return { ...out, graph };
}

function materialize(
  nodes: Array<z.infer<typeof PlannedNode>>,
  budget: Budget,
  success: string[],
  notes: string[],
): TaskGraph {
  return {
    nodes: nodes.map((n) => node(n.id, n.kind, n.label, n.depends_on, { optional: n.optional, note: n.note, limit: n.limit })),
    budget,
    success_criteria: success,
    notes,
  };
}

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
