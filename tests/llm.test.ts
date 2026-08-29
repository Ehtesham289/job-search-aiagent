import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LlmClient } from "../src/llm/client.js";
import { SchemaValidationError, TruncatedError } from "../src/llm/errors.js";
import { modelFor } from "../src/config/models.js";
import type { LlmProvider, ProviderRequest, ProviderResponse } from "../src/llm/provider.js";

const Schema = z.object({ score: z.number().min(0).max(100), label: z.enum(["good", "bad"]) });

class Replaying implements LlmProvider {
  readonly name = "replaying";
  readonly requests: ProviderRequest[] = [];
  private i = 0;
  constructor(private responses: string[]) {}
  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(structuredClone({ ...req, jsonSchema: null }));
    const text = this.responses[Math.min(this.i++, this.responses.length - 1)]!;
    return {
      text,
      model: req.spec.id,
      usage: { input_tokens: 1000, output_tokens: 200, cache_read_tokens: 0, cache_write_tokens: 0 },
    };
  }
}

describe("structured output with validation as control flow", () => {
  it("returns the parsed value on a clean first response", async () => {
    const provider = new Replaying([JSON.stringify({ score: 82, label: "good" })]);
    const res = await new LlmClient(provider).structured({
      agent: "t", tier: "fast", systemPrompt: "sys", input: "in",
      schema: Schema, schemaName: "verdict",
    });
    expect(res.value).toEqual({ score: 82, label: "good" });
    expect(res.attempts).toBe(1);
    expect(res.validationFailures).toBe(0);
    expect(provider.requests).toHaveLength(1);
  });

  it("re-prompts with the specific validation error instead of retrying blindly", async () => {
    const provider = new Replaying([
      JSON.stringify({ score: 900, label: "great" }),
      JSON.stringify({ score: 90, label: "good" }),
    ]);
    const res = await new LlmClient(provider).structured({
      agent: "t", tier: "fast", systemPrompt: "sys", input: "in",
      schema: Schema, schemaName: "verdict",
    });

    expect(res.value).toEqual({ score: 90, label: "good" });
    expect(res.validationFailures).toBe(1);
    expect(res.attempts).toBe(2);

    // The repair turn must carry the failure back to the model, and must
    // include the rejected output — a blind retry would send neither.
    const repair = provider.requests[1]!;
    expect(repair.turns).toHaveLength(3);
    expect(repair.turns[1]!.role).toBe("assistant");
    expect(repair.turns[2]!.content).toContain("did not satisfy the required output schema");
    expect(repair.turns[2]!.content).toContain("score:");
    expect(repair.turns[2]!.content).toContain("label:");
  });

  it("gives up with the issue list rather than looping forever", async () => {
    const provider = new Replaying([JSON.stringify({ score: -5, label: "x" })]);
    await expect(
      new LlmClient(provider).structured({
        agent: "t", tier: "fast", systemPrompt: "sys", input: "in",
        schema: Schema, schemaName: "verdict", maxRepairs: 2,
      }),
    ).rejects.toBeInstanceOf(SchemaValidationError);
    // 1 initial + 2 repairs, then stop.
    expect(provider.requests).toHaveLength(3);
  });

  it("accumulates usage across repair turns and prices it by tier", async () => {
    const provider = new Replaying([
      JSON.stringify({ score: 900, label: "good" }),
      JSON.stringify({ score: 90, label: "good" }),
    ]);
    const res = await new LlmClient(provider).structured({
      agent: "t", tier: "fast", systemPrompt: "sys", input: "in",
      schema: Schema, schemaName: "verdict",
    });
    expect(res.usage.input_tokens).toBe(2000);
    expect(res.usage.output_tokens).toBe(400);
    // claude-haiku-4-5: $1/MTok in, $5/MTok out.
    expect(res.usage.cost_usd).toBeCloseTo(2000 / 1e6 + (400 * 5) / 1e6, 8);
  });

  it("puts the stable system prompt where the cache breakpoint can reach it", async () => {
    const provider = new Replaying([JSON.stringify({ score: 1, label: "bad" })]);
    await new LlmClient(provider).structured({
      agent: "t", tier: "strong", systemPrompt: "STABLE", input: "VOLATILE",
      schema: Schema, schemaName: "verdict",
    });
    const req = provider.requests[0]!;
    expect(req.system).toBe("STABLE");
    expect(req.turns[0]!.content).toBe("VOLATILE");
  });

  /**
   * The contract is that a tier resolves to whatever the config says, not that
   * the three tiers are three different models. Asserting a count of distinct
   * models made this fail the moment `strong` moved from Opus to Sonnet — a
   * config change the indirection exists to permit.
   */
  it("routes each tier to the model its config names", async () => {
    const provider = new Replaying([JSON.stringify({ score: 1, label: "bad" })]);
    const client = new LlmClient(provider);
    for (const tier of ["fast", "mid", "strong"] as const) {
      await client.structured({
        agent: "t", tier, systemPrompt: "s", input: "i", schema: Schema, schemaName: "verdict",
      });
    }
    const models = provider.requests.map((r) => r.spec.id);
    expect(models).toEqual([modelFor("fast").id, modelFor("mid").id, modelFor("strong").id]);
    // The cheap tier must stay strictly cheaper than the strong one, whatever
    // they are set to — otherwise the tiering buys nothing.
    expect(modelFor("fast").inputPerMTok).toBeLessThan(modelFor("strong").inputPerMTok);
  });

  it("honours a per-tier environment override", async () => {
    const prev = process.env.JOBSEARCH_MODEL_STRONG;
    process.env.JOBSEARCH_MODEL_STRONG = "claude-opus-5";
    try {
      expect(modelFor("strong").id).toBe("claude-opus-5");
    } finally {
      if (prev === undefined) delete process.env.JOBSEARCH_MODEL_STRONG;
      else process.env.JOBSEARCH_MODEL_STRONG = prev;
    }
  });

  it("only sends effort to models that accept it", async () => {
    const provider = new Replaying([JSON.stringify({ score: 1, label: "bad" })]);
    const client = new LlmClient(provider);
    await client.structured({ agent: "t", tier: "fast", systemPrompt: "s", input: "i", schema: Schema, schemaName: "v" });
    await client.structured({ agent: "t", tier: "strong", systemPrompt: "s", input: "i", schema: Schema, schemaName: "v" });
    expect(provider.requests[0]!.spec.supportsEffort).toBe(false);
    expect(provider.requests[1]!.spec.supportsEffort).toBe(true);
  });
});

