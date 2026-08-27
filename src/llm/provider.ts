/**
 * Provider resolution: `ModelId` → a Vercel AI SDK `LanguageModel`.
 *
 * This is the only file in the repo that imports a provider package, so
 * swapping or adding a provider is a one-file change. It is also where
 * "provider unavailable" is decided: `OPENAI_API_KEY` is deliberately absent
 * from this project's `.env.local`, so anything that iterates models (the
 * benchmark, the eval harness) must be able to *ask* whether a provider is
 * usable instead of discovering it by crashing mid-run.
 */

import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import {
  LLM_PROVIDERS,
  LlmError,
  parseModelId,
  type ModelId,
  type Provider,
} from "./model-id";

/**
 * The environment variable each provider's SDK reads its key from. These are
 * the names the AI SDK packages themselves look up — do not rename them.
 */
export const PROVIDER_ENV_VAR: Record<Provider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  openai: "OPENAI_API_KEY",
};

/**
 * Is this provider usable in this environment?
 *
 * Read live from `process.env` on every call rather than cached at module
 * load: Next.js route handlers, the CLI and vitest all populate the
 * environment at different moments, and a cached `false` from an early import
 * would be impossible to debug. Whitespace-only values count as missing.
 */
export function isProviderAvailable(provider: Provider): boolean {
  return (process.env[PROVIDER_ENV_VAR[provider]] ?? "").trim().length > 0;
}

/** The providers with a key configured right now. */
export function availableProviders(): Provider[] {
  return LLM_PROVIDERS.filter(isProviderAvailable);
}

/** Is this specific model's provider configured? (Says nothing about pricing.) */
export function isModelAvailable(id: string): boolean {
  try {
    return isProviderAvailable(parseModelId(id).provider);
  } catch {
    return false;
  }
}

/**
 * Build the AI SDK model handle for a `ModelId`.
 *
 * Throws `LlmError("provider_unavailable")` when the key is missing, so the
 * failure names the exact environment variable to set instead of surfacing as
 * an opaque 401 from the provider several layers down.
 */
export function resolveModel(id: ModelId): LanguageModel {
  const { provider, model } = parseModelId(id);

  if (!isProviderAvailable(provider)) {
    throw new LlmError(
      "provider_unavailable",
      `Provider ${provider} is not configured: set ${PROVIDER_ENV_VAR[provider]} to use ${id}.`,
    );
  }

  switch (provider) {
    case "anthropic":
      return anthropic(model);
    case "google":
      return google(model);
    case "openai":
      return openai(model);
  }
}
