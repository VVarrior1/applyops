/**
 * Plumbing shared by the six pipeline steps.
 *
 * Every step is the same three moves — register the prompt version, render the
 * inputs into a user message, call the model with the step's zod schema — so
 * they live here once and each step file is left holding only the thing that
 * makes it different: how its inputs are rendered.
 *
 * Steps never touch the database beyond this (spec §5: "Steps never read the
 * DB directly — callers pass inputs and persist `generations`"). The `db`
 * handle is threaded through solely so `callStructured()` can record the
 * generation and the prompt version it used.
 */

import type { LanguageModel } from "ai";
import type { Db } from "../../db/client";
import type { Step } from "../../db/schema";
import { callStructured, type ModelId } from "../../llm/call";
import type { TokenUsage } from "../../llm/pricing";
import { ensurePromptVersion, loadPrompt } from "../prompt-versions";
import type { AnalyzeOutput, Fact, FitOutput } from "../schemas";
import type { z } from "zod";

/**
 * What every `run<Step>()` returns. A superset of the `{output, generationId}`
 * the build plan requires: cost and latency come back from `callStructured()`
 * already measured, and the eval runner (spec §7) and benchmark (spec §8) need
 * them per item — reading them back out of `generations` would be a second
 * round trip for numbers we are already holding.
 */
export interface StepResult<T> {
  output: T;
  /** `generations.id` — the audit trail for this exact call. */
  generationId: string;
  usage: TokenUsage;
  costUsd: number;
  latencyMs: number;
}

/** Options every step accepts. */
export interface StepOptions {
  /**
   * Whose budget this call spends. `null` = owner CLI / eval / benchmark:
   * bypasses the daily cap and writes no `usage_daily` row. Never pass `null`
   * from a web request (see `src/llm/budget.ts`).
   */
  userId?: string | null;
  /** Links the generation to a job so `/jobs/[id]` can show its history. */
  jobId?: string;
  /** Overrides `DEFAULT_MODEL_BY_STEP[step]` — used by `eval` and `bench`. */
  modelId?: ModelId;
  abortSignal?: AbortSignal;
  /**
   * Test seam, forwarded to `callStructured()` — same convention the AI SDK
   * uses. Injecting a `MockLanguageModelV3` here is what lets the step tests
   * assert on the rendered prompt with no network and no provider key. Not
   * public API; production callers never set it.
   */
  _internal?: { model?: LanguageModel };
}

/**
 * Cost guards. Job descriptions and resumes are user-supplied and occasionally
 * enormous (a 60k-character posting is not rare); an unbounded prompt turns
 * one ranking batch into a surprise bill. Truncation is marked in the text so
 * the model knows it is seeing a prefix rather than a complete document.
 */
export const MAX_DESCRIPTION_CHARS = 12_000;
export const MAX_RESUME_CHARS = 24_000;

export function truncate(text: string, maxChars: number): string {
  const trimmed = (text ?? "").trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}\n\n[…truncated at ${maxChars} characters]`;
}

/**
 * Render facts the one way every prompt documents: `LABEL | category | text`,
 * one per line. This exact shape is what the prompts tell the model to cite,
 * and what `checkCitations()` then verifies — so it is defined once.
 */
export function renderFacts(facts: readonly Fact[]): string {
  if (!facts || facts.length === 0) {
    return "(no confirmed facts on file — you may not make any claim about the candidate)";
  }
  return facts
    .map((fact) => `${fact.label} | ${fact.category} | ${fact.text}`)
    .join("\n");
}

/** The labels a model is allowed to cite, for `checkCitations()`. */
export function factLabels(facts: readonly Fact[]): Set<string> {
  return new Set(facts.map((fact) => fact.label));
}

/** Compact re-rendering of an `analyze` output for the downstream steps. */
export function renderAnalysis(analysis: AnalyzeOutput): string {
  const must = analysis.requirements.filter((r) => r.must_have);
  const nice = analysis.requirements.filter((r) => !r.must_have);
  const lines = [
    `Summary: ${analysis.summary}`,
    `Seniority: ${analysis.seniority} (minimum ${analysis.years_min} years)`,
    `Work authorization signal: ${analysis.work_auth_signal}`,
    "",
    "Must-have requirements:",
    ...(must.length
      ? must.map((r) => `- ${r.text}`)
      : ["- (none marked as required)"]),
  ];
  if (nice.length) {
    lines.push("", "Other requirements:", ...nice.map((r) => `- ${r.text}`));
  }
  if (analysis.nice_to_have.length) {
    lines.push(
      "",
      `Nice to have: ${analysis.nice_to_have.join("; ")}`,
    );
  }
  if (analysis.keywords.length) {
    lines.push(`Keywords: ${analysis.keywords.join(", ")}`);
  }
  return lines.join("\n");
}

/** Compact re-rendering of a `fit` output for `tailor` and `suggest`. */
export function renderFit(fit: FitOutput): string {
  const lines = [`Fit score: ${fit.score}/100`, `Rationale: ${fit.rationale}`];
  if (fit.matched.length) {
    lines.push(
      "Requirements already evidenced:",
      ...fit.matched.map(
        (m) => `- ${m.requirement} [${m.fact_ids.join(", ") || "no citation"}]`,
      ),
    );
  }
  if (fit.gaps.length) {
    lines.push("Gaps:", ...fit.gaps.map((g) => `- ${g}`));
  }
  return lines.join("\n");
}

/** Join labelled blocks into the user message, dropping empty ones. */
export function sections(
  blocks: { heading: string; body: string | null | undefined }[],
): string {
  return blocks
    .filter((b) => b.body != null && String(b.body).trim() !== "")
    .map((b) => `## ${b.heading}\n${String(b.body).trim()}`)
    .join("\n\n");
}

/**
 * The one call every step makes: register the prompt version (the FK
 * `generations.prompt_version_id` requires it to exist first), then run the
 * generation with the prompt file's body as the system message.
 */
export async function runStep<T>(
  db: Db,
  step: Step,
  args: StepOptions & { schema: z.ZodType<T>; prompt: string },
): Promise<StepResult<T>> {
  const promptVersionId = await ensurePromptVersion(db, step);
  const { content } = loadPrompt(step);

  const { output, generationId, usage, costUsd, latencyMs } =
    await callStructured({
      db,
      userId: args.userId ?? null,
      jobId: args.jobId,
      step,
      modelId: args.modelId,
      schema: args.schema,
      system: content,
      prompt: args.prompt,
      promptVersionId,
      abortSignal: args.abortSignal,
      _internal: args._internal,
    });

  return { output, generationId, usage, costUsd, latencyMs };
}
