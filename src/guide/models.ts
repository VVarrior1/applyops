/**
 * The model picker's option list.
 *
 * The `/guide` chat is the one place a user chooses their own model, so the
 * list has to be honest about two things the pricing table alone does not say:
 * which providers actually have a key in *this* deployment (spec §12 —
 * `OPENAI_API_KEY` is deliberately absent here, and a picker offering GPT
 * would hand the user a 500), and what they are trading when they pick the
 * cheap one.
 *
 * Pure on purpose: `buildModelOptions()` takes availability as a function and
 * pricing as a table, so the route passes `isProviderAvailable` and `PRICING`
 * and the unit test passes fakes. No `process.env` read in here.
 */

import { parseModelId, type ModelId, type Provider } from "../llm/model-id";
import { PRICING, type ModelPricing } from "../llm/pricing";

/**
 * A rough quality band, so "cheapest first" does not read as "best first".
 * These are labels for humans, not measurements — the measured comparisons
 * are on `/benchmark`, and the two models ApplyOps has actually benchmarked
 * (3.7-flash vs 2.5-flash-lite, four steps) agree with the ordering below.
 */
export type ModelTier = "fast/cheap" | "balanced" | "strong";

/** Blended $/1M tokens used to rank the list. */
export const BLENDED_INPUT_WEIGHT = 0.75;
export const BLENDED_OUTPUT_WEIGHT = 0.25;

export interface ModelOption {
  id: ModelId;
  /** Human label, e.g. "Gemini 3.7 Flash (google)". */
  label: string;
  inputPerM: number;
  outputPerM: number;
  tier: ModelTier;
}

/**
 * Tier by blended price. Chat is a long-context, short-answer workload, so the
 * blend leans on input price. The thresholds are chosen to put the two
 * benchmarked Google models either side of "balanced", which is where the
 * measured quality gap actually sits.
 */
export function blendedPricePerM(pricing: ModelPricing): number {
  return (
    pricing.inputPerM * BLENDED_INPUT_WEIGHT +
    pricing.outputPerM * BLENDED_OUTPUT_WEIGHT
  );
}

export function tierFor(pricing: ModelPricing): ModelTier {
  const blended = blendedPricePerM(pricing);
  if (blended < 0.5) return "fast/cheap";
  if (blended < 2.5) return "balanced";
  return "strong";
}

/**
 * Pretty name for a model id. Deliberately derived from the id rather than
 * kept in a second table: a model added to `PRICING` shows up in the picker
 * immediately with a reasonable name, and there is no list to forget to update.
 */
export function labelFor(id: string): string {
  const [provider, ...rest] = id.split(":");
  const model = rest.join(":") || id;
  const pretty = model
    .split("-")
    .map((part) =>
      /^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join(" ")
    .replace(/\bGpt\b/i, "GPT");
  return `${pretty} (${provider})`;
}

/**
 * Every priced model whose provider is usable right now, cheapest first.
 *
 * @param isAvailable answers "does this provider have a key?" — pass
 *   `isProviderAvailable` from `src/llm/provider.ts`.
 * @param pricing the price table; defaults to the real one.
 */
export function buildModelOptions(
  isAvailable: (provider: Provider) => boolean,
  pricing: Record<string, ModelPricing> = PRICING,
): ModelOption[] {
  const options: ModelOption[] = [];

  for (const [id, price] of Object.entries(pricing)) {
    let provider: Provider;
    try {
      provider = parseModelId(id).provider;
    } catch {
      // An id in the table that is not a valid `provider:model` cannot be
      // resolved to a model handle either, so it can never be chosen.
      continue;
    }
    if (!isAvailable(provider)) continue;

    options.push({
      id: id as ModelId,
      label: labelFor(id),
      inputPerM: price.inputPerM,
      outputPerM: price.outputPerM,
      tier: tierFor(price),
    });
  }

  return options.sort((a, b) => {
    const delta =
      blendedPricePerM({ inputPerM: a.inputPerM, outputPerM: a.outputPerM }) -
      blendedPricePerM({ inputPerM: b.inputPerM, outputPerM: b.outputPerM });
    // Ties broken by id so the list order is stable across requests.
    return delta !== 0 ? delta : a.id.localeCompare(b.id);
  });
}

/**
 * Resolve the model a chat request asked for: the requested id when it is
 * priced *and* its provider is configured, otherwise the fallback. Never
 * trusts the client — an unpriced id would run against the daily budget
 * uncosted, which is the one thing `estimateCost()` refuses to allow.
 */
export function resolveChatModel(
  requested: string | null | undefined,
  fallback: ModelId,
  isAvailable: (provider: Provider) => boolean,
  pricing: Record<string, ModelPricing> = PRICING,
): ModelId {
  const id = (requested ?? "").trim();
  if (!id) return fallback;
  const allowed = buildModelOptions(isAvailable, pricing);
  return allowed.some((option) => option.id === id) ? (id as ModelId) : fallback;
}
