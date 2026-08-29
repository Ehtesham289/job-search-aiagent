import type { Escalation } from "../schemas/common.js";
import type { NodeStatus } from "../schemas/taskgraph.js";
import type { Usage } from "../schemas/trace.js";

/**
 * L4 stream. The interface renders these as an "Agent activity" panel —
 * showing the work is what makes a multi-minute wait read as competence.
 */
export type ProgressEvent =
  | { type: "run_started"; run_id: string; brief: string }
  | { type: "plan"; nodes: number; parallel_branches: number; budget: string }
  /** The DAG's actual shape, emitted at dispatch and after every replan, so a
   *  client can draw the lattice rather than infer it from node events. */
  | {
      type: "graph";
      nodes: Array<{ id: string; kind: string; label: string; depends_on: string[]; optional: boolean }>;
      layers: string[][];
    }
  | { type: "node_started"; node_id: string; kind: string; agent: string; label: string }
  | { type: "node_progress"; node_id: string; message: string }
  | {
      type: "node_finished";
      node_id: string;
      kind: string;
      agent: string;
      status: NodeStatus;
      summary: string;
      model: string | null;
      usage: Usage;
      duration_ms: number;
    }
  | { type: "partial_results"; label: string; items: string[] }
  | { type: "escalation"; escalation: Escalation }
  | { type: "replan"; reason: string; added_nodes: string[] }
  | { type: "budget"; spent_usd: number; limit_usd: number; llm_calls: number; elapsed_ms: number }
  | { type: "run_finished"; status: string; summary: string; skipped: string[] };

export type EventSink = (ev: ProgressEvent) => void;

export const noopSink: EventSink = () => {};
