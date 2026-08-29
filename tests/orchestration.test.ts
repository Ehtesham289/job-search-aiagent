import { describe, expect, it } from "vitest";
import { defaultSearchPlan, node } from "../src/agents/planner.js";
import { blockedNodes, findCycle, isComplete, maxParallelism, readyNodes, topoLayers, validateGraph } from "../src/orchestrator/dag.js";
import { defaultBudget, Governor } from "../src/orchestrator/governor.js";
import { mergeBlackboard, emptyBlackboard } from "../src/state/blackboard.js";
import type { NodeStatus, TaskGraph } from "../src/schemas/taskgraph.js";

const budget = defaultBudget();

function graphOf(nodes: TaskGraph["nodes"]): TaskGraph {
  return { nodes, budget, success_criteria: [], notes: [] };
}

describe("DAG validation", () => {
  it("accepts the default plan", () => {
    expect(validateGraph(defaultSearchPlan(budget))).toEqual([]);
  });

  it("reports a dangling dependency by name", () => {
    const g = graphOf([node("a", "dedupe", "A", ["ghost"])]);
    expect(validateGraph(g)[0]!.problem).toContain("unknown node 'ghost'");
  });

  it("detects a cycle rather than hanging on it", () => {
    const g = graphOf([
      node("a", "dedupe", "A", ["c"]),
      node("b", "dedupe", "B", ["a"]),
      node("c", "dedupe", "C", ["b"]),
    ]);
    expect(findCycle(g.nodes)).not.toBeNull();
    expect(validateGraph(g).some((p) => p.problem.startsWith("cycle:"))).toBe(true);
  });

  it("reports duplicate ids", () => {
    const g = graphOf([node("a", "dedupe", "A", []), node("a", "rank", "A again", [])]);
    expect(validateGraph(g).some((p) => p.problem === "duplicate node id")).toBe(true);
  });
});

describe("scheduling", () => {
  const g = defaultSearchPlan(budget);

  it("dispatches independent nodes together", () => {
    const ready = readyNodes(g, {});
    expect(ready.map((n) => n.id).sort()).toEqual(["discover", "query"]);
    expect(maxParallelism(g)).toBe(2);
  });

  it("holds a node until every dependency is satisfied", () => {
    expect(readyNodes(g, { query: "done" }).map((n) => n.id)).toEqual(["discover"]);
    const both: Record<string, NodeStatus> = { query: "done", discover: "done" };
    expect(readyNodes(g, both).map((n) => n.id)).toEqual(["harvest"]);
  });

  it("treats a skipped optional node as satisfied so it cannot deadlock the run", () => {
    const statuses: Record<string, NodeStatus> = { query: "done", discover: "skipped" };
    expect(readyNodes(g, statuses).map((n) => n.id)).toEqual(["harvest"]);
  });

  it("identifies work blocked behind a hard failure", () => {
    const statuses: Record<string, NodeStatus> = { query: "done", discover: "done", harvest: "failed" };
    const blocked = blockedNodes(g, statuses).map((n) => n.id);
    expect(blocked).toContain("dedupe");
    expect(blocked).toContain("rank");
    expect(blocked).not.toContain("harvest");
  });

  it("layers the plan for reporting", () => {
    const layers = topoLayers(g);
    expect(layers[0]!.sort()).toEqual(["discover", "query"]);
    expect(layers.at(-1)).toEqual(["curate"]);
  });

  it("is complete once nothing is pending", () => {
    const statuses = Object.fromEntries(g.nodes.map((n) => [n.id, "done" as NodeStatus]));
    expect(isComplete(g, statuses)).toBe(true);
    expect(isComplete(g, {})).toBe(false);
  });
});

describe("budget governor", () => {
  it("breaches on cost and names the dimension", () => {
    const gov = new Governor(defaultBudget({ max_cost_usd: 0.01 }));
    expect(gov.check()).toBeNull();
    gov.record({ input_tokens: 100, output_tokens: 100, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.02 }, 1);
    const breach = gov.check();
    expect(breach?.dimension).toBe("cost");
    expect(breach?.message).toContain("$0.02");
  });

  it("breaches on call count", () => {
    const gov = new Governor(defaultBudget({ max_llm_calls: 2 }));
    gov.record({ input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 }, 2);
    expect(gov.check()?.dimension).toBe("llm_calls");
  });

  it("restores prior spend so a resumed run cannot spend the budget twice", () => {
    const gov = new Governor(defaultBudget({ max_cost_usd: 0.1 }));
    gov.restore({
      usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.09 },
      llmCalls: 5,
      elapsedMs: 1000,
    });
    expect(gov.remaining().cost_usd).toBeCloseTo(0.01, 5);
    expect(gov.spent().llm_calls).toBe(5);
  });
});

