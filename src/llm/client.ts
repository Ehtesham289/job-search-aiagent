import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { costUsd, modelFor, type Effort, type Tier } from "../config/models.js";
import type { Usage } from "../schemas/trace.js";
import { BudgetExceededError, SchemaValidationError, TransportError, TruncatedError } from "./errors.js";
import type { LlmProvider, ProviderRequest, RawUsage } from "./provider.js";

export interface StructuredCall<T> {
  /** Agent name, for the trace. */
  agent: string;
  tier: Tier;
  /**
   * Stable across every call this agent makes. Goes first and carries the
   * cache breakpoint — volatile content must live in `input`, or the cache
   * never hits (see §"prompt caching is a prefix match").
   */
  systemPrompt: string;
  /** Per-call payload. */
  input: string;
  schema: z.ZodType<T>;
  schemaName: string;
  maxTokens?: number;
  effort?: Effort;
  /**
   * Schema-validation failures are NOT retries — the model is re-prompted with
   * the specific validation error attached (§4). This caps how many times.
   */
  maxRepairs?: number;
  signal?: AbortSignal;
}

export interface StructuredResult<T> {
  /** How many times the output ceiling had to be doubled to fit the answer. */
  grewMaxTokens?: number;
  value: T;
  model: string;
  usage: Usage;
  /** Provider round trips, including repair turns. */
  attempts: number;
  validationFailures: number;
}

const EMPTY_USAGE: Usage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  cost_usd: 0,
};

/** Called the moment a request settles, before the caller sees the result. */
export type UsageSink = (usage: Usage, calls: number) => void;

/** Returns a reason when no further spending is allowed, else null. */
export type BudgetGuard = () => string | null;

export class LlmClient {
  private sink: UsageSink | null = null;
  private guard: BudgetGuard | null = null;

  constructor(private provider: LlmProvider) {}

  get providerName(): string {
    return this.provider.name;
  }

  /**
   * Where spend is reported as it happens.
   *
   * Accounting only when a node returns makes the budget unenforceable for the
   * nodes that matter: a fan-out of 56 JD analyses would see an unchanged
   * `remaining()` for its whole duration and sail past the ceiling. Charging
   * per call is what makes the governor's guard mean anything.
   */
  onUsage(sink: UsageSink | null): void {
    this.sink = sink;
  }

  /**
   * The budget is enforced here, at the last point before money is spent.
   *
   * Halting the scheduler on a breach was worse than useless: it skipped the
   * *free* code nodes too, so a run could spend its whole budget and then
   * return nothing at all. Blocking the call instead lets every agent take its
   * documented cheap path, and the deterministic nodes still produce results.
   */
  onBudgetCheck(guard: BudgetGuard | null): void {
    this.guard = guard;
  }

