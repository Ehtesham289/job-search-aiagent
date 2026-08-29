import { z } from "zod";

/** Every node kind the scheduler knows how to dispatch. */
export const NodeKind = z.enum([
  "query_strategy",
  "source_discovery",
  "harvest",
  "dedupe",
  "hard_filter",
  "jd_analysis",
  "prescore",
  "match_score",
  "reconcile",
  "rank",
  "gap_analysis",
  "evidence_binding",
  "draft",
  "critic",
  "render",
  "apply_resolve",
  "memory_curate",
  "replan",
]);
export type NodeKind = z.infer<typeof NodeKind>;

export const Budget = z.object({
  max_tokens: z.number().int().positive(),
  max_cost_usd: z.number().positive(),
  max_wall_time_ms: z.number().int().positive(),
  max_llm_calls: z.number().int().positive(),
});
export type Budget = z.infer<typeof Budget>;

/**
 * Deliberately closed rather than a free-form record. Runtime data (job ids,
 * source ids, drafts) travels on the blackboard, not through node params — an
 * agent reads a validated record, never another agent's improvised payload.
 */
export const NodeParams = z.object({
  /** Per-kind hint the owning agent interprets. */
  note: z.string().nullable(),
  /** Cap on items this node processes; null means the agent default. */
  limit: z.number().int().nullable(),
  /** Set by a replan widening a search that returned too little. */
  broaden: z.boolean(),
});
export type NodeParams = z.infer<typeof NodeParams>;

export const TaskNode = z.object({
  id: z.string(),
  kind: NodeKind,
  /** Human-readable, shows up in the Agent activity panel. */
  label: z.string(),
  /** Ids of nodes that must be `done` before this one is dispatchable. */
  depends_on: z.array(z.string()).default([]),
  params: NodeParams,
  /**
   * Stable across replans and resumes. A resumed run skips any node whose
   * idempotency key already has a committed result.
   */
  idempotency_key: z.string(),
  max_attempts: z.number().int().min(1).max(5).default(2),
  /** Nodes marked optional degrade the run; they never fail it. */
  optional: z.boolean().default(false),
});
export type TaskNode = z.infer<typeof TaskNode>;

export const TaskGraph = z.object({
  nodes: z.array(TaskNode).min(1),
  budget: Budget,
  success_criteria: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]),
});
export type TaskGraph = z.infer<typeof TaskGraph>;

export const NodeStatus = z.enum(["pending", "running", "done", "failed", "skipped", "escalated"]);
export type NodeStatus = z.infer<typeof NodeStatus>;