describe("blackboard reducer", () => {
  const base = emptyBlackboard("brief");

  it("unions id lists so parallel harvesters each contribute", () => {
    const a = mergeBlackboard(base, { harvested_job_ids: ["1", "2"] });
    const b = mergeBlackboard(a, { harvested_job_ids: ["2", "3"] });
    expect(b.harvested_job_ids.sort()).toEqual(["1", "2", "3"]);
  });

  it("appends critiques and escalations", () => {
    const a = mergeBlackboard(base, { critiques: [{ verdict: "reject", findings: [], confidence: 1 }] });
    const b = mergeBlackboard(a, { critiques: [{ verdict: "pass", findings: [], confidence: 1 }] });
    expect(b.critiques.map((c) => c.verdict)).toEqual(["reject", "pass"]);
  });

  it("upserts matches by job id so reconciliation rewrites rather than duplicates", () => {
    const first = mergeBlackboard(base, {
      matches: [{ job_id: "j1", overall: 50 } as never, { job_id: "j2", overall: 60 } as never],
    });
    const second = mergeBlackboard(first, { matches: [{ job_id: "j1", overall: 80 } as never] });
    expect(second.matches).toHaveLength(2);
    expect(second.matches.find((m) => m.job_id === "j1")!.overall).toBe(80);
  });

  it("leaves scalars as last-write-wins", () => {
    const a = mergeBlackboard(base, { revision: 1, selected_job_id: "j1" });
    const b = mergeBlackboard(a, { revision: 2 });
    expect(b.revision).toBe(2);
    expect(b.selected_job_id).toBe("j1");
  });
});

describe("budget governor and free work", () => {
  it("does not charge zero-cost heuristic steps against the model-call ceiling", () => {
    const gov = new Governor(defaultBudget({ max_llm_calls: 3 }));
    const free = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 };
    for (let i = 0; i < 50; i++) gov.record(free, 1);
    // Fifty free steps must not stop an offline run that has spent nothing.
    expect(gov.check()).toBeNull();
    expect(gov.spent().llm_calls).toBe(0);
  });

  it("still stops once real calls hit the ceiling", () => {
    const gov = new Governor(defaultBudget({ max_llm_calls: 2 }));
    const paid = { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.001 };
    gov.record(paid, 2);
    expect(gov.check()?.dimension).toBe("llm_calls");
  });
});

describe("budget enforcement granularity", () => {
  it("charges each model call as it settles, not once per node", async () => {
    // The bug this pins: accounting only when a node returned left
    // `remaining()` frozen for the whole of a fan-out, so a node making
    // dozens of calls could not see its own budget shrinking and blew
    // straight through the ceiling.
    const { LlmClient } = await import("../src/llm/client.js");
    const { ScriptedProvider } = await import("../src/llm/provider.js");
    const { z } = await import("zod");

    const gov = new Governor(defaultBudget({ max_cost_usd: 0.05 }));
    const client = new LlmClient(
      new ScriptedProvider(new Map([["probe", () => ({ ok: true })]])),
    );
    client.onUsage((usage, calls) => gov.record(usage, calls));

    const Schema = z.object({ ok: z.boolean() });
    const call = () =>
      client.structured({
        agent: "t", tier: "strong", systemPrompt: "x".repeat(40_000),
        input: "y".repeat(40_000), schema: Schema, schemaName: "probe",
      });

    await call();
    const afterOne = gov.spent().cost_usd;
    expect(afterOne).toBeGreaterThan(0);
    expect(gov.spent().llm_calls).toBe(1);

    // The second call must see the first already charged.
    await call();
    expect(gov.spent().cost_usd).toBeGreaterThan(afterOne);
    expect(gov.spent().llm_calls).toBe(2);
  });
});

/**
 * The nine-node plan that returned nothing.
 *
 * A planner emitted query → discover → harvest → dedupe → filter → analyse →
 * prescore → rank → curate, leaving `match_score` out. Structurally it was
 * flawless: no cycles, every dependency present. But `rank` reads `matches`
 * and only `match_score` writes it, so a run that harvested 6,225 postings and
 * filtered them to 53 good ones ranked an empty list and returned zero.
 */
describe("a plan that cannot produce an answer", () => {
  const n = (id: string, kind: string, depends_on: string[]) => ({
    id, kind, label: id, depends_on,
    params: { note: null, limit: null, broaden: false },
    idempotency_key: id, max_attempts: 2, optional: false,
  });

  const graph = (nodes: ReturnType<typeof n>[]) =>
    ({ nodes, budget: defaultBudget(), success_criteria: [], notes: [] }) as unknown as TaskGraph;

  it("rejects a graph whose rank step has nothing to rank", () => {
    const problems = validateGraph(
      graph([
        n("q", "query_strategy", []),
        n("h", "harvest", ["q"]),
        n("d", "dedupe", ["h"]),
        n("f", "hard_filter", ["d"]),
        n("p", "prescore", ["f"]),
        n("r", "rank", ["p"]), // no match_score anywhere
        n("c", "memory_curate", ["r"]),
      ]),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]!.node_id).toBe("r");
    expect(problems[0]!.problem).toMatch(/reads 'matches'/);
  });

  it("accepts the same graph once the scoring step is present", () => {
    expect(
      validateGraph(
        graph([
          n("q", "query_strategy", []),
          n("h", "harvest", ["q"]),
          n("d", "dedupe", ["h"]),
          n("f", "hard_filter", ["d"]),
          n("p", "prescore", ["f"]),
          n("s", "match_score", ["p"]),
          n("r", "rank", ["s"]),
        ]),
      ),
    ).toEqual([]);
  });

  it("catches a step wired to a sibling instead of its producer", () => {
    // `harvest` reads the query plan; depending on discovery instead is the
    // kind of plausible-looking mis-wiring that used to pass validation.
    const problems = validateGraph(
      graph([n("q", "query_strategy", []), n("disc", "source_discovery", []), n("h", "harvest", ["disc"])]),
    );
    expect(problems.map((p) => p.problem)).toEqual([
      "reads 'query_plan' but no node it depends on produces it",
    ]);
  });

  it("still accepts the shipped default plan", () => {
    expect(validateGraph(defaultSearchPlan(defaultBudget()))).toEqual([]);
  });
});
