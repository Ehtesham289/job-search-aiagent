import type { Escalation } from "../schemas/common.js";
import type { Usage } from "../schemas/trace.js";
import type { Blackboard } from "../state/blackboard.js";
import type { Store } from "../state/store.js";
import type { LlmClient } from "../llm/client.js";
import type { Embedder } from "../tools/embed.js";
import type { NodeParams, TaskNode } from "../schemas/taskgraph.js";
import type { ProgressEvent } from "../orchestrator/events.js";

export interface AgentContext {
  runId: string;
  store: Store;
  llm: LlmClient;
  embedder: Embedder;
  emit(ev: ProgressEvent): void;
  signal?: AbortSignal;
  /** Remaining budget at dispatch time; agents that fan out consult it. */
  remaining(): { tokens: number; cost_usd: number; wall_ms: number; llm_calls: number };
}

export interface AgentInput {
  node: TaskNode;
  params: NodeParams;
  board: Blackboard;
}

/**
 * Every agent returns to the orchestrator; none call each other. The board
 * update is the only channel between agents, and it is typed.
 */
export interface AgentOutput {
  board: Partial<Blackboard>;
  /** One line for the activity panel and the trace. */
  summary: string;
  usage: Usage;
  model: string | null;
  llmCalls: number;
  attempts: number;
  validationFailures: number;
  escalations: Escalation[];
  /** Node-level soft failure: the run continues, degraded and labelled. */
  degraded?: string;
}

export type Agent = (ctx: AgentContext, input: AgentInput) => Promise<AgentOutput>;

export function emptyOutput(summary = ""): AgentOutput {
  return {
    board: {},
    summary,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 },
    model: null,
    llmCalls: 0,
    attempts: 0,
    validationFailures: 0,
    escalations: [],
  };
}

let escalationCounter = 0;

export function escalation(node: string, agent: string, e: Omit<Escalation, "id" | "node_id" | "agent">): Escalation {
  return {
    id: `esc_${Date.now().toString(36)}_${(escalationCounter++).toString(36)}`,
    node_id: node,
    agent,
    ...e,
  };
}
