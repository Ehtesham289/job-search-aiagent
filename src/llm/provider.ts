import Anthropic from "@anthropic-ai/sdk";
import { modelFor, type Effort, type ModelSpec, type Tier } from "../config/models.js";
import { RefusalError, TransportError, TruncatedError } from "./errors.js";

export interface RawUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export interface ProviderRequest {
  spec: ModelSpec;
  /** Stable prefix — cached. */
  system: string;
  /** [user, assistant, user, ...] turns; repair turns land here. */
  turns: Array<{ role: "user" | "assistant"; content: string }>;
  jsonSchema: unknown;
  schemaName: string;
  maxTokens: number;
  effort: Effort;
  signal?: AbortSignal;
}

export interface ProviderResponse {
  text: string;
  usage: RawUsage;
  model: string;
}

export interface LlmProvider {
  readonly name: string;
  complete(req: ProviderRequest): Promise<ProviderResponse>;
}

/** Talks to the real API. */
export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  private client: Anthropic;

  constructor(client?: Anthropic) {
    // maxRetries covers §4's "retries with backoff on tool failure": the SDK
    // retries 408/409/429/5xx and connection errors with exponential backoff.
    this.client = client ?? new Anthropic({ maxRetries: 3 });
  }

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    const { spec } = req;

    const params: Record<string, unknown> = {
      model: spec.id,
      max_tokens: req.maxTokens,
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: req.turns.map((t) => ({ role: t.role, content: t.content })),
      output_config: {
        // Only `type` and `schema` are accepted here. `schemaName` is an
        // internal label — it routes the offline providers and names the trace
        // row — and sending it is rejected with a 400.
        format: {
          type: "json_schema",
          schema: req.jsonSchema,
        },
      },
    };

    // Effort is rejected outright by pre-4.6 models, so it is tier-gated.
    if (spec.supportsEffort) {
      (params.output_config as Record<string, unknown>).effort = req.effort;
    }
    if (spec.thinking === "adaptive") {
      params.thinking = { type: "adaptive" };
    }

    const betas: string[] = [];
    // Server-side refusal routing: a classifier decline on the strong tier
    // falls back rather than failing the node.
    if (spec.id === "claude-opus-5" || spec.id === "claude-fable-5") {
      betas.push("server-side-fallback-2026-07-01");
      params.fallbacks = "default";
    }
    if (betas.length) params.betas = betas;

    let res: Anthropic.Beta.Messages.BetaMessage;
    try {
      res = (await this.client.beta.messages.create(params as never, {
        signal: req.signal,
      })) as Anthropic.Beta.Messages.BetaMessage;
    } catch (err) {
      throw toTransportError(err);
    }

    // stop_details is populated only on refusal — guard before reading.
    if (res.stop_reason === "refusal") {
      const category =
        res.stop_details && res.stop_details.type === "refusal" ? (res.stop_details.category ?? null) : null;
      throw new RefusalError(`Model declined the request (category: ${category ?? "unknown"})`, category);
    }
    if (res.stop_reason === "max_tokens") {
      throw new TruncatedError(
        `Output hit max_tokens (${req.maxTokens}); the JSON is truncated.`,
        req.maxTokens,
      );
    }

    const text = res.content
      .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    const u = res.usage;
    return {
      text,
      model: res.model ?? spec.id,
      usage: {
        input_tokens: u.input_tokens ?? 0,
        output_tokens: u.output_tokens ?? 0,
        cache_read_tokens: u.cache_read_input_tokens ?? 0,
        cache_write_tokens: u.cache_creation_input_tokens ?? 0,
      },
    };
  }
}

function toTransportError(err: unknown): Error {
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    const retryable = status === undefined || status === 408 || status === 409 || status === 429 || status >= 500;
    return new TransportError(`${err.name}: ${err.message}`, status, retryable);
  }
  if (err instanceof Error) return new TransportError(err.message);
  return new TransportError(String(err));
}

/**
 * Deterministic stand-in used by the test suite and by `--fixtures` runs.
 * Keyed by schema name plus a caller-supplied discriminator so a single run
 * can script several different agents.
 */
export class ScriptedProvider implements LlmProvider {
  readonly name = "scripted";
  readonly calls: ProviderRequest[] = [];

  constructor(private script: Map<string, unknown[] | ((req: ProviderRequest) => unknown)>) {}

  private cursor = new Map<string, number>();

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    this.calls.push(req);
    const entry = this.script.get(req.schemaName);
    if (entry === undefined) {
      throw new TransportError(`ScriptedProvider has no script for schema '${req.schemaName}'`, undefined, false);
    }
    let value: unknown;
    if (typeof entry === "function") {
      value = entry(req);
    } else {
      const i = this.cursor.get(req.schemaName) ?? 0;
      this.cursor.set(req.schemaName, i + 1);
      value = entry[Math.min(i, entry.length - 1)];
    }
    const text = JSON.stringify(value);
    return {
      text,
      model: `scripted:${req.spec.id}`,
      usage: {
        input_tokens: Math.ceil((req.system.length + req.turns.reduce((n, t) => n + t.content.length, 0)) / 4),
        output_tokens: Math.ceil(text.length / 4),
        cache_read_tokens: 0,
        cache_write_tokens: 0,
      },
    };
  }
}

export function specForTier(tier: Tier): ModelSpec {
  return modelFor(tier);
}
