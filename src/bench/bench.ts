/**
 * The model benchmark (spec §8).
 *
 * `runBench` runs each requested **step × model** pair over the frozen golden
 * set and records one `eval_runs` row per pair, so the public `/benchmark`
 * page is reading exactly the same table the private `/evals` page reads —
 * there is no second, friendlier set of numbers.
 *
 * Four things make this more than a loop around `runEval`:
 *
 *   1. **Unavailable providers are planned around, not crashed into.**
 *      `OPENAI_API_KEY` is deliberately absent from this project, so a model
 *      list that names OpenAI must produce a *skip with a reason*, not a run
 *      that dies on item 1. {@link planBench} is pure and unit-tested.
 *   2. **The judge is fixed and is itself disclosed.** Every pair is graded by
 *      {@link JUDGE_MODEL_ID}; the page says so, including the caveat that the
 *      judge may share a provider with a contestant.
 *   3. **Each step gets its own rubric.** `tailor` is graded by
 *      `judge.v1.md`; `analyze`, `fit` and `suggest` are graded by
 *      `judge_<step>.v1.md`, which reinterprets the four axes for what that
 *      step actually produces. The axes keep their names so one mean score is
 *      comparable across steps and `eval_results.judge_scores` keeps one shape.
 *   4. **$/item is the contestant's cost, not the run's.** A run's total also
 *      contains the cached analysis and the judge fee, both identical for
 *      every contestant; charging them to the model under test would flatten
 *      the price difference the benchmark exists to show.
 *
 * The golden set lives under `tailor` (spec §7: "40 `eval_items` for `tailor`
 * (and reused for `fit`/`suggest`)"), so every bench run loads
 * `itemStep: "tailor"` while recording itself under the step it measured.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "../db/client";
import { evalRuns, promptVersions, type Step } from "../db/schema";
import { callStructured } from "../llm/call";
import { DEFAULT_MODEL_BY_STEP, JUDGE_MODEL_ID } from "../llm/defaults";
import { LLM_PROVIDERS, parseModelId, type ModelId, type Provider } from "../llm/model-id";
import { getPricing } from "../llm/pricing";
import { PROVIDER_ENV_VAR, isProviderAvailable } from "../llm/provider";
import type { HallucinationReport, UnsupportedClaim } from "../pipeline/hallucination";
import { checkCitations } from "../pipeline/hallucination";
import { loadPrompt } from "../pipeline/prompt-versions";
import {
  JUDGE_AXES,
  JudgeOutput,
  type FitOutput,
  type SuggestOutput,
  type TailorOutput,
} from "../pipeline/schemas";
import {
  buildJudgePrompt,
  factLabels,
  renderAnalysis,
  renderFacts,
  runAnalyze,
  runFit,
  runJudge,
  runSuggest,
  runTailor,
} from "../pipeline/steps";
import {
  MAX_DESCRIPTION_CHARS,
  sections,
  truncate,
} from "../pipeline/steps/shared";
import { ensureAnalysis, type GoldenItem } from "../eval/golden";
import {
  BOOTSTRAP_ITERATIONS,
  DEFAULT_BOOTSTRAP_SEED,
  runEval,
  type EvalItemContext,
  type EvalResultRow,
  type EvalRunSummary,
  type ItemEvaluator,
} from "../eval/runner";
import { bootstrapMeanDiff, mean } from "../eval/stats";

// ---------------------------------------------------------------------------
// What the benchmark covers
// ---------------------------------------------------------------------------

/** The steps a model can be benchmarked on (spec §8). */
export const BENCH_STEPS = ["analyze", "fit", "tailor", "suggest"] as const;
export type BenchStep = (typeof BENCH_STEPS)[number];

export function isBenchStep(value: string): value is BenchStep {
  return (BENCH_STEPS as readonly string[]).includes(value);
}

/**
 * The golden set is recorded under one step and reused by the others
 * (spec §7). Changing this would orphan every existing `eval_items` row.
 */
export const GOLDEN_ITEM_STEP: Step = "tailor";

/** Spec §8's candidate pool. OpenAI entries are skipped when the key is absent. */
export const DEFAULT_BENCH_MODELS: ModelId[] = [
  "anthropic:claude-haiku-4-5",
  "anthropic:claude-sonnet-5",
  "google:gemini-3.7-flash",
  "google:gemini-2.5-flash-lite",
  "openai:gpt-5.4-mini",
  "openai:gpt-5.4-nano",
];

// ---------------------------------------------------------------------------
// planBench — pure
// ---------------------------------------------------------------------------

export interface SkippedModel {
  modelId: string;
  reason: string;
}

export interface BenchPlan {
  /** Models that will actually run, in the order given, de-duplicated. */
  models: ModelId[];
  skipped: SkippedModel[];
}

export interface PlanBenchArgs {
  models: readonly string[];
  /**
   * Provider availability override. A provider absent from the map falls back
   * to reading the real environment, so callers can override one provider in a
   * test without having to enumerate all three.
   */
  available?: Partial<Record<Provider, boolean>>;
}