/**
 * A dense résumé blew the 4,000-token gap analysis and took the whole
 * tailoring run with it — bind, draft, critic and render all reported
 * "blocked by an upstream failure", and the only advice on screen was to raise
 * a constant nobody outside the repository can edit.
 *
 * A truncated response is not a wrong answer, it is an unfinished one, so the
 * client asks the same question again with more room.
 */
class TruncatesUntil implements LlmProvider {
  readonly name = "truncating";
  readonly seen: number[] = [];
  constructor(private needs: number) {}
  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    this.seen.push(req.maxTokens);
    if (req.maxTokens < this.needs) {
      throw new TruncatedError(`Output hit max_tokens (${req.maxTokens})`, req.maxTokens);
    }
    return {
      text: JSON.stringify({ score: 71, label: "good" }),
      model: req.spec.id,
      usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_write_tokens: 0 },
    };
  }
}

describe("an answer that does not fit", () => {
  const call = {
    agent: "t", tier: "fast", systemPrompt: "s", input: "i",
    schema: Schema, schemaName: "verdict", maxTokens: 4000,
  } as const;

  it("doubles the ceiling and retries rather than failing the node", async () => {
    const provider = new TruncatesUntil(8000);
    const res = await new LlmClient(provider).structured({ ...call });
    expect(res.value).toEqual({ score: 71, label: "good" });
    expect(provider.seen).toEqual([4000, 8000]);
    expect(res.grewMaxTokens).toBe(1);
  });

  it("keeps doubling until the answer fits", async () => {
    const provider = new TruncatesUntil(16_000);
    const res = await new LlmClient(provider).structured({ ...call });
    expect(provider.seen).toEqual([4000, 8000, 16_000]);
    expect(res.value.score).toBe(71);
  });

  it("gives up at 4x rather than growing without limit", async () => {
    // Nothing will satisfy this, so the ceiling must stop somewhere.
    const provider = new TruncatesUntil(1e9);
    await expect(new LlmClient(provider).structured({ ...call })).rejects.toBeInstanceOf(TruncatedError);
    expect(provider.seen).toEqual([4000, 8000, 16_000]);
  });

  it("does not spend a repair round on growing", async () => {
    // Repairs exist for wrong answers. An unfinished one is a different thing.
    const provider = new TruncatesUntil(8000);
    const res = await new LlmClient(provider).structured({ ...call, maxRepairs: 0 });
    expect(res.value.score).toBe(71);
    expect(res.validationFailures).toBe(0);
  });
});
