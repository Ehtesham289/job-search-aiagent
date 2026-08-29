import type { Budget } from "../schemas/taskgraph.js";
import type { Usage } from "../schemas/trace.js";

export type BudgetDimension = "tokens" | "cost" | "wall_time" | "llm_calls";

export interface BudgetBreach {
  dimension: BudgetDimension;
  limit: number;
  spent: number;
  message: string;
}

/**
 * 4 Budget governor. Every run carries {max_tokens, max_cost, max_wall_time,
 * max_llm_calls}. On breach the run stops cleanly and returns partial results
 * with an honest note about what was not finished.
 *
 * It never silently truncates: `skipped` is a first-class output, and the
 * interface prints it.
 */
export class Governor {
  private started = Date.now();
  private tokens = 0;
  private cost = 0;
  private calls = 0;
  private breached: BudgetBreach | null = null;

  constructor(private budget: Budget) {}

  /** Restores accounting after a checkpoint resume, so a resumed run cannot
   *  spend the whole budget a second time. */
  restore(spent: { usage: Usage; llmCalls: number; elapsedMs: number }): void {
    this.tokens = spent.usage.input_tokens + spent.usage.output_tokens;
    this.cost = spent.usage.cost_usd;
    this.calls = spent.llmCalls;
    this.started = Date.now() - spent.elapsedMs;
  }

  record(usage: Usage, llmCalls: number): void {
    this.tokens += usage.input_tokens + usage.output_tokens;
    this.cost += usage.cost_usd;
    // Only billable calls count against the call ceiling. That ceiling is a
    // spend control; charging free heuristic steps against it stopped an
    // offline run that had cost nothing and taken 90ms.
    if (usage.input_tokens > 0 || usage.output_tokens > 0 || usage.cost_usd > 0) {
      this.calls += llmCalls;
    }
  }

  elapsedMs(): number {
    return Date.now() - this.started;
  }

  spent(): { tokens: number; cost_usd: number; llm_calls: number; elapsed_ms: number } {
    return { tokens: this.tokens, cost_usd: this.cost, llm_calls: this.calls, elapsed_ms: this.elapsedMs() };
  }

  remaining(): { tokens: number; cost_usd: number; wall_ms: number; llm_calls: number } {
    return {
      tokens: this.budget.max_tokens - this.tokens,
      cost_usd: this.budget.max_cost_usd - this.cost,
      wall_ms: this.budget.max_wall_time_ms - this.elapsedMs(),
      llm_calls: this.budget.max_llm_calls - this.calls,
    };
  }

  /** Checked before every superstep and inside every fan-out. */
  check(): BudgetBreach | null {
    if (this.breached) return this.breached;
    const r = this.remaining();
    if (r.cost_usd <= 0) {
      this.breached = breach("cost", this.budget.max_cost_usd, this.cost, `spent $${this.cost.toFixed(4)} of $${this.budget.max_cost_usd}`);
    } else if (r.tokens <= 0) {
      this.breached = breach("tokens", this.budget.max_tokens, this.tokens, `used ${this.tokens} of ${this.budget.max_tokens} tokens`);
    } else if (r.llm_calls <= 0) {
      this.breached = breach("llm_calls", this.budget.max_llm_calls, this.calls, `made ${this.calls} of ${this.budget.max_llm_calls} allowed model calls`);
    } else if (r.wall_ms <= 0) {
      this.breached = breach("wall_time", this.budget.max_wall_time_ms, this.elapsedMs(), `ran for ${Math.round(this.elapsedMs() / 1000)}s of ${Math.round(this.budget.max_wall_time_ms / 1000)}s`);
    }
    return this.breached;
  }

  get limits(): Budget {
    return this.budget;
  }
}

function breach(dimension: BudgetDimension, limit: number, spent: number, message: string): BudgetBreach {
  return { dimension, limit, spent, message };
}

export function defaultBudget(overrides: Partial<Budget> = {}): Budget {
  return {
    max_tokens: 600_000,
    max_cost_usd: 0.4,
    // Thirteen boards take ~11s to harvest and JD analysis dominates after
    // that; 180s cut real runs off mid-funnel and forced deterministic scores.
    max_wall_time_ms: 420_000,
    max_llm_calls: 120,
    ...overrides,
  };
}

export function tailoringBudget(overrides: Partial<Budget> = {}): Budget {
  // Tailoring is few calls on the strongest tier plus up to two revisions, so
  // the shape of the budget is the opposite of a search: fewer calls, more
  // money per call, more wall time for the render.
  return {
    max_tokens: 400_000,
    max_cost_usd: 0.75,
    max_wall_time_ms: 300_000,
    max_llm_calls: 20,
    ...overrides,
  };
}