/**
 * Decide which of the requested models can run here.
 *
 * A model is skipped when its provider has no API key configured (the reason
 * names the exact environment variable, so the fix is copy-pasteable) or when
 * `src/llm/pricing.ts` has no price for it — an unpriced model would run
 * happily and then throw when the run tried to cost it, half way through.
 *
 * Pure and synchronous on purpose: this is the decision the benchmark's
 * honesty rests on, and it is unit-tested without a database or a network.
 */
export function planBench({ models, available }: PlanBenchArgs): BenchPlan {
  const planned: ModelId[] = [];
  const skipped: SkippedModel[] = [];
  const seen = new Set<string>();

  for (const raw of models) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);

    // Throws LlmError("invalid_model_id") — a typo in `--models` is a mistake
    // to surface, not a model to quietly drop.
    const { provider } = parseModelId(id);

    const usable = available?.[provider] ?? isProviderAvailable(provider);
    if (!usable) {
      skipped.push({ modelId: id, reason: `missing ${PROVIDER_ENV_VAR[provider]}` });
      continue;
    }

    if (!getPricing(id)) {
      skipped.push({
        modelId: id,
        reason: "no pricing row in src/llm/pricing.ts",
      });
      continue;
    }

    planned.push(id as ModelId);
  }

  return { models: planned, skipped };
}

/** Providers with a key configured — what the CLI prints before it starts. */
export function benchProviderAvailability(): Record<Provider, boolean> {
  return Object.fromEntries(
    LLM_PROVIDERS.map((provider) => [provider, isProviderAvailable(provider)]),
  ) as Record<Provider, boolean>;
}

// ---------------------------------------------------------------------------
// Step-specific judge rubrics
// ---------------------------------------------------------------------------

export interface JudgeRubric {
  /** The step whose output this rubric grades. */
  grades: BenchStep;
  content: string;
  version: string;
  sha256: string;
  /** The `prompt_versions.version` this rubric is stored under. */
  storedVersion: string;
}

const rubricCache = new Map<BenchStep, JudgeRubric>();

function promptsDir(): string {
  let here: string | null = null;
  try {
    here = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    // A bundler rewrote import.meta.url; fall back to the repo root.
  }
  const candidates = [
    here ? path.resolve(here, "../pipeline/prompts") : null,
    path.resolve(process.cwd(), "src/pipeline/prompts"),
  ].filter((dir): dir is string => dir !== null);
  const found = candidates.find((dir) => existsSync(dir));
  if (!found) {
    throw new Error(`Prompt directory not found. Looked in: ${candidates.join(", ")}`);
  }
  return found;
}

/**
 * Load `judge_<step>.v1.md`.
 *
 * These files cannot go through `loadPrompt()`: that resolves one file per
 * `Step`, and all of these are the *same* step (`judge`) with different
 * rubrics. They are stored in `prompt_versions` under step `judge` with the
 * version suffixed by what they grade (`1.0.0-fit`), which keeps the
 * `(step, version)` unique index happy and leaves the four-axis rubric for
 * `tailor` — plain `judge.v1.md`, version `1.0.0` — exactly where it was.
 */
export function loadJudgeRubric(step: BenchStep): JudgeRubric {
  const cached = rubricCache.get(step);
  if (cached) return cached;

  const filePath = path.join(promptsDir(), `judge_${step}.v1.md`);
  const raw = readFileSync(filePath, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) {
    throw new Error(`Rubric ${filePath} is missing its --- front matter block.`);
  }

  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    fields[line.slice(0, idx).trim()] = line
      .slice(idx + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }

  if (fields.step !== "judge") {
    throw new Error(`Rubric ${filePath} must declare \`step: judge\` (got ${fields.step}).`);
  }
  if (fields.grades !== step) {
    throw new Error(
      `Rubric ${filePath} declares \`grades: ${fields.grades}\` but is named for ${step}.`,
    );
  }
  if (!/^\d+\.\d+\.\d+$/.test(fields.version ?? "")) {
    throw new Error(`Rubric ${filePath} needs a semver \`version:\` in its front matter.`);
  }

  const content = raw.slice(match[0].length).trim();
  if (!content) throw new Error(`Rubric ${filePath} has no body below the front matter.`);

  const rubric: JudgeRubric = {
    grades: step,
    content,
    version: fields.version,
    sha256: createHash("sha256").update(content, "utf8").digest("hex"),
    storedVersion: `${fields.version}-${step}`,
  };
  rubricCache.set(step, rubric);
  return rubric;
}

/** Test/CLI helper: forget the on-disk rubric cache. */
export function clearRubricCache(): void {
  rubricCache.clear();
}

const rubricIdCache = new WeakMap<object, Map<string, string>>();

/**
 * Register a rubric in `prompt_versions` and return its id.
 *
 * Same contract as `ensurePromptVersion()`: a body that changed without a
 * version bump is registered under `<version>+<sha8>` rather than overwriting
 * the row historical generations point at.
 */
