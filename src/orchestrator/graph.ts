import { Annotation, Command, END, INTERRUPT, Send, START, StateGraph, interrupt, isGraphInterrupt } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { env } from "../config/env.js";
import { addUsage, emptyUsage, type LlmClient } from "../llm/client.js";
import type { Escalation } from "../schemas/common.js";
import type { NodeStatus, TaskGraph, TaskNode } from "../schemas/taskgraph.js";
import type { RunStatus, TraceEntry, Usage } from "../schemas/trace.js";
import { emptyBlackboard, mergeBlackboard, type Blackboard } from "../state/blackboard.js";
import type { Store } from "../state/store.js";
import { sha1, type Embedder } from "../tools/embed.js";
import type { AgentContext, AgentOutput } from "../agents/types.js";
import { blockedNodes, isComplete, maxParallelism, readyNodes, topoLayers, validateGraph } from "./dag.js";
import { noopSink, type EventSink } from "./events.js";
import { Governor } from "./governor.js";
import { AGENTS } from "./registry.js";
import { broadenPlan, node as makeNode } from "../agents/planner.js";

/* ── Run state ────────────────────────────────────────────────────────────
 * Channels, not a mutable object. Parallel nodes in one superstep each return
 * a partial update and the reducers merge them — which is what makes fan-in
 * automatic and checkpoints coherent.
 */
const RunState = Annotation.Root({
  runId: Annotation<string>({ reducer: (_a, b) => b, default: () => "" }),
  graph: Annotation<TaskGraph | null>({ reducer: mergeGraph, default: () => null }),
  statuses: Annotation<Record<string, NodeStatus>>({ reducer: (a, b) => ({ ...a, ...b }), default: () => ({}) }),
  attempts: Annotation<Record<string, number>>({ reducer: (a, b) => ({ ...a, ...b }), default: () => ({}) }),
  board: Annotation<Blackboard, Partial<Blackboard>>({ reducer: mergeBlackboard, default: () => emptyBlackboard("") }),
  usage: Annotation<Usage>({ reducer: addUsage, default: emptyUsage }),
  llmCalls: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
  stopReason: Annotation<string | null>({ reducer: (a, b) => b ?? a, default: () => null }),
});

type RunStateType = typeof RunState.State;
/** What a node may return: channel *update* types, not channel value types.
 *  The board channel takes a partial, which is what makes parallel nodes able
 *  to each contribute their slice. */
type RunUpdate = typeof RunState.Update;

/** Replans add nodes and re-point dependents; both arrive as graph updates. */
function mergeGraph(a: TaskGraph | null, b: TaskGraph | null): TaskGraph | null {
  if (!b) return a;
  if (!a) return b;
  const byId = new Map(a.nodes.map((n) => [n.id, n]));
  for (const n of b.nodes) byId.set(n.id, n);
  return {
    nodes: [...byId.values()],
    budget: b.budget ?? a.budget,
    success_criteria: [...new Set([...a.success_criteria, ...b.success_criteria])],
    notes: [...new Set([...a.notes, ...b.notes])],
  };
}

/* ── Runtime wiring ───────────────────────────────────────────────────────*/

export interface RunDeps {
  store: Store;
  llm: LlmClient;
  embedder: Embedder;
  emit: EventSink;
  governor: Governor;
  signal?: AbortSignal;
}

export interface RunOptions {
  runId: string;
  brief: string;
  graph: TaskGraph;
  board?: Partial<Blackboard>;
  deps: RunDeps;
  /** Defaults to the SQLite checkpointer beside the main store. */
  checkpointer?: BaseCheckpointSaver;
  /** Resume payload for a run paused on a blocking escalation. */
  resume?: Record<string, string>;
}

export interface RunResult {
  runId: string;
  status: RunStatus;
  board: Blackboard;
  trace: TraceEntry[];
  spent: ReturnType<Governor["spent"]>;
  escalations: Escalation[];
  stopReason: string | null;
}

/**
 * L3 orchestration. A planner-produced DAG executed by a scheduler that
 * dispatches every ready node in one superstep, fans in automatically, and
 * checkpoints after each superstep.
 *
 * Scheduling, persistence and human-in-the-loop pause come from LangGraph;
 * what lives here is the policy the spec calls for — budget enforcement,
 * idempotency, replanning and escalation.
 */
