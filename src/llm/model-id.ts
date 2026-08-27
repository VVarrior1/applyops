/**
 * Model identity for the provider-agnostic LLM layer.
 *
 * Every model in ApplyOps is named by a single opaque-looking string,
 * `"<provider>:<model>"` (e.g. `"anthropic:claude-haiku-4-5"`). One string
 * means a model can be stored in a `text` column (`generations.model_id`,
 * `eval_runs.model_id`), passed on a CLI flag, and compared in the benchmark
 * without ever splitting the provider out into a second field.
 *
 * This is the root module of `src/llm/` — it imports nothing from the rest of
 * the layer, which is why `LlmError` (used by pricing, provider, budget and
 * call alike) is defined here rather than in `call.ts`; putting it anywhere
 * else would make the import graph cyclic. `call.ts` re-exports it so callers
 * outside `src/llm/` can import the whole public surface from one place.
 */

/** The providers ApplyOps can talk to. Order is stable; used for display. */
export const LLM_PROVIDERS = ["anthropic", "google", "openai"] as const;

export type Provider = (typeof LLM_PROVIDERS)[number];

/**
 * A fully-qualified model id. Deliberately a template-literal type: it keeps
 * typos in the provider half a compile error while leaving the model half
 * open, so a newly released model can be used without editing this file.
 */
export type ModelId = `${Provider}:${string}`;

export type LlmErrorCode =
  /** The string is not `<known-provider>:<non-empty-model>`. */
  | "invalid_model_id"
  /** Well-formed id, but `PRICING` has no row for it — cost is unknowable. */
  | "unknown_model"
  /** The provider's API key is not configured in this environment. */
  | "provider_unavailable"
  /** The user's `usage_daily` spend + this call's estimate exceeds their cap. */
  | "budget_exceeded"
  /** The model's reply could not be parsed into the step's zod schema. */
  | "schema_validation"
  /** The provider returned an error (or the network did). */
  | "provider_error";

/**
 * The one error type the LLM layer throws. `code` is what callers branch on;
 * `status` carries an HTTP status when one is meaningful (a provider's status,
 * or 429 for a budget refusal) so `app/api/**` route handlers can map a
 * failure to a response without string-matching messages.
 *
 * Messages are safe to show to a user and are never built from environment
 * values — only from provider status codes, model ids and zod errors.
 */
export class LlmError extends Error {
  readonly name = "LlmError";
  readonly code: LlmErrorCode;
  readonly status?: number;
  /** True when a retry could plausibly succeed (429/5xx, network blips). */
  readonly retryable: boolean;

  constructor(
    code: LlmErrorCode,
    message: string,
    opts: { status?: number; cause?: unknown; retryable?: boolean } = {},
  ) {
    super(message, { cause: opts.cause });
    this.code = code;
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
  }
}

export function isProvider(value: string): value is Provider {
  return (LLM_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Split `"anthropic:claude-haiku-4-5"` into its parts.
 *
 * Only the first colon separates: some providers use colons inside a model
 * name (OpenAI fine-tunes look like `ft:gpt-5.4-mini:acme`), so everything
 * after the first colon is the model. Throws `LlmError("invalid_model_id")`
 * on an unknown provider, a missing separator or an empty model name — an
 * unparseable id is a programming error, not a runtime condition, and failing
 * loudly beats silently calling the wrong model.
 */
export function parseModelId(id: string): { provider: Provider; model: string } {
  const trimmed = id.trim();
  const sep = trimmed.indexOf(":");

  if (sep <= 0) {
    throw new LlmError(
      "invalid_model_id",
      `Invalid model id ${JSON.stringify(id)}: expected "<provider>:<model>", e.g. "anthropic:claude-haiku-4-5".`,
    );
  }

  const provider = trimmed.slice(0, sep);
  const model = trimmed.slice(sep + 1).trim();

  if (!isProvider(provider)) {
    throw new LlmError(
      "invalid_model_id",
      `Unknown provider ${JSON.stringify(provider)} in model id ${JSON.stringify(id)}. Supported providers: ${LLM_PROVIDERS.join(", ")}.`,
    );
  }

  if (!model) {
    throw new LlmError(
      "invalid_model_id",
      `Model id ${JSON.stringify(id)} has an empty model name.`,
    );
  }

  return { provider, model };
}

/** Non-throwing form of {@link parseModelId}, usable as a type guard. */
export function isModelId(id: string): id is ModelId {
  try {
    parseModelId(id);
    return true;
  } catch {
    return false;
  }
}

/** Build a `ModelId` from its parts (the inverse of {@link parseModelId}). */
export function formatModelId(provider: Provider, model: string): ModelId {
  return `${provider}:${model.trim()}`;
}