  async structured<T>(call: StructuredCall<T>): Promise<StructuredResult<T>> {
    const spec = modelFor(call.tier);
    const format = zodOutputFormat(call.schema) as { schema: unknown };
    const maxRepairs = call.maxRepairs ?? 1;

    const turns: ProviderRequest["turns"] = [{ role: "user", content: call.input }];
    const usage: Usage = { ...EMPTY_USAGE };
    let attempts = 0;
    let validationFailures = 0;
    let model = spec.id;
    let lastError: SchemaValidationError | null = null;

    // Room for the answer, grown on demand.
    //
    // A truncated response is not a wrong answer, it is an unfinished one, and
    // retrying the same call unchanged reproduces it exactly. So the ceiling
    // doubles and the call is repeated — which turns "raise maxTokens for this
    // agent", advice only a maintainer could act on, into something the run
    // does for itself. Capped, because a model that cannot finish in four
    // times the room it was given is not going to finish at all.
    let maxTokens = call.maxTokens ?? 8000;
    const maxTokensCeiling = maxTokens * 4;
    let grew = 0;

    for (let round = 0; round <= maxRepairs; round++) {
      const blocked = this.guard?.();
      if (blocked) throw new BudgetExceededError(`${call.agent}: ${blocked}`, "budget");
      attempts++;
      let res;
      try {
        res = await this.provider.complete({
          spec,
          system: call.systemPrompt,
          turns,
          jsonSchema: format.schema,
          schemaName: call.schemaName,
          maxTokens,
          effort: call.effort ?? defaultEffort(call.tier),
          signal: call.signal,
        });
      } catch (err) {
        if (err instanceof TruncatedError && maxTokens < maxTokensCeiling) {
          maxTokens = Math.min(maxTokens * 2, maxTokensCeiling);
          grew++;
          // Does not consume a repair round: nothing was wrong with the
          // answer, so the model gets the same question with more room.
          round--;
          continue;
        }
        throw err;
      }
      model = res.model;
      const charged = accumulate(usage, res.usage, spec);
      this.sink?.(charged, 1);

      const parsed = parseAndValidate(call.schema, res.text);
      if (parsed.ok) {
        return { value: parsed.value, model, usage, attempts, validationFailures, grewMaxTokens: grew };
      }

      validationFailures++;
      lastError = parsed.error;
      if (round === maxRepairs) break;

      // Re-prompt with the exact failure. Not a blind retry: the model sees
      // what it got wrong, so a second identical answer is unlikely.
      turns.push({ role: "assistant", content: truncate(res.text, 20_000) });
      turns.push({
        role: "user",
        content:
          `Your previous response did not satisfy the required output schema.\n\n` +
          `Validation errors:\n${parsed.error.issues.map((i) => `  - ${i}`).join("\n")}\n\n` +
          `Emit a corrected object that satisfies every constraint. Change only what the ` +
          `errors above require; keep the rest of your answer identical. Do not explain.`,
      });
    }

    throw lastError ?? new TransportError(`${call.agent}: exhausted repairs with no error recorded`, undefined, false);
  }
}

type ParseOutcome<T> = { ok: true; value: T } | { ok: false; error: SchemaValidationError };

export function parseAndValidate<T>(schema: z.ZodType<T>, raw: string): ParseOutcome<T> {
  let json: unknown;
  const candidate = stripFence(raw);
  try {
    json = JSON.parse(candidate);
  } catch (err) {
    return {
      ok: false,
      error: new SchemaValidationError(
        "response was not valid JSON",
        [`JSON.parse failed: ${(err as Error).message}`],
        raw,
      ),
    };
  }
  const result = schema.safeParse(json);
  if (result.success) return { ok: true, value: result.data };
  const issues = result.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
  return { ok: false, error: new SchemaValidationError("response failed schema validation", issues, raw) };
}

/** Models occasionally wrap JSON in a fence despite structured output. */
function stripFence(raw: string): string {
  const t = raw.trim();
  if (!t.startsWith("```")) return t;
  return t.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}\n...[truncated]`;
}

/** Adds this response to the running total and returns just this response's share. */
function accumulate(into: Usage, raw: RawUsage, spec: ReturnType<typeof modelFor>): Usage {
  const one: Usage = {
    input_tokens: raw.input_tokens,
    output_tokens: raw.output_tokens,
    cache_read_tokens: raw.cache_read_tokens,
    cache_write_tokens: raw.cache_write_tokens,
    cost_usd: costUsd(spec, raw),
  };
  into.input_tokens += one.input_tokens;
  into.output_tokens += one.output_tokens;
  into.cache_read_tokens += one.cache_read_tokens;
  into.cache_write_tokens += one.cache_write_tokens;
  into.cost_usd += one.cost_usd;
  return one;
}

function defaultEffort(tier: Tier): Effort {
  // Extraction does not repay thinking depth; planning and tailoring do.
  return tier === "strong" ? "high" : tier === "mid" ? "medium" : "low";
}

export function emptyUsage(): Usage {
  return { ...EMPTY_USAGE };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_tokens: a.cache_read_tokens + b.cache_read_tokens,
    cache_write_tokens: a.cache_write_tokens + b.cache_write_tokens,
    cost_usd: a.cost_usd + b.cost_usd,
  };
}
