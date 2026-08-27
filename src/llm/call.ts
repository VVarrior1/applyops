/**
 * `callStructured()` — the single door every LLM call in ApplyOps goes
 * through.
 *
 * One function owns the whole envelope around a generation so no step, route
 * or CLI command can accidentally skip part of it:
 *
 *   1. resolve the model (per-step default unless overridden) and refuse
 *      early if the provider has no key configured;
 *   2. check the caller's daily budget *before* spending anything (spec §11);
 *   3. call the model with a zod-typed structured output;
 *   4. retry transient provider failures (429/5xx) with exponential backoff,
 *      and repair one schema violation by re-asking with the zod error
 *      appended (spec §13 — never retry other 4xx);
 *   5. record a `generations` row either way — output + tokens + cost +
 *      latency + prompt version on success, `error` on failure — and add the
 *      cost to `usage_daily`.
 *
 * Because every call lands in `generations`, the eval harness (§7), the model
 * benchmark (§8) and the settings budget view are all reading real data with
 * no extra instrumentation at the call sites.
 */

import {
  APICallError,
  Output,
  generateText,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  type LanguageModel,
  type LanguageModelUsage,
} from "ai";
import type { z } from "zod";
import type { Db } from "../db/client";
import { generations, type Step } from "../db/schema";
import {
  BudgetExceededError,
  checkBudget,
  recordUsage,
} from "./budget";
import { DEFAULT_MODEL_BY_STEP } from "./defaults";
import { LlmError, parseModelId, type ModelId } from "./model-id";
import { COST_DECIMALS, estimateCost, estimateTokens, type TokenUsage } from "./pricing";
import { isProviderAvailable, resolveModel } from "./provider";

export { LlmError, type ModelId } from "./model-id";
export { BudgetExceededError } from "./budget";

/** Base delay for the exponential backoff between transient retries. */
export const RETRY_BASE_MS = 500;

/**
 * Retries *after* the first attempt, for transient errors only. Two retries =
 * three attempts, which is what spec §13 specifies.
 */
export const DEFAULT_MAX_RETRIES = 2;

/** At most one schema-repair round trip, per spec §13. */
const MAX_SCHEMA_REPAIRS = 1;

/**
 * Output tokens assumed when estimating a call's cost *before* it runs. Only
 * used for the budget pre-check; the recorded cost always uses the provider's
 * real counts. Generous on purpose — a pre-check that under-estimates lets a
 * user overshoot their cap.
 */
export const ESTIMATED_OUTPUT_TOKENS = 1500;

/** Cap on how much provider/zod error text is stored in `generations.error`. */
const MAX_ERROR_CHARS = 2000;

export interface CallStructuredArgs<T> {
  db: Db;
  /** `null` for owner CLI / eval runs: bypasses the budget, no `usage_daily`. */
  userId: string | null;
  jobId?: string;
  step: Step;
  /** Defaults to `DEFAULT_MODEL_BY_STEP[step]`. */
  modelId?: ModelId;
  schema: z.ZodType<T>;
  system: string;
  prompt: string;
  /** `prompt_versions.id` — makes every generation reproducible. */
  promptVersionId: string;
  /** Transient-error retries after the first attempt. Default 2 (3 attempts). */
  maxRetries?: number;
  abortSignal?: AbortSignal;
  /**
   * Test seams, mirroring the AI SDK's own `_internal` convention. Not public
   * API: `model` bypasses provider resolution (so unit tests can inject
   * `MockLanguageModelV3`) and `sleep` makes backoff instant.
   */
  _internal?: {
    model?: LanguageModel;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  };
}

export interface CallStructuredResult<T> {
  output: T;
  generationId: string;
  /** Real token counts from the provider, summed across attempts. */
  usage: TokenUsage;
  costUsd: number;
  /** Wall-clock time across every attempt, i.e. what the caller waited. */
  latencyMs: number;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Map the AI SDK's usage shape onto our two billing buckets.
 *
 * `usage.inputTokens` is the *total* including cache reads (all three
 * providers normalise it that way), so the uncached count comes from
 * `noCacheTokens` when the provider reports it and from `total - cacheRead`
 * otherwise. Cache-*write* tokens are billed at the full input rate here;
 * Anthropic actually charges 1.25× for a 5-minute cache write, but ApplyOps
 * never sets `cache_control`, so this bucket is always 0 in practice.
 */
export function normalizeUsage(usage: LanguageModelUsage): TokenUsage {
  const details = usage.inputTokenDetails;
  const cachedInputTokens = details?.cacheReadTokens ?? 0;
  const cacheWrite = details?.cacheWriteTokens ?? 0;
  const noCache = details?.noCacheTokens;

  const inputTokens =
    noCache != null
      ? noCache + cacheWrite
      : Math.max(0, (usage.inputTokens ?? 0) - cachedInputTokens);

  return {
    inputTokens,
    outputTokens: usage.outputTokens ?? 0,
    cachedInputTokens,
  };
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0),
  };
}

/**
 * Did the model reply, but with something that isn't the requested shape?
 * That's a prompting problem, fixable by re-asking — unlike a transport
 * error, which is fixable by waiting.
 */
function isSchemaFailure(err: unknown): boolean {
  return NoObjectGeneratedError.isInstance(err) || NoOutputGeneratedError.isInstance(err);
}

/**
 * Transient provider failures only: 429 and 5xx (plus 408/409 and network
 * errors, which the SDK already flags as retryable). Every other 4xx is a bad
 * request — a bad key, an unknown model, an oversized prompt — and retrying it
 * just burns time and money (spec §13: "never on 4xx").
 */
