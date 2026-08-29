import type { NodeKind } from "../schemas/taskgraph.js";
import type { Tier } from "../config/models.js";
import type { Agent } from "../agents/types.js";
import { queryStrategist } from "../agents/queryStrategist.js";
import { sourceDiscovery } from "../agents/sourceDiscovery.js";
import { dedupe, harvest } from "../agents/harvester.js";
import { hardFilter, rank } from "../agents/filters.js";
import { jdAnalysis } from "../agents/jdAnalyst.js";
import { matchScore, prescore, reconcile } from "../agents/matchScorer.js";
import { gapAnalysis } from "../agents/tailoring/gapAnalysis.js";
import { evidenceBinding } from "../agents/tailoring/evidenceBinding.js";
import { draft } from "../agents/tailoring/draft.js";
import { critic } from "../agents/tailoring/critic.js";
import { render } from "../agents/tailoring/render.js";
import { applicationAgent } from "../agents/applicationAgent.js";
import { memoryCurator } from "../agents/memoryCurator.js";
import { emptyOutput } from "../agents/types.js";

export interface AgentSpec {
  agent: Agent;
  /** Name recorded on the trace. */
  name: string;
  /** null for pure-code nodes; the trace shows which nodes cost money. */
  tier: Tier | null;
}

/**
 * Every dispatchable node kind, and which agent owns it. Agents never appear
 * anywhere else in the orchestrator - the scheduler dispatches by kind and has
 * no idea what any of them do.
 */
export const AGENTS: Record<NodeKind, AgentSpec> = {
  query_strategy: { agent: queryStrategist, name: "query_strategist", tier: "strong" },
  source_discovery: { agent: sourceDiscovery, name: "source_discovery", tier: null },
  harvest: { agent: harvest, name: "harvester", tier: null },
  dedupe: { agent: dedupe, name: "dedupe (code)", tier: null },
  hard_filter: { agent: hardFilter, name: "hard_filter (code)", tier: null },
  jd_analysis: { agent: jdAnalysis, name: "jd_analyst", tier: "fast" },
  prescore: { agent: prescore, name: "prescore (code)", tier: null },
  match_score: { agent: matchScore, name: "match_scorer", tier: "mid" },
  reconcile: { agent: reconcile, name: "match_reconciler", tier: "mid" },
  rank: { agent: rank, name: "rank (code)", tier: null },
  gap_analysis: { agent: gapAnalysis, name: "gap_analysis", tier: "strong" },
  evidence_binding: { agent: evidenceBinding, name: "evidence_binding", tier: "strong" },
  draft: { agent: draft, name: "resume_drafter", tier: "strong" },
  critic: { agent: critic, name: "critic", tier: "strong" },
  render: { agent: render, name: "renderer (code)", tier: null },
  apply_resolve: { agent: applicationAgent, name: "application_agent", tier: null },
  memory_curate: { agent: memoryCurator, name: "memory_curator", tier: null },
  // The planner runs outside the DAG (it produces it); a `replan` node exists
  // so a re-plan is a first-class, traced event rather than a hidden mutation.
  replan: {
    agent: async () => emptyOutput("replan handled by the scheduler"),
    name: "planner",
    tier: "strong",
  },
};