export async function runGraph(opts: RunOptions): Promise<RunResult> {
  const { deps } = opts;
  const checkpointer = opts.checkpointer ?? SqliteSaver.fromConnString(`${env.dbPath}.checkpoints`);

  const problems = validateGraph(opts.graph);
  if (problems.length > 0) {
    throw new Error(`invalid task graph: ${problems.map((p) => `${p.node_id}: ${p.problem}`).join("; ")}`);
  }

  // The dispatcher is its own node on purpose. Hanging the router off
  // `execute` would run it once per parallel task, and every ready node would
  // be dispatched N times in the next superstep. Routing from a single
  // dispatch node makes the fan-in explicit and the scheduling exactly-once.
  const workflow = new StateGraph(RunState)
    .addNode("dispatch", () => ({}))
    .addNode("execute", (payload: unknown) => executeNode(payload as ExecutePayload, deps))
    .addNode("finalize", (state: RunStateType) => finalize(state, deps))
    .addEdge(START, "dispatch")
    .addConditionalEdges("dispatch", (state: RunStateType) => route(state, deps), ["execute", "finalize"])
    .addEdge("execute", "dispatch")
    .addEdge("finalize", END);

  // Spend reaches the governor as each request settles, so a fan-out node can
  // see its own budget shrinking and stop.
  deps.llm.onUsage((usage, calls) => deps.governor.record(usage, calls));
  deps.llm.onBudgetCheck(() => deps.governor.check()?.message ?? null);

  const app = workflow.compile({ checkpointer });
  const config = { configurable: { thread_id: opts.runId }, recursionLimit: 100 };

  deps.emit({
    type: "plan",
    nodes: opts.graph.nodes.length,
    parallel_branches: maxParallelism(opts.graph),
    budget: `$${opts.graph.budget.max_cost_usd} / ${Math.round(opts.graph.budget.max_wall_time_ms / 1000)}s / ${opts.graph.budget.max_llm_calls} calls`,
  });
  emitGraph(deps, opts.graph);

  const initial: RunUpdate = {
    runId: opts.runId,
    graph: opts.graph,
    board: mergeBlackboard(emptyBlackboard(opts.brief), { ...opts.board, brief: opts.brief }),
    statuses: {},
    attempts: {},
  };

  let final: RunStateType;

  try {
    final = opts.resume
      ? ((await app.invoke(new Command({ resume: opts.resume }), config)) as RunStateType)
      : ((await app.invoke(initial, config)) as RunStateType);
  } catch (err) {
    // Older LangGraph surfaced an interrupt by throwing; current versions
    // return it in the result. Handle both so the pause is never mistaken
    // for a completion.
    if (isGraphInterrupt(err)) {
      const snapshot = (await app.getState(config)).values as RunStateType;
      return assemble(opts, deps, snapshot, "awaiting_user");
    }
    throw err;
  }

  // A blocking escalation. The checkpoint holds everything; the run resumes
  // exactly here once the user answers.
  if (INTERRUPT in (final as object)) {
    return assemble(opts, deps, final, "awaiting_user");
  }

  const breach = deps.governor.check();
  const status: RunStatus = breach
    ? "partial"
    : deps.store.listEscalations(opts.runId, true).some((e) => e.blocking)
      ? "awaiting_user"
      : final.board.skipped.length > 0
        ? "partial"
        : "completed";

  return assemble(opts, deps, final, status);
}

