import crypto from "node:crypto";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { env } from "../config/env.js";
import { LlmClient } from "../llm/client.js";
import { AnthropicProvider, type LlmProvider } from "../llm/provider.js";
import type { Budget, TaskGraph } from "../schemas/taskgraph.js";
import type { TraceEntry, Usage } from "../schemas/trace.js";
import type { ProfileSummary, StructuredResume } from "../schemas/profile.js";
import { defaultEmbedder, sha1, type Embedder } from "../tools/embed.js";
import { seedMemory } from "../tools/skills.js";
import { emptyBlackboard, type Blackboard } from "../state/blackboard.js";
import { SqliteStore } from "../state/sqlite.js";
import type { Store } from "../state/store.js";
import { defaultSearchPlan, tailoringPlan } from "../agents/planner.js";
import { parseResume, summarize } from "../agents/resumeParser.js";
import { discoverOne, parseTargets } from "../agents/sourceDiscovery.js";
import type { AgentContext, AgentOutput } from "../agents/types.js";
import { noopSink, type EventSink } from "./events.js";
import { defaultBudget, Governor, tailoringBudget } from "./governor.js";
import { runGraph, type RunResult } from "./graph.js";

export interface SystemOptions {
  store?: Store;
  provider?: LlmProvider;
  embedder?: Embedder;
  emit?: EventSink;
  signal?: AbortSignal;
  /** In-memory checkpointing for tests; defaults to SQLite beside the store. */
  checkpointer?: BaseCheckpointSaver;
}

/**
 * The system's front door. Wires L1 (store, tools) to L3 (orchestration) and
 * hands L4 a stream of events plus a durable result.
 */
export class JobSearchAgent {
  readonly store: Store;
  readonly llm: LlmClient;
  readonly embedder: Embedder;
  private emit: EventSink;
  private signal?: AbortSignal;
  private checkpointer?: BaseCheckpointSaver;

  constructor(opts: SystemOptions = {}) {
    this.store = opts.store ?? new SqliteStore(env.dbPath);
    this.llm = new LlmClient(opts.provider ?? new AnthropicProvider());
    this.embedder = opts.embedder ?? defaultEmbedder;
    this.emit = opts.emit ?? noopSink;
    this.signal = opts.signal;
    this.checkpointer = opts.checkpointer;
    // Seeding is idempotent; the synonym graph grows from here.
    seedMemory(this.store);
  }

  close(): void {
    this.store.close();
  }

  private context(runId: string, governor: Governor): AgentContext {
    return {
      runId,
      store: this.store,
      llm: this.llm,
      embedder: this.embedder,
      emit: this.emit,
      signal: this.signal,
      remaining: () => governor.remaining(),
    };
  }

  private deps(governor: Governor) {
    return {
      store: this.store,
      llm: this.llm,
      embedder: this.embedder,
      emit: this.emit,
      governor,
      signal: this.signal,
    };
  }

  private checkpointerFor(): BaseCheckpointSaver {
    return this.checkpointer ?? SqliteSaver.fromConnString(`${env.dbPath}.checkpoints`);
  }

  /* ── Search lane ─────────────────────────────────────────────────────── */