export async function ensureRubricVersion(db: Db, step: BenchStep): Promise<string> {
  const rubric = loadJudgeRubric(step);
  let cache = rubricIdCache.get(db as unknown as object);
  if (!cache) {
    cache = new Map();
    rubricIdCache.set(db as unknown as object, cache);
  }
  const key = `${step}:${rubric.sha256}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const find = async (version: string) => {
    const [row] = await db
      .select({ id: promptVersions.id, sha256: promptVersions.sha256 })
      .from(promptVersions)
      .where(and(eq(promptVersions.step, "judge"), eq(promptVersions.version, version)))
      .limit(1);
    return row ?? null;
  };

  let version = rubric.storedVersion;
  const existing = await find(version);
  if (existing?.sha256 === rubric.sha256) {
    cache.set(key, existing.id);
    return existing.id;
  }
  if (existing) version = `${rubric.storedVersion}+${rubric.sha256.slice(0, 8)}`;

  const drifted = existing ? await find(version) : null;
  if (drifted?.id) {
    cache.set(key, drifted.id);
    return drifted.id;
  }

  const [inserted] = await db
    .insert(promptVersions)
    .values({ step: "judge", version, sha256: rubric.sha256, content: rubric.content })
    .onConflictDoNothing({ target: [promptVersions.step, promptVersions.version] })
    .returning({ id: promptVersions.id });

  const id = inserted?.id ?? (await find(version))?.id;
  if (!id) {
    throw new Error(`Could not resolve a prompt_versions row for judge ${version}.`);
  }
  cache.set(key, id);
  return id;
}

// ---------------------------------------------------------------------------
// Per-step adapters: run the step, check its citations, build its judge prompt
// ---------------------------------------------------------------------------

interface AdapterRun {
  output: unknown;
  generationId: string;
  /** Cost of the step under test alone — what $/item reports. */
  stepCostUsd: number;
  /** Cost of everything the step needed first (a cache miss on `analyze`). */
  setupCostUsd: number;
  latencyMs: number;
}

interface StepAdapter {
  /** `null` = graded by the default four-axis rubric in `judge.v1.md`. */
  rubric: BenchStep | null;
  run(db: Db, item: GoldenItem, ctx: EvalItemContext): Promise<AdapterRun>;
  check(output: unknown, labels: Set<string>): HallucinationReport;
  judgePrompt(item: GoldenItem, output: unknown): string;
}

const NO_CLAIMS: HallucinationReport = { totalClaims: 0, unsupported: [], rate: 0 };

/**
 * `fit` cites facts in `matched[].fact_ids`, a shape `checkCitations()` does
 * not know (it handles `tailor` and `suggest`). The rule is identical — a
 * claim citing nothing, or citing a label the user does not have, is
 * unsupported — so it is applied here rather than widening the shared checker,
 * which other tasks are editing in parallel.
 */
export function checkFitCitations(
  output: FitOutput,
  validLabels: Set<string>,
): HallucinationReport {
  const valid = new Set([...validLabels].map((label) => label.trim().toUpperCase()));
  const unsupported: UnsupportedClaim[] = [];

  for (const [i, entry] of output.matched.entries()) {
    const ids = entry.fact_ids ?? [];
    const badIds = ids.filter((id) => !valid.has(id.trim().toUpperCase()));
    if (ids.length === 0 || badIds.length > 0) {
      unsupported.push({ path: `matched[${i}]`, text: entry.requirement, badIds });
    }
  }

  return {
    totalClaims: output.matched.length,
    unsupported,
    rate: output.matched.length === 0 ? 0 : unsupported.length / output.matched.length,
  };
}

function jobBlock(item: GoldenItem): string {
  return [
    `Title: ${item.title}`,
    `Company: ${item.company}`,
    item.location ? `Location: ${item.location}` : null,
    item.remote == null ? null : `Remote: ${item.remote ? "yes" : "no"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Job header + posting, the two blocks every rubric needs to check against. */
function jobSections(item: GoldenItem) {
  return [
    { heading: "Job", body: jobBlock(item) },
    { heading: "Posting", body: truncate(item.description, MAX_DESCRIPTION_CHARS) },
  ];
}

const ADAPTERS: Record<BenchStep, StepAdapter> = {
  analyze: {
    rubric: "analyze",
    async run(db, item, ctx) {
      // Deliberately NOT `ensureAnalysis`: the cached `jobs.analysis` is the
      // default model's work, and writing this contestant's output back would
      // hand every later step a different input per model.
      const result = await runAnalyze(db, {
        job: {
          title: item.title,
          company: item.company,
          description: item.description,
          location: item.location,
          remote: item.remote,
        },
        jobId: item.jobId ?? undefined,
        userId: ctx.userId,
        modelId: ctx.modelId,
      });
      return {
        output: result.output,
        generationId: result.generationId,
        stepCostUsd: result.costUsd,
        setupCostUsd: 0,
        latencyMs: result.latencyMs,
      };
    },
    // An analysis describes the posting, not the candidate: it carries no
    // fact citations, so there is nothing for the mechanical checker to check.
    check: () => NO_CLAIMS,
    judgePrompt: (item, output) =>
      sections([
        ...jobSections(item),
        { heading: "Analysis to grade (JSON)", body: JSON.stringify(output, null, 2) },
      ]),
  },

  fit: {
    rubric: "fit",
    async run(db, item, ctx) {
      const analysis = await ensureAnalysis(db, item, { userId: ctx.userId });
      const result = await runFit(db, {
        analysis: analysis.analysis,
        facts: item.facts,
        job: {
          title: item.title,
          company: item.company,
          location: item.location,
          remote: item.remote,
        },
        jobId: item.jobId ?? undefined,
        userId: ctx.userId,
        modelId: ctx.modelId,
      });
      return {
        output: result.output,
        generationId: result.generationId,
        stepCostUsd: result.costUsd,
        setupCostUsd: analysis.costUsd,
        latencyMs: result.latencyMs,
      };
    },
    check: (output, labels) => checkFitCitations(output as FitOutput, labels),
    judgePrompt: (item, output) =>
      sections([
        ...jobSections(item),
        {
          heading: "Job analysis",
          body: item.analysis ? renderAnalysis(item.analysis) : null,
        },
        { heading: "Candidate facts", body: renderFacts(item.facts) },
        { heading: "Fit assessment to grade (JSON)", body: JSON.stringify(output, null, 2) },
      ]),
  },

  tailor: {
    rubric: null,
    async run(db, item, ctx) {
      const analysis = await ensureAnalysis(db, item, { userId: ctx.userId });
      const result = await runTailor(db, {
        analysis: analysis.analysis,
        facts: item.facts,
        jobId: item.jobId ?? undefined,
        userId: ctx.userId,
        modelId: ctx.modelId,
      });
      return {
        output: result.output,
        generationId: result.generationId,
        stepCostUsd: result.costUsd,
        setupCostUsd: analysis.costUsd,
        latencyMs: result.latencyMs,
      };
    },
    check: (output, labels) => checkCitations(output as TailorOutput, labels),
    judgePrompt: (item, output) =>
      buildJudgePrompt({
        job: { title: item.title, company: item.company, description: item.description },
        facts: item.facts,
        tailor: output as TailorOutput,
      }),
  },

  suggest: {
    rubric: "suggest",
    async run(db, item, ctx) {
      const analysis = await ensureAnalysis(db, item, { userId: ctx.userId });
      const result = await runSuggest(db, {
        analysis: analysis.analysis,
        facts: item.facts,
        jobId: item.jobId ?? undefined,
        userId: ctx.userId,
        modelId: ctx.modelId,
      });
      return {
        output: result.output,
        generationId: result.generationId,
        stepCostUsd: result.costUsd,
        setupCostUsd: analysis.costUsd,
        latencyMs: result.latencyMs,
      };
    },
    check: (output, labels) => checkCitations(output as SuggestOutput, labels),
    judgePrompt: (item, output) =>
      sections([
        ...jobSections(item),
        {
          heading: "Job analysis",
          body: item.analysis ? renderAnalysis(item.analysis) : null,
        },
        { heading: "Candidate facts", body: renderFacts(item.facts) },
        { heading: "Advice to grade (JSON)", body: JSON.stringify(output, null, 2) },
      ]),
  },
};

/**
 * Grade one output with the rubric that belongs to its step. `tailor` goes
 * through `runJudge()` (the original rubric, unchanged); everything else calls
 * `callStructured` directly with its own registered rubric, because `runStep`
 * resolves exactly one prompt file per step and all of these are `judge`.
 */
async function judgeOutput(
  db: Db,
  step: BenchStep,
  item: GoldenItem,
  output: unknown,
  ctx: EvalItemContext,
): Promise<{ output: JudgeOutput; costUsd: number }> {
  const adapter = ADAPTERS[step];

  if (adapter.rubric === null) {
    const judged = await runJudge(db, {
      job: { title: item.title, company: item.company, description: item.description },
      facts: item.facts,
      tailor: output as TailorOutput,
      jobId: item.jobId ?? undefined,
      userId: ctx.userId,
      modelId: ctx.judgeModelId,
    });
    return { output: judged.output, costUsd: judged.costUsd };
  }

  const rubric = loadJudgeRubric(adapter.rubric);
  const promptVersionId = await ensureRubricVersion(db, adapter.rubric);
  const judged = await callStructured({
    db,
    userId: ctx.userId,
    jobId: item.jobId ?? undefined,
    step: "judge",
    modelId: ctx.judgeModelId,
    schema: JudgeOutput,
    system: rubric.content,
    prompt: adapter.judgePrompt(item, output),
    promptVersionId,
  });
  return { output: judged.output, costUsd: judged.costUsd };
}

function judgeMean(scores: JudgeOutput): number {
  return mean(JUDGE_AXES.map((axis) => scores[axis]));
}

/**
 * The {@link ItemEvaluator} for one benchmarked step. Mirrors the eval
 * runner's own tailor evaluator: never throws, records the failure on the row
 * so one bad posting cannot abort the run.
 */
export function benchEvaluator(step: BenchStep): ItemEvaluator {
  const adapter = ADAPTERS[step];

  return async (db, item, ctx): Promise<EvalResultRow> => {
    const row: EvalResultRow = {
      itemId: item.itemId,
      jobId: item.jobId,
      title: item.title,
      company: item.company,
      generationId: null,
      judgeScores: null,
      meanScore: null,
      humanGrades: item.humanGrades
        ? {
            grounding: item.humanGrades.grounding,
            coverage: item.humanGrades.coverage,
            specificity: item.humanGrades.specificity,
            stuffing_penalty: item.humanGrades.stuffing_penalty,
          }
        : null,
      totalClaims: 0,
      hallucinationCount: 0,
      unsupportedClaims: [],
      costUsd: 0,
      stepCostUsd: 0,
      latencyMs: null,
      error: null,
    };

    try {
      const produced = await adapter.run(db, item, ctx);
      row.generationId = produced.generationId;
      row.stepCostUsd = produced.stepCostUsd;
      row.costUsd += produced.stepCostUsd + produced.setupCostUsd;
      row.latencyMs = produced.latencyMs;

      const hallucination = adapter.check(produced.output, factLabels(item.facts));
      row.totalClaims = hallucination.totalClaims;
      row.hallucinationCount = hallucination.unsupported.length;
      row.unsupportedClaims = hallucination.unsupported;

      const judged = await judgeOutput(db, step, item, produced.output, ctx);
      row.costUsd += judged.costUsd;
      row.judgeScores = judged.output;
      row.meanScore = judgeMean(judged.output);
    } catch (error) {
      row.error = error instanceof Error ? error.message : String(error);
    }

    return row;
  };
}

// ---------------------------------------------------------------------------
// runBench
// ---------------------------------------------------------------------------

/** Extra metrics a bench run adds to `eval_runs.metrics` on top of runEval's. */
export interface BenchMetrics {
  bench: true;
  judge_model_id: string;
  item_step: Step;
  /** Total spend on the model under test alone, across the run. */
  step_cost_usd: number;
  /** `step_cost_usd / n` — the headline $/item on `/benchmark`. */
  cost_per_item_usd: number;
  /** Percentile bootstrap CI of the run's own mean score (not a delta). */
  mean_ci95: { lo: number; hi: number; iterations: number; seed: number };
}

export interface RunBenchArgs {
  steps: readonly BenchStep[];
  models: readonly string[];
  /** Restrict the run to these `eval_items.id`s. */
  itemIds?: string[];
  /** `--items N`: only the first N items of the golden set. */
  limit?: number;
  judgeModelId?: ModelId;
  concurrency?: number;
  gitSha?: string | null;
  seed?: number;
  available?: Partial<Record<Provider, boolean>>;
  onRunStart?: (event: {
    step: BenchStep;
    modelId: ModelId;
    index: number;
    total: number;
  }) => void;
  onItem?: (event: {
    step: BenchStep;
    modelId: ModelId;
    index: number;
    total: number;
    row: EvalResultRow;
  }) => void;
}

/**
 * A run summary plus the benchmark-only metrics that were merged into
 * `eval_runs.metrics`. Structurally still an {@link EvalRunSummary}, which is
 * what the plan's interface promises; the extra field saves every caller a
 * re-read of the row it just wrote.
 */
export interface BenchRunSummary extends EvalRunSummary {
  benchMetrics: BenchMetrics;
}

export interface BenchResult {
  runs: BenchRunSummary[];
  skipped: SkippedModel[];
}

/**
 * A percentile bootstrap CI for a single mean.
 *
 * `bootstrapMeanDiff(scores, zeros)` is exactly that: with two equal-length
 * samples it resamples them as pairs, and every pair is `score − 0`. Reusing
 * it keeps one seeded PRNG in the codebase instead of two.
 */
export function bootstrapMeanCi(
  scores: readonly number[],
  seed: number,
): { lo: number; hi: number; iterations: number; seed: number } | null {
  if (scores.length < 2) return null;
  const boot = bootstrapMeanDiff(scores, scores.map(() => 0), {
    iterations: BOOTSTRAP_ITERATIONS,
    seed,
  });
  return { lo: boot.ci95[0], hi: boot.ci95[1], iterations: boot.iterations, seed };
}

/**
 * Run every requested step × model pair over the golden set.
 *
 * One `eval_runs` row per pair, plus the benchmark-only metrics above. Models
 * whose provider is unavailable never run and come back in `skipped` with the
 * environment variable that would fix it.
 */
export async function runBench(db: Db, args: RunBenchArgs): Promise<BenchResult> {
  const plan = planBench({ models: args.models, available: args.available });
  const judgeModelId = args.judgeModelId ?? JUDGE_MODEL_ID;
  const seed = args.seed ?? DEFAULT_BOOTSTRAP_SEED;
  const runs: BenchRunSummary[] = [];

  const pairs = args.steps.flatMap((step) =>
    plan.models.map((modelId) => ({ step, modelId })),
  );

  for (const [index, { step, modelId }] of pairs.entries()) {
    args.onRunStart?.({ step, modelId, index, total: pairs.length });

    const summary = await runEval(db, {
      step,
      // The golden set lives under `tailor` and is reused (spec §7); the run
      // is still recorded under the step it measured.
      itemStep: GOLDEN_ITEM_STEP,
      modelId,
      judgeModelId,
      evaluator: benchEvaluator(step),
      itemIds: args.itemIds,
      limit: args.limit,
      concurrency: args.concurrency,
      gitSha: args.gitSha,
      seed,
      // Owner CLI: the budget is bypassed and no `usage_daily` row is written.
      userId: null,
      onProgress: ({ index: i, total, row }) =>
        args.onItem?.({ step, modelId, index: i, total, row }),
    });

    const stepCostUsd = summary.results.reduce(
      (sum, row) => sum + (row.stepCostUsd ?? 0),
      0,
    );
    const scored = summary.results.filter((row) => row.meanScore != null && !row.error);
    const extra: BenchMetrics = {
      bench: true,
      judge_model_id: judgeModelId,
      item_step: GOLDEN_ITEM_STEP,
      step_cost_usd: stepCostUsd,
      cost_per_item_usd: scored.length ? stepCostUsd / scored.length : 0,
      mean_ci95: bootstrapMeanCi(
        scored.map((row) => row.meanScore as number),
        seed,
      ) ?? { lo: summary.meanScore, hi: summary.meanScore, iterations: 0, seed },
    };

    await mergeRunMetrics(db, summary.runId, extra);
    runs.push({ ...summary, benchMetrics: extra });
  }

  return { runs, skipped: plan.skipped };
}

/** Add the bench-only keys to a run's metrics without dropping runEval's. */
async function mergeRunMetrics(
  db: Db,
  runId: string,
  extra: BenchMetrics,
): Promise<void> {
  const [row] = await db
    .select({ metrics: evalRuns.metrics })
    .from(evalRuns)
    .where(eq(evalRuns.id, runId))
    .limit(1);

  const merged = { ...((row?.metrics ?? {}) as Record<string, unknown>), ...extra };
  await db
    .update(evalRuns)
    .set({
      // `eval_runs.metrics` is declared with the eval harness's exact key set
      // (src/db/schema.ts, owned by Task 2). jsonb stores whatever it is given;
      // the benchmark's extra keys are additive and every reader treats a
      // missing key as null, so this is the honest narrow spot.
      metrics: merged as unknown as typeof evalRuns.$inferInsert.metrics,
    })
    .where(eq(evalRuns.id, runId));
}

// ---------------------------------------------------------------------------
// The public scoreboard
// ---------------------------------------------------------------------------

/**
 * How long `/benchmark` and `/api/public/benchmark` cache the scoreboard.
 * Spec §8 / plan Step 3: "Cached 1h". A benchmark run happens a few times a
 * year, so an hour-stale public page costs nothing and a per-request query
 * against `eval_runs` from an uncached public route is a free DoS lever.
 */
export const BENCHMARK_CACHE_SECONDS = 3600;

/** Shared `unstable_cache` key/tag so the page and the API agree. */
export const BENCHMARK_CACHE_TAG = "public-benchmark-board";

/** One model's result for one step, as `/benchmark` renders it. */
export interface BenchmarkRow {
  runId: string;
  step: Step;
  modelId: string;
  provider: string;
  /** Items that produced a graded result. */
  n: number;
  meanScore: number | null;
  /** 95% bootstrap CI of the mean, when the run recorded one. */
  meanCi: [number, number] | null;
  hallucinationRate: number | null;
  /** Cost of the step under test per scored item. */
  costPerItemUsd: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  /** ISO date the run was recorded. */
  createdAt: string;
  /** Prompt version the run used, from `prompt_versions`. */
  promptVersion: string | null;
  judgeModelId: string | null;
  /** Is this the model `src/llm/defaults.ts` currently ships for this step? */
  isDefault: boolean;
}

export interface BenchmarkBoard {
  steps: { step: Step; rows: BenchmarkRow[] }[];
  /** ISO timestamp of the newest run shown, or null when there is none. */
  lastUpdated: string | null;
  judgeModelId: string;
  judgeProvider: string;
  /** Rubric + step prompt versions, for the methodology section. */
  promptVersions: { name: string; version: string; sha256: string }[];
  goldenItemStep: Step;
}

interface BoardRunRow {
  id: string;
  step: Step;
  modelId: string;
  itemCount: number | null;
  createdAt: Date;
  promptVersion: string | null;
  metrics: Record<string, unknown> | null;
}

/**
 * Keep only the newest run per (step, model). Pure, so the "latest wins" rule
 * has its own test — it is the whole reason a re-benchmark replaces a number
 * on the public page instead of adding a second row for the same model.
 *
 * @param rows newest first.
 */
export function latestPerStepModel(rows: readonly BoardRunRow[]): BoardRunRow[] {
  const seen = new Set<string>();
  const out: BoardRunRow[] = [];
  for (const row of rows) {
    const key = `${row.step}::${row.modelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function toBenchmarkRow(row: BoardRunRow): BenchmarkRow {
  const metrics = (row.metrics ?? {}) as Record<string, unknown>;
  const ci = metrics.mean_ci95 as
    | { lo?: unknown; hi?: unknown; iterations?: unknown }
    | undefined;
  // A run of fewer than two scored items records a degenerate interval
  // (`iterations: 0`, lo = hi = the mean). Printing "5.00–5.00" as a 95%
  // interval would claim a precision the run does not have, so it is dropped.
  const hasInterval = (num(ci?.iterations) ?? 0) > 0;
  const lo = hasInterval ? num(ci?.lo) : null;
  const hi = hasInterval ? num(ci?.hi) : null;
  const n = row.itemCount ?? 0;
  const stepCost = num(metrics.step_cost_usd);
  const perItem =
    num(metrics.cost_per_item_usd) ??
    (stepCost != null && n > 0 ? stepCost / n : null);

  let provider = "unknown";
  try {
    provider = parseModelId(row.modelId).provider;
  } catch {
    // A run recorded with a malformed model id still gets shown; the page just
    // cannot group it by provider.
  }

  return {
    runId: row.id,
    step: row.step,
    modelId: row.modelId,
    provider,
    n,
    meanScore: num(metrics.mean_score),
    meanCi: lo != null && hi != null ? [lo, hi] : null,
    hallucinationRate: num(metrics.hallucination_rate),
    costPerItemUsd: perItem,
    p50Ms: num(metrics.p50_ms),
    p95Ms: num(metrics.p95_ms),
    createdAt: row.createdAt.toISOString(),
    promptVersion: row.promptVersion,
    judgeModelId: typeof metrics.judge_model_id === "string" ? metrics.judge_model_id : null,
    isDefault:
      (DEFAULT_MODEL_BY_STEP as Record<string, string>)[row.step] === row.modelId,
  };
}

/**
 * Is this `eval_runs` row a finished benchmark run, i.e. something the public
 * scoreboard can put in a column next to another model?
 *
 * Three rows are rejected, all for the same reason — a scoreboard cell that
 * cannot be compared with the cell beside it is worse than no cell:
 *
 *   - **Not a bench run.** `eval_runs` also holds the CI gate's own runs and
 *     the owner's ad-hoc evals. Those measure one model against a baseline on
 *     whatever subset CI felt like; they carry no per-item cost and no
 *     interval, and they are frequent enough that a nightly gate run would
 *     silently replace a carefully-run benchmark with a dashes-only row.
 *   - **Still running.** `runEval` inserts its row *before* the first item, so
 *     an in-flight run is visible in the table with `item_count` set and no
 *     metrics at all. The `bench` key is written last, which is exactly the
 *     "this run finished" marker this needs.
 *   - **Scored nothing.** Every item errored — what a model with no credit
 *     balance or an expired key looks like. Real, kept in `eval_runs` for the
 *     owner's `/evals` page, but a row of dashes reads as a result rather than
 *     as an outage.
 */
export function isBenchmarkRun(row: BoardRunRow): boolean {
  const metrics = row.metrics ?? {};
  return (
    metrics.bench === true &&
    (row.itemCount ?? 0) > 0 &&
    typeof metrics.mean_score === "number"
  );
}

/**
 * Everything `/benchmark` shows: the newest finished benchmark run per
 * step × model, best score first. See {@link isBenchmarkRun} for what is left
 * out and why.
 */
export async function loadBenchmarkBoard(
  db: Db,
  { limit = 200 }: { limit?: number } = {},
): Promise<BenchmarkBoard> {
  const rows = await db
    .select({
      id: evalRuns.id,
      step: evalRuns.step,
      modelId: evalRuns.modelId,
      itemCount: evalRuns.itemCount,
      createdAt: evalRuns.createdAt,
      metrics: evalRuns.metrics,
      promptVersion: promptVersions.version,
    })
    .from(evalRuns)
    .leftJoin(promptVersions, eq(promptVersions.id, evalRuns.promptVersionId))
    // Filter in SQL as well as in `isBenchmarkRun`: `eval_runs` also collects
    // a row per CI gate run, so without this the `limit` would eventually be
    // spent entirely on gate runs and the benchmark rows would fall off the
    // end of the page.
    .where(sql`${evalRuns.metrics}->>'bench' = 'true'`)
    .orderBy(desc(evalRuns.createdAt))
    .limit(limit);

  const benchRuns = rows
    .map((row) => ({
      ...row,
      metrics: (row.metrics ?? null) as Record<string, unknown> | null,
    }))
    .filter(isBenchmarkRun);

  const latest = latestPerStepModel(benchRuns).map(toBenchmarkRow);

  const steps = BENCH_STEPS.map((step) => ({
    step: step as Step,
    rows: latest
      .filter((row) => row.step === step)
      .sort(
        (a, b) =>
          (b.meanScore ?? -1) - (a.meanScore ?? -1) ||
          (a.costPerItemUsd ?? Infinity) - (b.costPerItemUsd ?? Infinity) ||
          a.modelId.localeCompare(b.modelId),
      ),
  })).filter((group) => group.rows.length > 0);

  const lastUpdated = latest.reduce<string | null>(
    (newest, row) => (newest === null || row.createdAt > newest ? row.createdAt : newest),
    null,
  );

  const promptVersionList = [
    ...BENCH_STEPS.map((step) => {
      const prompt = loadPrompt(step as Step);
      return { name: `${step}.v1.md`, version: prompt.version, sha256: prompt.sha256 };
    }),
    { name: "judge.v1.md", version: loadPrompt("judge").version, sha256: loadPrompt("judge").sha256 },
    ...BENCH_STEPS.filter((step) => ADAPTERS[step].rubric !== null).map((step) => {
      const rubric = loadJudgeRubric(step);
      return { name: `judge_${step}.v1.md`, version: rubric.version, sha256: rubric.sha256 };
    }),
  ];

  let judgeProvider = "unknown";
  try {
    judgeProvider = parseModelId(JUDGE_MODEL_ID).provider;
  } catch {
    // Unreachable for a literal from defaults.ts; keeps the page total.
  }

  return {
    steps,
    lastUpdated,
    judgeModelId: JUDGE_MODEL_ID,
    judgeProvider,
    promptVersions: promptVersionList,
    goldenItemStep: GOLDEN_ITEM_STEP,
  };
}

// ---------------------------------------------------------------------------
// Console rendering (the CLI's table)
// ---------------------------------------------------------------------------

function pad(value: string, width: number, align: "l" | "r" = "l"): string {
  return align === "l" ? value.padEnd(width) : value.padStart(width);
}

/** The `bench` command's summary table — one line per step × model. */
export function renderBenchTable(runs: readonly BenchRunSummary[]): string {
  const header = ["step", "model", "n", "fail", "mean", "ci95", "halluc", "$/item", "p50ms", "p95ms"];
  const body = runs.map((run) => {
    const perItem = run.benchMetrics.cost_per_item_usd;
    const ci = run.benchMetrics.mean_ci95;
    return [
      run.step,
      run.modelId,
      String(run.n),
      String(run.failedItems),
      run.n ? run.meanScore.toFixed(2) : "—",
      ci.iterations > 0 ? `${ci.lo.toFixed(2)}–${ci.hi.toFixed(2)}` : "—",
      run.n ? `${(run.hallucinationRate * 100).toFixed(1)}%` : "—",
      run.n ? `$${perItem.toFixed(5)}` : "—",
      run.n ? String(Math.round(run.p50Ms)) : "—",
      run.n ? String(Math.round(run.p95Ms)) : "—",
    ];
  });

  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((cells) => cells[i].length)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, i) => pad(cell, widths[i], i <= 1 ? "l" : "r")).join("  ");

  return [
    line(header),
    widths.map((w) => "-".repeat(w)).join("  "),
    ...body.map(line),
  ].join("\n");
}

/** One step's winner, as `defaults.ts` should record it. */
export interface BenchWinner {
  step: Step;
  modelId: string;
  runId: string;
  meanScore: number;
  costPerItemUsd: number;
  /** Best mean score seen for this step, whoever scored it. */
  bestMeanScore: number;
  /** How many models were statistically indistinguishable from the best. */
  contenders: number;
}

/**
 * Winner per step: **the cheapest model that is not measurably worse than the
 * best one** (spec §8: "best quality-per-dollar winner"). This is what
 * `src/llm/defaults.ts` is then set to.
 *
 * A plain score ÷ price ratio is the obvious reading and the wrong one: with
 * a 10× price spread between two models whose means differ by 0.1 on a 1–5
 * scale, the ratio always names the cheap model, even when it is genuinely
 * and visibly worse. So quality comes first and price breaks the tie:
 *
 *   1. find the best mean score for the step;
 *   2. keep every model whose own mean sits at or above the *lower bound* of
 *      the best model's 95% bootstrap interval — i.e. every model this
 *      benchmark cannot distinguish from the best;
 *   3. among those, take the cheapest per item.
 *
 * Runs that scored nothing are excluded: a model that failed every item has no
 * quality to trade against its price.
 */
export function bestByValue(runs: readonly BenchRunSummary[]): BenchWinner[] {
  const byStep = new Map<Step, BenchRunSummary[]>();
  for (const run of runs) {
    if (run.n === 0) continue;
    const bucket = byStep.get(run.step);
    if (bucket) bucket.push(run);
    else byStep.set(run.step, [run]);
  }

  return [...byStep.entries()]
    .map(([step, stepRuns]) => {
      const best = [...stepRuns].sort((a, b) => b.meanScore - a.meanScore)[0];
      // No interval (a single-item run) means no evidence that anything else
      // is as good, so only the best model itself qualifies.
      const floor =
        best.benchMetrics.mean_ci95.iterations > 0
          ? best.benchMetrics.mean_ci95.lo
          : best.meanScore;

      // `run === best` keeps the best model in its own contender list even if
      // a malformed interval were to exclude it — an empty list here would
      // mean no winner at all for the step.
      const contenders = stepRuns.filter((run) => run === best || run.meanScore >= floor);
      const winner = [...contenders].sort(
        (a, b) =>
          a.benchMetrics.cost_per_item_usd - b.benchMetrics.cost_per_item_usd ||
          b.meanScore - a.meanScore,
      )[0];

      return {
        step,
        modelId: winner.modelId,
        runId: winner.runId,
        meanScore: winner.meanScore,
        costPerItemUsd: winner.benchMetrics.cost_per_item_usd,
        bestMeanScore: best.meanScore,
        contenders: contenders.length,
      };
    })
    .sort((a, b) => a.step.localeCompare(b.step));
}