function assemble(opts: RunOptions, deps: RunDeps, state: RunStateType, status: RunStatus): RunResult {
  const trace = deps.store.listTrace(opts.runId);
  // From the store rather than the board: an interrupt discards the pausing
  // node's state writes, and the question that caused the pause is exactly the
  // thing the caller must not lose.
  const escalations = deps.store.listEscalations(opts.runId).map(({ answer, ...e }) => {
    void answer;
    return e;
  });
  const result: RunResult = {
    runId: opts.runId,
    status,
    board: state.board,
    trace,
    spent: deps.governor.spent(),
    escalations,
    stopReason: state.stopReason,
  };

  deps.store.saveRun({
    id: opts.runId,
    brief: opts.brief,
    status,
    budget: opts.graph.budget,
    plan: state.graph,
    blackboard: state.board as unknown as Record<string, unknown>,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  deps.emit({
    type: "run_finished",
    status,
    summary:
      `${trace.length} nodes, $${result.spent.cost_usd.toFixed(4)}, ` +
      `${result.spent.llm_calls} model calls, ${Math.round(result.spent.elapsed_ms / 1000)}s`,
    skipped: state.board.skipped,
  });
  return result;
}

/* ── Scheduler ────────────────────────────────────────────────────────────*/

interface ExecutePayload {
  nodeId: string;
  snapshot: RunStateType;
}

/**
 * One superstep: every node whose dependencies are satisfied is dispatched at
 * once. Nodes carry a snapshot of the state as of the fan-in, so parallel
 * siblings all see the same inputs — the property that makes the DAG's
 * semantics well defined and a resumed run reproducible.
 */
function route(state: RunStateType, deps: RunDeps): Send[] | "finalize" {
  const graph = state.graph;
  if (!graph) return "finalize";

  // Deliberately not halting on a budget breach. The governor's job is to stop
  // spending, which it now does at the call site; stopping the *graph* also
  // skipped the free deterministic nodes, so a breached run returned nothing
  // despite having already paid for the analysis behind it.
  if (isComplete(graph, state.statuses)) return "finalize";

  const ready = readyNodes(graph, state.statuses);
  if (ready.length === 0) {
    // Nothing ready and nothing running: whatever remains is blocked behind a
    // failure. Mark it and finish rather than deadlocking.
    return "finalize";
  }

  deps.emit({
    type: "budget",
    spent_usd: deps.governor.spent().cost_usd,
    limit_usd: deps.governor.limits.max_cost_usd,
    llm_calls: deps.governor.spent().llm_calls,
    elapsed_ms: deps.governor.elapsedMs(),
  });

  return ready.map((n) => new Send("execute", { nodeId: n.id, snapshot: state } satisfies ExecutePayload));
}

async function executeNode(payload: ExecutePayload, deps: RunDeps): Promise<RunUpdate> {
  const { nodeId, snapshot } = payload;
  const graph = snapshot.graph!;
  const taskNode = graph.nodes.find((n) => n.id === nodeId)!;
  const spec = AGENTS[taskNode.kind];
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  // 4 idempotency: a resumed run reads the committed result rather than
  // re-doing the work or double-charging for it. Scoped to this run — a fresh
  // run must do its own work even when its plan is identical.
  //
  // A node that *declined* to act because it was waiting on an answer is the
  // exception: its result is not work worth keeping, it is a refusal, and
  // replaying it means answering the question changes nothing. The renderer
  // refusing over unresolved critic rejections was exactly this — the console
  // offered "Keep the original wording", the user answered, and the cached
  // refusal came straight back.
  const committed = deps.store.getNodeResult(snapshot.runId, taskNode.idempotency_key);
  const declined = (committed?.result as Partial<Blackboard> | undefined)?.skipped?.length ?? 0;
  const answered = Object.keys(snapshot.board.answers ?? {}).length > 0;
  if (committed && committed.status === "done" && !(declined > 0 && answered)) {
    const cachedBoard = committed.result as Partial<Blackboard>;
    const summary = "replayed from checkpoint (idempotency hit)";
    // A replay still earns a trace row, so the trace of a resumed run shows
    // the whole plan rather than only the part that ran after the pause.
    deps.store.appendTrace({
      run_id: snapshot.runId,
      node_id: nodeId,
      kind: taskNode.kind,
      agent: spec.name,
      model: null,
      status: "done",
      input_hash: taskNode.idempotency_key,
      output_summary: summary,
      usage: emptyUsage(),
      duration_ms: 0,
      attempts: 0,
      retries: 0,
      validation_failures: 0,
      error: null,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    });
    deps.emit({
      type: "node_finished",
      node_id: nodeId,
      kind: taskNode.kind,
      agent: spec.name,
      status: "done",
      summary,
      model: null,
      usage: emptyUsage(),
      duration_ms: 0,
    });
    return { statuses: { [nodeId]: "done" }, board: cachedBoard };
  }

  deps.emit({ type: "node_started", node_id: nodeId, kind: taskNode.kind, agent: spec.name, label: taskNode.label });

  const attempt = (snapshot.attempts[nodeId] ?? 0) + 1;
  const ctx: AgentContext = {
    runId: snapshot.runId,
    store: deps.store,
    llm: deps.llm,
    embedder: deps.embedder,
    emit: deps.emit,
    signal: deps.signal,
    remaining: () => deps.governor.remaining(),
  };

  let output: AgentOutput;
  let status: NodeStatus = "done";
  let error: string | null = null;

  try {
    output = await spec.agent(ctx, { node: taskNode, params: taskNode.params, board: snapshot.board });
  } catch (err) {
    if (isGraphInterrupt(err)) throw err;
    error = (err as Error).message;
    output = {
      board: {},
      summary: `failed: ${error}`,
      usage: emptyUsage(),
      model: null,
      llmCalls: 0,
      attempts: attempt,
      validationFailures: 0,
      escalations: [],
    };
    // 8: retry within the node's cap, then degrade if optional, then fail.
    if (attempt < taskNode.max_attempts) {
      status = "pending";
    } else if (taskNode.optional) {
      status = "skipped";
      output.board = { skipped: [`${taskNode.label}: ${error}`] };
    } else {
      status = "failed";
    }
  }

  // Not recorded here: the client already charged each call as it happened.
  // Recording again would double every model cost in the run.

  // Escalations are persisted before anything else: they are the run's
  // user-facing output even when everything after them fails.
  for (const e of output.escalations) deps.store.putEscalation(snapshot.runId, e);
  for (const e of output.escalations) deps.emit({ type: "escalation", escalation: e });

  const duration = Date.now() - t0;
  const trace: TraceEntry = {
    run_id: snapshot.runId,
    node_id: nodeId,
    kind: taskNode.kind,
    agent: spec.name,
    model: output.model,
    status: status === "pending" ? "failed" : status,
    input_hash: sha1(`${taskNode.idempotency_key}|${snapshot.board.unique_job_ids.length}|${snapshot.board.revision}`),
    output_summary: output.summary || "(no summary)",
    usage: output.usage,
    duration_ms: duration,
    attempts: attempt,
    retries: attempt - 1,
    validation_failures: output.validationFailures,
    error,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  };
  deps.store.appendTrace(trace);

  deps.emit({
    type: "node_finished",
    node_id: nodeId,
    kind: taskNode.kind,
    agent: spec.name,
    status: status === "pending" ? "failed" : status,
    summary: output.summary,
    model: output.model,
    usage: output.usage,
    duration_ms: duration,
  });

  if (status === "done") {
    deps.store.putNodeResult({
      idempotency_key: taskNode.idempotency_key,
      run_id: snapshot.runId,
      node_id: nodeId,
      kind: taskNode.kind,
      status: "done",
      result: output.board,
      created_at: new Date().toISOString(),
    });
  }

  const update: RunUpdate = {
    statuses: { [nodeId]: status },
    attempts: { [nodeId]: attempt },
    board: { ...output.board, escalations: output.escalations },
    usage: output.usage,
    llmCalls: output.llmCalls,
  };

  // Reflection and replanning, both with hard caps.
  const replan = considerReplan(taskNode, output, snapshot, deps);
  if (replan) {
    update.graph = replan.graph;
    deps.emit({ type: "replan", reason: replan.reason, added_nodes: replan.added });
    emitGraph(deps, mergeGraph(graph, replan.graph)!);
  }

  // Human-in-the-loop pause. Only blocking escalations stop the run; everything
  // else is a question the user answers later without holding the graph open.
  //
  // The result is committed BEFORE pausing. `interrupt` discards the node's
  // writes and re-runs it on resume, so without this the model call that
  // produced the question would be paid for twice.
  const blocking = output.escalations.filter((e) => e.blocking);
  if (blocking.length > 0) {
    deps.store.putNodeResult({
      idempotency_key: taskNode.idempotency_key,
      run_id: snapshot.runId,
      node_id: nodeId,
      kind: taskNode.kind,
      status: "done",
      result: update.board ?? {},
      created_at: new Date().toISOString(),
    });
    const answers = interrupt({
      reason: "blocking_escalation",
      questions: blocking.map((e) => ({ id: e.id, question: e.question, options: e.options })),
    }) as Record<string, string>;
    return { ...update, board: { ...update.board, answers }, statuses: { [nodeId]: "done" } };
  }

  return update;
}

function emitGraph(deps: RunDeps, graph: TaskGraph): void {
  deps.emit({
    type: "graph",
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      label: n.label,
      depends_on: n.depends_on,
      optional: n.optional,
    })),
    layers: topoLayers(graph),
  });
}

