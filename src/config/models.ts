/**
 * §4 Model tiering. Cheap fast model for extraction and classification, mid
 * model for scoring, strongest model for tailoring and planning. Which model
 * ran which node is recorded on every trace entry.
 *
 * Tiers are indirection on purpose: swapping a tier's model is a config change,
 * not a code change, and every agent declares a tier rather than a model id.
 */
export type Tier = "fast" | "mid" | "strong";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelSpec {
  id: string;
  /** USD per million tokens. */
  inputPerMTok: number;
  outputPerMTok: number;
  contextWindow: number;
  /** `output_config.effort` is rejected by pre-4.6 models. */
  supportsEffort: boolean;
  /** 4.6+ take `{type:"adaptive"}`; older models need `budget_tokens`. */
  thinking: "adaptive" | "budget" | "none";
}

export const MODELS: Record<string, ModelSpec> = {
  "claude-opus-5": {
    id: "claude-opus-5",
    inputPerMTok: 5,
    outputPerMTok: 25,
    contextWindow: 1_000_000,
    supportsEffort: true,
    thinking: "adaptive",
  },
  "claude-sonnet-5": {
    id: "claude-sonnet-5",
    inputPerMTok: 2,
    outputPerMTok: 10,
    contextWindow: 1_000_000,
    supportsEffort: true,
    thinking: "adaptive",
  },
  "claude-haiku-4-5": {
    id: "claude-haiku-4-5",
    inputPerMTok: 1,
    outputPerMTok: 5,
    contextWindow: 200_000,
    supportsEffort: false,
    thinking: "budget",
  },
};

/**
 * `strong` is Sonnet, not Opus.
 *
 * The strong tier runs the query strategist and the five
 * tailoring steps. Those are structured tasks against a fixed schema — decompose
 * a brief into a DAG, expand a role into a search matrix, rewrite a bullet
 * without inventing an achievement — and the adversarial critic already catches
 * the failure that matters, since fabricated evidence is checked in code by the
 * evidence binder rather than trusted from the model.
 *
 * Opus earned its price on open-ended judgment. Here it was paying a 2.5x input
 * and output premium for the same verdicts: a measured query_strategist call
 * cost $0.0618 on Opus against $0.0250 on Sonnet, for a plan that differed in
 * wording rather than in which jobs it found.
 *
 * `JOBSEARCH_MODEL_STRONG=claude-opus-5` restores it for a single run.
 */
const DEFAULT_TIERS: Record<Tier, string> = {
  fast: "claude-haiku-4-5",
  mid: "claude-sonnet-5",
  strong: "claude-sonnet-5",
};

/**
 * Coherent cost/quality settings, measured rather than guessed.
 *
 * `cheap` shifts every tier down one. On a real comparison the cheaper models
 * reached the *same verdict* as the expensive ones — same blockers, same
 * "do not apply" band — with terser reasoning. Since the rubric's job is to
 * rank and explain, that is a real option, not a false economy. What it gives
 * up is the depth of the explanation and the breadth of the search matrix.
 *
 * `thorough` keeps the tiers and widens the funnel instead, which is usually
 * the better way to spend more: more jobs considered beats more words about
 * the same jobs.
 */
export type Preset = "cheap" | "balanced" | "thorough";

export const PRESETS: Record<Preset, { tiers: Record<Tier, string>; analysisTopK: number; rubricTopK: number }> = {
  cheap: {
    tiers: { fast: "claude-haiku-4-5", mid: "claude-haiku-4-5", strong: "claude-sonnet-5" },
    analysisTopK: 40,
    rubricTopK: 20,
  },
  balanced: { tiers: DEFAULT_TIERS, analysisTopK: 60, rubricTopK: 30 },
  // The one preset that still buys Opus, so the option survives rather than
  // being deleted. It is deliberately not the default: widening the funnel is
  // the better way to spend more, and this spends on both.
  thorough: {
    tiers: { ...DEFAULT_TIERS, strong: "claude-opus-5" },
    analysisTopK: 120,
    rubricTopK: 50,
  },
};

export function currentPreset(): Preset {
  const p = process.env.JOBSEARCH_PRESET;
  return p === "cheap" || p === "thorough" ? p : "balanced";
}

export function modelFor(tier: Tier): ModelSpec {
  // An explicit per-tier override always wins over the preset.
  const envKey = `JOBSEARCH_MODEL_${tier.toUpperCase()}`;
  const id = process.env[envKey] ?? PRESETS[currentPreset()].tiers[tier];
  const spec = MODELS[id];
  if (!spec) {
    throw new Error(
      `Unknown model '${id}' for tier '${tier}'. Add it to MODELS in src/config/models.ts or unset ${envKey}.`,
    );
  }
  return spec;
}

/** Cache reads bill at ~0.1x input, cache writes at ~1.25x. */
export function costUsd(
  spec: ModelSpec,
  u: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number },
): number {
  const inM = spec.inputPerMTok / 1_000_000;
  const outM = spec.outputPerMTok / 1_000_000;
  return (
    u.input_tokens * inM +
    u.cache_read_tokens * inM * 0.1 +
    u.cache_write_tokens * inM * 1.25 +
    u.output_tokens * outM
  );
}
