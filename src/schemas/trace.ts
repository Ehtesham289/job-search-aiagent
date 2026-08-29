import { z } from "zod";
import { NodeStatus } from "./taskgraph.js";

export const Usage = z.object({
  input_tokens: z.number().int().default(0),
  output_tokens: z.number().int().default(0),
  cache_read_tokens: z.number().int().default(0),
  cache_write_tokens: z.number().int().default(0),
  cost_usd: z.number().default(0),
});
export type Usage = z.infer<typeof Usage>;

/** §5 — one row per node, readable by both the user and whoever debugs this. */
export const TraceEntry = z.object({
  run_id: z.string(),
  node_id: z.string(),
  kind: z.string(),
  agent: z.string(),
  model: z.string().nullable(),
  status: NodeStatus,
  /** Hash rather than payload: traces stay small and stop leaking resumes. */
  input_hash: z.string(),
  output_summary: z.string(),
  usage: Usage,
  duration_ms: z.number(),
  attempts: z.number().int(),
  retries: z.number().int(),
  validation_failures: z.number().int(),
  error: z.string().nullable(),
  started_at: z.string(),
  finished_at: z.string(),
});
export type TraceEntry = z.infer<typeof TraceEntry>;

export const RunStatus = z.enum([
  "planning",
  "running",
  "awaiting_user",
  "completed",
  "partial",
  "failed",
]);
export type RunStatus = z.infer<typeof RunStatus>;
