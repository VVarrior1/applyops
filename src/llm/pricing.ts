/**
 * Model prices and cost arithmetic.
 *
 * Every LLM call in ApplyOps is costed and written to `generations.cost_usd`,
 * and that number drives the per-user daily budget (spec §11), the eval report
 * and the model benchmark (spec §8). Prices live here — one table, no prices
 * scattered through call sites — and are plain numbers in **USD per 1M
 * tokens**, exactly as the providers publish them.
 *
 * Figures verified 2026-08-27 against the ApplyOps build plan's pricing table
 * (`docs/superpowers/plans/2026-08-27-applyops-build.md`, Task 4). Providers
 * change prices; when they do, edit this table and nothing else.
 */

import { LlmError, type ModelId } from "./model-id";

export interface ModelPricing {
  /** USD per 1M uncached input (prompt) tokens. */
  inputPerM: number;
  /** USD per 1M output (completion) tokens. */
  outputPerM: number;
  /**
   * USD per 1M input tokens served from the provider's prompt cache. When a
   * model has no cached tier, cached tokens are billed at `inputPerM`.
   */
  cachedInputPerM?: number;
}

/** Token counts for one call, already split into billing buckets. */
export interface TokenUsage {
  /** Input tokens billed at the full input rate. */
  inputTokens: number;
  /** Output tokens. */
  outputTokens: number;
  /** Input tokens served from the prompt cache, billed at the cached rate. */
  cachedInputTokens?: number;
}

/**
 * `satisfies Record<ModelId, ModelPricing>` is what keeps a typo like
 * `"antropic:…"` from ever reaching the table: the key must match one of the
 * `<provider>:` template-literal patterns.
 */
const PRICING_TABLE = {
  "anthropic:claude-haiku-4-5": {
    inputPerM: 1.0,
    outputPerM: 5.0,
    cachedInputPerM: 0.1,
  },
  "anthropic:claude-sonnet-5": {
    inputPerM: 2.0,
    outputPerM: 10.0,
    cachedInputPerM: 0.2,
  },
  "google:gemini-3.7-flash": {
    inputPerM: 0.75,
    outputPerM: 3.75,
    cachedInputPerM: 0.075,
  },
  "google:gemini-2.5-flash-lite": {
    inputPerM: 0.1,
    outputPerM: 0.4,
    cachedInputPerM: 0.01,
  },
  "google:gemini-2.5-flash": {
    inputPerM: 0.3,
    outputPerM: 2.5,
    cachedInputPerM: 0.03,
  },
  "openai:gpt-5.4-mini": {
    inputPerM: 0.75,
    outputPerM: 4.5,
    cachedInputPerM: 0.075,
  },
  "openai:gpt-5.4-nano": {
    inputPerM: 0.2,
    outputPerM: 1.25,
    cachedInputPerM: 0.02,
  },
} as const satisfies Record<ModelId, ModelPricing>;

/**
 * Price lookup by model id.
 *
 * Note the type: `ModelId` is a template-literal union, so this is a *pattern*
 * index signature — TypeScript will happily type `PRICING["anthropic:made-up"]`
 * as `ModelPricing` even though it is `undefined` at runtime. Use
 * {@link getPricing} (or {@link estimateCost}, which throws) whenever the id
 * is not a literal you can see in the table above.
 */
export const PRICING: Record<ModelId, ModelPricing> = PRICING_TABLE;

/** The model ids ApplyOps actually knows how to price. */
export type KnownModelId = keyof typeof PRICING_TABLE;

/** Every priced model id — the candidate pool for `bench` (spec §8). */
export const KNOWN_MODEL_IDS = Object.keys(PRICING_TABLE) as KnownModelId[];

/** `generations.cost_usd` / `usage_daily.cost_usd` are `numeric(10, 6)`. */
export const COST_DECIMALS = 6;

/** Safe price lookup: `undefined` for anything not in the table. */
export function getPricing(id: string): ModelPricing | undefined {
  return (PRICING_TABLE as Record<string, ModelPricing>)[id.trim()];
}

/** Round to the precision `numeric(10, 6)` stores, avoiding float drift. */
function roundCost(usd: number): number {
  return Number(usd.toFixed(COST_DECIMALS));
}

function nonNegative(n: number | undefined): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Cost in USD of a call with the given token usage.
 *
 * Cached input tokens are billed at `cachedInputPerM`, falling back to the
 * full input rate for a model with no cached tier. The result is rounded to
 * six decimals so it round-trips through `numeric(10, 6)` unchanged.
 *
 * Throws `LlmError("unknown_model")` for a model with no pricing row: silently
 * returning 0 would let an unpriced model run unbounded against a user's daily
 * budget, which is exactly the failure the budget exists to prevent.
 */
export function estimateCost(id: ModelId, usage: TokenUsage): number {
  const pricing = getPricing(id);
  if (!pricing) {
    throw new LlmError(
      "unknown_model",
      `No pricing for model ${JSON.stringify(id)}. Add it to PRICING in src/llm/pricing.ts before using it.`,
    );
  }

  const input = nonNegative(usage.inputTokens);
  const output = nonNegative(usage.outputTokens);
  const cached = nonNegative(usage.cachedInputTokens);
  const cachedRate = pricing.cachedInputPerM ?? pricing.inputPerM;

  return roundCost(
    (input / 1_000_000) * pricing.inputPerM +
      (output / 1_000_000) * pricing.outputPerM +
      (cached / 1_000_000) * cachedRate,
  );
}

/**
 * Rough token count for a string, used only for the *pre-call* budget
 * estimate (the recorded cost always uses the provider's real counts).
 *
 * ~4 characters per token is the usual English approximation and is close
 * enough for a spend guard; it deliberately avoids pulling a tokenizer
 * dependency into the request path for every provider.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