  async search(input: {
    brief: string;
    resumeText?: string;
    runId?: string;
    budget?: Partial<Budget>;
    /** Companies or domains to discover before harvesting. */
    discover?: string[];
    /** Where the candidate wants to work. Overrides the résumé. */
    locations?: string[];
    remoteOk?: boolean;
    /** Search the web for employers nobody named. Defaults on when the
     *  registry is too thin to answer the question. */
    autoDiscover?: boolean;
    /**
     * Jobs an earlier pass already showed. Excluded at the hard filter so a
     * continuation spends its analysis and rubric budget on new postings
     * instead of re-ranking the same shortlist.
     */
    excludeJobIds?: string[];
    /** Start with the title match already loosened, as a continuation should:
     *  the strict pass has been run, and what is left is adjacent. */
    broaden?: boolean;
    /**
     * A résumé already parsed by an earlier run, carried over instead of
     * re-parsed. A continuation must score against the identical candidate,
     * and re-parsing would both cost a second model call and risk the two
     * passes disagreeing about the same document.
     */
    parsedResume?: { resume: StructuredResume; profile: ProfileSummary | null };
  }): Promise<RunResult> {
    const runId = input.runId ?? `run_${crypto.randomUUID().slice(0, 8)}`;
    const budget = defaultBudget(input.budget);
    const governor = new Governor(budget);
    // Pre-DAG work (résumé parse, planning) spends too, and must be charged.
    this.llm.onUsage((usage, calls) => governor.record(usage, calls));
    this.llm.onBudgetCheck(() => governor.check()?.message ?? null);
    const ctx = this.context(runId, governor);

    this.emit({ type: "run_started", run_id: runId, brief: input.brief });
    let board: Partial<Blackboard> = {
      brief: input.brief,
      preferences: {
        locations: (input.locations ?? []).map((l) => l.trim()).filter(Boolean),
        remote_ok: input.remoteOk !== false,
        willing_to_relocate: true,
      },
      discover_targets: (input.discover ?? []).map((d) => d.trim()).filter(Boolean),
      exclude_job_ids: input.excludeJobIds ?? [],
      auto_discover:
        input.autoDiscover ?? this.store.listSources({ status: "verified" }).length < 5,
    };

    // The resume is parsed before planning, because the planner's job is to
    // decompose *this* candidate's search and it needs the profile to do it.
    if (input.parsedResume) {
      board = { ...board, resume: input.parsedResume.resume, profile: input.parsedResume.profile };
    } else if (input.resumeText) {
      const parsed = await this.traced(runId, "resume_parse", "resume_parser", governor, () =>
        parseResume(ctx, input.resumeText!),
      );
      board = { ...board, ...parsed.board };
    }

    this.store.createRun({
      id: runId,
      brief: input.brief,
      status: "planning",
      budget,
      plan: null,
      blackboard: { ...emptyBlackboard(input.brief), ...board } as unknown as Record<string, unknown>,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Every search runs the deterministic plan.
    //
    // A model planner used to draw this graph instead. Measured over nine real
    // plans across seven briefs — ordinary, vague, hyper-specific, and a career
    // switch — it emitted the same eleven nodes in the same order every single
    // time, so the one thing it existed to do it never did. What it did vary
    // was each node's `limit`, always downward: the match rubric came back at
    // 8-15 against a preset default of 30, and JD analysis at 15-60 against 60.
    // It narrowed the funnel, non-deterministically, for $0.026 and ~23s a run.
    // The cheap/balanced/thorough presets already set those numbers directly,
    // for free and repeatably.
    const graph = defaultSearchPlan(budget, input.broaden ?? false);

    return runGraph({
      runId,
      brief: input.brief,
      graph,
      board,
      deps: this.deps(governor),
      checkpointer: this.checkpointerFor(),
    });
  }

  /* ── Tailoring lane ──────────────────────────────────────────────────── */

  /**
   * Runs after the user picks a job. A separate thread id so the tailoring
   * lane checkpoints independently of the search that produced it — you can
   * tailor for three jobs from one search without them colliding.
   */
  async tailor(input: {
    searchRunId: string;
    jobId: string;
    budget?: Partial<Budget>;
  }): Promise<RunResult> {
    const source = this.store.getRun(input.searchRunId);
    if (!source) throw new Error(`run ${input.searchRunId} not found`);

    const prior = source.blackboard as unknown as Blackboard;
    if (!prior.resume) {
      throw new Error(`run ${input.searchRunId} has no parsed resume; tailoring needs one`);
    }

    const runId = `${input.searchRunId}_tailor_${input.jobId.slice(0, 8)}`;
    const budget = tailoringBudget(input.budget);
    const governor = new Governor(budget);
    const graph = tailoringPlan(budget, input.jobId);

    const brief = `Tailor resume for job ${input.jobId}`;
    if (!this.store.getRun(runId)) {
      this.store.createRun({
        id: runId,
        brief,
        status: "planning",
        budget,
        plan: graph,
        blackboard: {} as Record<string, unknown>,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }

    return runGraph({
      runId,
      brief,
      graph,
      board: {
        brief,
        resume: prior.resume,
        profile: prior.profile ?? summarize(prior.resume),
        matches: prior.matches,
        selected_job_id: input.jobId,
        revision: 0,
      },
      deps: this.deps(governor),
      checkpointer: this.checkpointerFor(),
    });
  }

  /* ── Resume a paused run ─────────────────────────────────────────────── */

  /**
   * A run paused on a blocking escalation resumes from its last checkpoint —
   * not from the beginning. Committed nodes are replayed from `node_results`,
   * so nothing is re-fetched and nothing is re-charged.
   */
  async resume(input: { runId: string; answers: Record<string, string> }): Promise<RunResult> {
    const run = this.store.getRun(input.runId);
    if (!run) throw new Error(`run ${input.runId} not found`);
    if (!run.plan) throw new Error(`run ${input.runId} has no stored plan to resume`);

    for (const [id, answer] of Object.entries(input.answers)) this.store.answerEscalation(id, answer);

    const governor = new Governor(run.budget);
    const prior = run.blackboard as unknown as Blackboard;
    governor.restore({
      usage: totalUsage(this.store.listTrace(input.runId)),
      llmCalls: this.store.listTrace(input.runId).length,
      elapsedMs: 0,
    });

    return runGraph({
      runId: input.runId,
      brief: run.brief,
      graph: run.plan,
      board: prior,
      deps: this.deps(governor),
      checkpointer: this.checkpointerFor(),
      resume: input.answers,
    });
  }

  /* ── Registry maintenance ────────────────────────────────────────────── */

  /**
   * Runs asynchronously and continuously, not only during a user's search —
   * the registry is an asset that compounds (2.3).
   */
  /**
   * Reads a résumé on its own, outside a run.
   *
   * The console needs this the moment a file is dropped, to propose a brief.
   * That proposal used to come from the heuristic parser, which reads a résumé
   * by its shape — and shapes vary. On a real CV laid out as
   * `Title······Jan 2026 – Present` / `Deloitte USI — Bangalore`, it took the
   * company line as the job title and found one role out of four, proposing
   * "Deloitte USI, 0.6 years" for someone with five years of experience.
   *
   * Reading a free-form document is judgment, not parsing, so it goes to a
   * model — the cheap tier, which is what the search would have spent on the
   * same résumé anyway. The result is handed back so the search can reuse it
   * instead of parsing a second time.
   */
  async readResume(rawText: string): Promise<{
    resume: StructuredResume;
    profile: ProfileSummary;
    usage: Usage;
  }> {
    const governor = new Governor(defaultBudget());
    const ctx = this.context(`resume_${sha1(rawText).slice(0, 8)}`, governor);
    const out = await parseResume(ctx, rawText);
    const resume = out.board.resume as StructuredResume;
    return {
      resume,
      profile: (out.board.profile as ProfileSummary | undefined) ?? summarize(resume),
      usage: out.usage,
    };
  }

  async discover(targets: string[]): Promise<{ verified: number; unresolved: number }> {
    const governor = new Governor(defaultBudget({ max_cost_usd: 0.2 }));
    const ctx = this.context("registry", governor);
    let verified = 0;
    let unresolved = 0;
    for (const target of parseTargets(targets.join(","))) {
      const rec = await discoverOne(ctx, target);
      this.store.upsertSource(rec);
      if (rec.status === "verified") {
        verified++;
        this.emit({ type: "node_progress", node_id: "discover", message: `${rec.company}: ${rec.ats_type} (${rec.career_url})` });
      } else {
        unresolved++;
        this.emit({ type: "node_progress", node_id: "discover", message: `${rec.company}: unresolved — ${rec.reason}` });
      }
    }
    return { verified, unresolved };
  }

  /** Work that happens outside the DAG still earns a trace row — resume
   *  parsing and planning cost money, so they must show up in the ledger. */
  private async traced<T extends AgentOutput>(
    runId: string,
    nodeId: string,
    agent: string,
    governor: Governor,
    fn: () => Promise<T>,
  ): Promise<T> {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    this.emit({ type: "node_started", node_id: nodeId, kind: nodeId, agent, label: agent });
    let out: T;
    let error: string | null = null;
    try {
      out = await fn();
    } catch (err) {
      error = (err as Error).message;
      throw err;
    } finally {
      const duration = Date.now() - t0;
      if (!error) {
        // Charged per call by the client's usage sink; see LlmClient.onUsage.
        for (const e of out!.escalations) {
          this.store.putEscalation(runId, e);
          this.emit({ type: "escalation", escalation: e });
        }
      }
      this.store.appendTrace({
        run_id: runId,
        node_id: nodeId,
        kind: nodeId,
        agent,
        model: error ? null : (out!.model ?? null),
        status: error ? "failed" : "done",
        input_hash: sha1(`${runId}|${nodeId}`),
        output_summary: error ? `failed: ${error}` : out!.summary,
        usage: error ? { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 } : out!.usage,
        duration_ms: duration,
        attempts: 1,
        retries: 0,
        validation_failures: error ? 0 : out!.validationFailures,
        error,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
      });
      this.emit({
        type: "node_finished",
        node_id: nodeId,
        kind: nodeId,
        agent,
        status: error ? "failed" : "done",
        summary: error ? `failed: ${error}` : out!.summary,
        model: error ? null : (out!.model ?? null),
        usage: error ? { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 } : out!.usage,
        duration_ms: duration,
      });
    }
    return out!;
  }
}

function totalUsage(trace: TraceEntry[]) {
  return trace.reduce(
    (acc, t) => ({
      input_tokens: acc.input_tokens + t.usage.input_tokens,
      output_tokens: acc.output_tokens + t.usage.output_tokens,
      cache_read_tokens: acc.cache_read_tokens + t.usage.cache_read_tokens,
      cache_write_tokens: acc.cache_write_tokens + t.usage.cache_write_tokens,
      cost_usd: acc.cost_usd + t.usage.cost_usd,
    }),
    { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 },
  );
}