export function isTransientError(err: unknown): boolean {
  if (!APICallError.isInstance(err)) return false;
  const status = err.statusCode;
  if (status === 429) return true;
  if (status != null && status >= 500) return true;
  if (status != null && status >= 400) return false;
  return err.isRetryable === true;
}

function errorText(err: unknown): string {
  const cause = (err as { cause?: unknown } | null)?.cause;
  const causeMessage =
    cause instanceof Error && cause.message ? `: ${cause.message}` : "";
  const base = err instanceof Error ? err.message : String(err);
  return `${base}${causeMessage}`.slice(0, MAX_ERROR_CHARS);
}

/** The repair round trip: show the model exactly what it got wrong. */
function repairPrompt(prompt: string, err: unknown): string {
  return [
    prompt,
    "",
    "---",
    "Your previous reply could not be parsed into the required JSON schema.",
    `Error: ${errorText(err)}`,
    "Reply again with ONLY the JSON object required by the schema — no prose,",
    "no explanation, no markdown code fences.",
  ].join("\n");
}

/**
 * Run one structured generation end to end. See the file header for the full
 * contract; throws {@link BudgetExceededError} (status 429) when the user is
 * out of budget and {@link LlmError} for everything else.
 */
export async function callStructured<T>(
  args: CallStructuredArgs<T>,
): Promise<CallStructuredResult<T>> {
  const {
    db,
    userId,
    jobId,
    step,
    schema,
    system,
    prompt,
    promptVersionId,
    abortSignal,
  } = args;

  const modelId = args.modelId ?? DEFAULT_MODEL_BY_STEP[step];
  const maxRetries = Math.max(0, args.maxRetries ?? DEFAULT_MAX_RETRIES);
  const sleep = args._internal?.sleep ?? defaultSleep;
  const now = args._internal?.now ?? Date.now;

  // Throws LlmError("invalid_model_id") before any DB or network work.
  const { provider } = parseModelId(modelId);

  const model = args._internal?.model;
  if (!model && !isProviderAvailable(provider)) {
    // resolveModel() would throw the same error; checking here keeps the
    // message identical whether or not a test model was injected.
    resolveModel(modelId);
  }
  const languageModel: LanguageModel = model ?? resolveModel(modelId);

  // ---- budget gate (before a single token is spent) ----------------------
  if (userId !== null) {
    const estimate = estimateCost(modelId, {
      inputTokens: estimateTokens(`${system}\n${prompt}`),
      outputTokens: ESTIMATED_OUTPUT_TOKENS,
    });
    const decision = await checkBudget(db, userId, estimate);
    if (!decision.allowed) {
      throw new BudgetExceededError(
        decision.reason ?? "Daily AI budget reached.",
        decision,
      );
    }
  }

  // ---- call, with repair + transient retries -----------------------------
  const startedAt = now();
  let usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
  };
  let promptToSend = prompt;
  let repairs = 0;
  let retries = 0;

  for (;;) {
    try {
      const result = await generateText({
        model: languageModel,
        system,
        prompt: promptToSend,
        output: Output.object({ schema }),
        // Our own loop owns retries so the backoff, the attempt count and the
        // token accounting all stay in one place.
        maxRetries: 0,
        abortSignal,
      });

      usage = addUsage(usage, normalizeUsage(result.usage));
      const costUsd = estimateCost(modelId, usage);
      const latencyMs = Math.max(0, Math.round(now() - startedAt));
      const output = result.output as T;

      const [row] = await db
        .insert(generations)
        .values({
          userId,
          jobId: jobId ?? null,
          step,
          promptVersionId,
          modelId,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costUsd: costUsd.toFixed(COST_DECIMALS),
          latencyMs,
          output,
          error: null,
        })
        .returning({ id: generations.id });

      if (!row?.id) {
        throw new LlmError(
          "provider_error",
          `Failed to record the generation for step ${step}.`,
        );
      }

      await recordUsage(db, userId, costUsd);

      return { output, generationId: row.id, usage, costUsd, latencyMs };
    } catch (err) {
      // A failed attempt still burned tokens; keep billing honest.
      if (NoObjectGeneratedError.isInstance(err) && err.usage) {
        usage = addUsage(usage, normalizeUsage(err.usage));
      }

      if (isSchemaFailure(err) && repairs < MAX_SCHEMA_REPAIRS) {
        repairs += 1;
        promptToSend = repairPrompt(prompt, err);
        continue;
      }

      if (isTransientError(err) && retries < maxRetries) {
        retries += 1;
        await sleep(RETRY_BASE_MS * 2 ** (retries - 1));
        continue;
      }

      // ---- terminal failure --------------------------------------------
      const latencyMs = Math.max(0, Math.round(now() - startedAt));
      const message = errorText(err);
      const costUsd = estimateCost(modelId, usage);

      const llmError =
        err instanceof LlmError
          ? err
          : new LlmError(
              isSchemaFailure(err) ? "schema_validation" : "provider_error",
              message,
              {
                cause: err,
                status: APICallError.isInstance(err)
                  ? err.statusCode
                  : undefined,
                retryable: isTransientError(err),
              },
            );

      // Best-effort bookkeeping: a broken generations insert must not replace
      // the real reason the call failed.
      try {
        await db.insert(generations).values({
          userId,
          jobId: jobId ?? null,
          step,
          promptVersionId,
          modelId,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costUsd: costUsd.toFixed(COST_DECIMALS),
          latencyMs,
          output: null,
          error: message,
        });
        await recordUsage(db, userId, costUsd);
      } catch {
        // swallowed on purpose — see above
      }

      throw llmError;
    }
  }
}
