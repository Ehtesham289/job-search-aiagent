import type { NodeStatus, TaskGraph, TaskNode } from "../schemas/taskgraph.js";

export interface GraphProblem {
  node_id: string;
  problem: string;
}

/**
 * Structural validation the schema cannot express: dangling dependencies,
 * cycles, duplicate ids, unreachable work. A planner that emits a cyclic graph
 * gets the specific problem back and re-plans — the same
 * validation-failure-is-control-flow path the LLM client uses.
 */
export function validateGraph(graph: TaskGraph): GraphProblem[] {
  const problems: GraphProblem[] = [];
  const ids = new Set<string>();

  for (const n of graph.nodes) {
    if (ids.has(n.id)) problems.push({ node_id: n.id, problem: "duplicate node id" });
    ids.add(n.id);
  }
  for (const n of graph.nodes) {
    for (const dep of n.depends_on) {
      if (!ids.has(dep)) problems.push({ node_id: n.id, problem: `depends on unknown node '${dep}'` });
      if (dep === n.id) problems.push({ node_id: n.id, problem: "depends on itself" });
    }
  }

  const cycle = findCycle(graph.nodes);
  if (cycle) problems.push({ node_id: cycle[0]!, problem: `cycle: ${cycle.join(" -> ")}` });

  problems.push(...missingInputs(graph));

  return problems;
}

/* ── dataflow ─────────────────────────────────────────────────────────────
 *
 * What each node kind reads from the blackboard and what it writes back.
 *
 * A DAG can be perfectly well-formed — no cycles, every dependency resolvable
 * — and still be incapable of producing an answer. A planner once emitted a
 * nine-node graph that went prescore → rank and simply left `match_score` out.
 * Nothing was invalid: `rank` depended on `prescore`, which existed. But
 * `rank` reads `matches`, and only `match_score` writes it, so it ranked an
 * empty list and the run returned nothing after harvesting 6,225 postings and
 * filtering them to 53 good ones.
 *
 * Structural validity was never the property that mattered. This is.
 */
const WRITES: Partial<Record<TaskNode["kind"], readonly string[]>> = {
  query_strategy: ["query_plan"],
  harvest: ["harvested_job_ids"],
  dedupe: ["unique_job_ids"],
  hard_filter: ["filtered_job_ids"],
  jd_analysis: ["analyzed_job_ids"],
  prescore: ["prescores"],
  match_score: ["matches"],
  reconcile: ["matches"],
  rank: ["ranked_job_ids"],
};

const READS: Partial<Record<TaskNode["kind"], readonly string[]>> = {
  harvest: ["query_plan"],
  dedupe: ["harvested_job_ids"],
  hard_filter: ["unique_job_ids"],
  jd_analysis: ["filtered_job_ids"],
  prescore: ["filtered_job_ids"],
  match_score: ["prescores"],
  // `reconcile` re-scores what the rubric produced; with nothing to reconcile
  // it is a harmless no-op, so it is not listed as a hard requirement here.
  rank: ["matches"],
};

/** Every key a node reads must be written by something it depends on. */
function missingInputs(graph: TaskGraph): GraphProblem[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const problems: GraphProblem[] = [];

  const writtenUpstream = (start: TaskNode): Set<string> => {
    const keys = new Set<string>();
    const seen = new Set<string>([start.id]);
    const queue = [...start.depends_on];
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const n = byId.get(id);
      if (!n) continue;
      for (const k of WRITES[n.kind] ?? []) keys.add(k);
      queue.push(...n.depends_on);
    }
    return keys;
  };

  for (const n of graph.nodes) {
    const needs = READS[n.kind] ?? [];
    if (needs.length === 0) continue;
    const have = writtenUpstream(n);
    for (const key of needs) {
      if (!have.has(key)) {
        problems.push({
          node_id: n.id,
          problem: `reads '${key}' but no node it depends on produces it`,
        });
      }
    }
  }
  return problems;
}

export function findCycle(nodes: TaskNode[]): string[] | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const state = new Map<string, 0 | 1 | 2>(); // 0 unvisited, 1 on stack, 2 done
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    const s = state.get(id) ?? 0;
    if (s === 1) return [...stack.slice(stack.indexOf(id)), id];
    if (s === 2) return null;
    state.set(id, 1);
    stack.push(id);
    for (const dep of byId.get(id)?.depends_on ?? []) {
      if (!byId.has(dep)) continue;
      const found = visit(dep);
      if (found) return found;
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };

  for (const n of nodes) {
    const found = visit(n.id);
    if (found) return found;
  }
  return null;
}

/**
 * Every node whose dependencies are satisfied. The scheduler dispatches all of
 * them in one superstep — that is where the parallelism in §4 comes from, and
 * it needs no explicit "parallel" marking in the plan.
 */
export function readyNodes(graph: TaskGraph, statuses: Record<string, NodeStatus>): TaskNode[] {
  return graph.nodes.filter((n) => {
    if ((statuses[n.id] ?? "pending") !== "pending") return false;
    return n.depends_on.every((d) => {
      const s = statuses[d];
      // `skipped` counts as satisfied: an optional node that degraded must not
      // deadlock the nodes behind it.
      return s === "done" || s === "skipped";
    });
  });
}

export function isComplete(graph: TaskGraph, statuses: Record<string, NodeStatus>): boolean {
  return graph.nodes.every((n) => {
    const s = statuses[n.id] ?? "pending";
    return s === "done" || s === "skipped" || s === "failed" || s === "escalated";
  });
}

/** Nodes that can never run because something they need failed outright. */
export function blockedNodes(graph: TaskGraph, statuses: Record<string, NodeStatus>): TaskNode[] {
  const bad = new Set(
    graph.nodes.filter((n) => statuses[n.id] === "failed" || statuses[n.id] === "escalated").map((n) => n.id),
  );
  if (bad.size === 0) return [];
  const blocked: TaskNode[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of graph.nodes) {
      if ((statuses[n.id] ?? "pending") !== "pending" || bad.has(n.id)) continue;
      if (n.depends_on.some((d) => bad.has(d))) {
        bad.add(n.id);
        blocked.push(n);
        changed = true;
      }
    }
  }
  return blocked;
}

/** Layered view, for reporting how much of the plan actually runs in parallel. */
export function topoLayers(graph: TaskGraph): string[][] {
  const remaining = new Map(graph.nodes.map((n) => [n.id, new Set(n.depends_on)]));
  const layers: string[][] = [];
  const done = new Set<string>();
  while (remaining.size > 0) {
    const layer = [...remaining.entries()].filter(([, deps]) => [...deps].every((d) => done.has(d) || !remaining.has(d))).map(([id]) => id);
    if (layer.length === 0) break; // cycle; validateGraph reports it
    layers.push(layer);
    for (const id of layer) {
      remaining.delete(id);
      done.add(id);
    }
  }
  return layers;
}

export function maxParallelism(graph: TaskGraph): number {
  return topoLayers(graph).reduce((m, l) => Math.max(m, l.length), 0);
}