/* ── Reflection loops (4), each with a hard cap ─────────────────────────── */

interface Replan {
  graph: TaskGraph;
  reason: string;
  added: string[];
}

function considerReplan(
  taskNode: TaskNode,
  output: AgentOutput,
  snapshot: RunStateType,
  deps: RunDeps,
): Replan | null {
  const graph = snapshot.graph!;

  // Tailoring: a critic rejection sends the draft back, at most twice.
  if (taskNode.kind === "critic") {
    const critique = output.board.critiques?.[0];
    const revision = snapshot.board.revision;
    if (critique?.verdict === "reject" && revision < env.maxRevisionCycles) {
      const draftId = `draft_r${revision}`;
      const criticId = `critic_r${revision}`;
      const added = [draftId, criticId];
      const revisedNodes: TaskNode[] = [
        makeNode(draftId, "draft", `Revision ${revision}`, [taskNode.id], { note: taskNode.params.note }),
        makeNode(criticId, "critic", `Adversarial review (revision ${revision})`, [draftId], {
          note: taskNode.params.note,
        }),
      ];
      // Everything that waited on the critic now waits on the new one.
      const repointed = graph.nodes
        .filter((n) => n.depends_on.includes(taskNode.id) && (snapshot.statuses[n.id] ?? "pending") === "pending")
        .map((n) => ({ ...n, depends_on: [...n.depends_on.filter((d) => d !== taskNode.id), criticId] }));

      return {
        graph: { ...graph, nodes: [...revisedNodes, ...repointed] },
        reason: `critic rejected ${critique.findings.filter((f) => f.severity === "reject").length} item(s)`,
        added,
      };
    }
  }

  // Search: a filter pass that leaves almost nothing gets a broadening branch
  // rather than an empty page. Once per run — a second broadening means the
  // brief, not the matrix, is the problem.
  if (taskNode.kind === "hard_filter" && !taskNode.params.broaden) {
    const kept = output.board.filtered_job_ids?.length ?? 0;
    const alreadyBroadened = graph.nodes.some((n) => n.id.startsWith("broaden_"));
    if (kept < env.broadenThreshold && !alreadyBroadened && deps.governor.remaining().llm_calls > 10) {
      const reason = `only ${kept} postings survived the filters`;
      const branch = broadenPlan(graph, reason);
      const tail = branch[branch.length - 1]!;
      const repointed = graph.nodes
        .filter((n) => n.depends_on.includes(taskNode.id) && (snapshot.statuses[n.id] ?? "pending") === "pending")
        .map((n) => ({ ...n, depends_on: [...n.depends_on, tail.id] }));

      return {
        graph: { ...graph, nodes: [...branch, ...repointed] },
        reason,
        added: branch.map((n) => n.id),
      };
    }
  }

  return null;
}

/* ── Finalize ─────────────────────────────────────────────────────────────*/

function finalize(state: RunStateType, deps: RunDeps): RunUpdate {
  const graph = state.graph;
  if (!graph) return {};

  const breach = deps.governor.check();
  const skipped: string[] = [];
  const statuses: Record<string, NodeStatus> = {};

  // Anything still pending did not run. Say which, and why — never silently
  // truncate (4).
  for (const n of graph.nodes) {
    const s = state.statuses[n.id] ?? "pending";
    if (s === "pending") {
      statuses[n.id] = "skipped";
      skipped.push(`${n.label}: ${breach ? `budget breach (${breach.message})` : "blocked by an upstream failure"}`);
    }
  }
  if (breach) {
    skipped.push(
      `Budget reached (${breach.message}). Model-backed steps after that point fell back to ` +
        `deterministic scoring; the results below are real but less considered.`,
    );
  }
  for (const n of blockedNodes(graph, state.statuses)) {
    if (!skipped.some((s) => s.startsWith(n.label))) {
      skipped.push(`${n.label}: blocked by an upstream failure`);
    }
  }

  return {
    statuses,
    board: { skipped },
    stopReason: breach ? `budget: ${breach.message}` : null,
  };
}

export { RunState };
export type { RunStateType, RunUpdate };
export { noopSink };
