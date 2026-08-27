/**
 * The eval run (spec §7): re-run one pipeline step over the frozen golden set,
 * grade every output, and reduce the whole thing to the handful of numbers a
 * CI gate and a human can both act on.
 *
 * Per item: `runTailor` against the item's frozen `profile_snapshot` →
 * mechanical `checkCitations` → `runJudge` on a fixed judge model → one
 * `eval_results` row. Then the run's metrics land in `eval_runs`, including a
 * bootstrap CI on the mean-score delta against the current baseline run.
 *
 * Three deliberate choices worth knowing about:
 *
 *   - **The judge never moves.** An eval varies the step model; a grader that
 *     changed at the same time would measure nothing (`JUDGE_MODEL_ID`).
 *   - **Analysis is cached, not re-run per model.** `tailor` needs an `analyze`
 *     output; analyzing with the model under test would confound the two
 *     steps, so analysis always uses the default model and is cached on the
 *     job row. Its cost is still counted in the run total.
 *   - **A failed item is reported, not swallowed.** Items whose model calls
 *     throw are counted in `failedItems` and excluded from the means, so a run
 *     that only scored 3 of 40 items cannot masquerade as a good one.
 */

import { and, desc, eq, ne } from "drizzle-orm";
import type { Db } from "../db/client";
import { evalItems, evalResults, evalRuns, type Step } from "../db/schema";
import { JUDGE_MODEL_ID, defaultModelForStep } from "../llm/defaults";
import type { ModelId } from "../llm/model-id";
import { checkCitations, type UnsupportedClaim } from "../pipeline/hallucination";
import { ensurePromptVersion } from "../pipeline/prompt-versions";
import { JUDGE_AXES, type JudgeOutput, type TailorOutput } from "../pipeline/schemas";
import { factLabels, runJudge, runTailor } from "../pipeline/steps";
import { ensureAnalysis, loadGoldenItems, type GoldenItem } from "./golden";
import { bootstrapMeanDiff, mean, percentile, weightedKappa } from "./stats";

/** Spec §7 fixes the bootstrap at 1000 resamples; the seed keeps it repeatable. */
export const BOOTSTRAP_ITERATIONS = 1000;
export const DEFAULT_BOOTSTRAP_SEED = 20260827;

/**
 * Kappa on four items is noise dressed up as a statistic. Below this many
 * human-graded items the run reports `kappa: null` and the UI says "pending
 * grades" rather than printing a number nobody should act on.
 */
export const MIN_GRADED_ITEMS_FOR_KAPPA = 5;

/** One row of the per-item table, and of `eval_results`. */
export interface EvalResultRow {
  itemId: string;
  jobId: string | null;
  title: string;
  company: string;
  generationId: string | null;
  judgeScores: JudgeOutput | null;
  /** Mean of the four judge axes for this item. */
  meanScore: number | null;
  humanGrades: { grounding: number; coverage: number; specificity: number; stuffing_penalty: number } | null;
  totalClaims: number;
  hallucinationCount: number;
  unsupportedClaims: UnsupportedClaim[];
  /** Every model call attributable to this item (analyze + tailor + judge). */
  costUsd: number;
  /** Latency of the step under test only — what p50/p95 report. */
  latencyMs: number | null;
  error: string | null;
}

export interface EvalRunSummary {
  runId: string;
  step: Step;
  modelId: ModelId;
  /** Items that produced a graded result (failures excluded). */
  n: number;
  meanScore: number;
  /** Pooled: unsupported claims ÷ all citable claims across the run. */
  hallucinationRate: number;
  kappa: number | null;
  costUsd: number;
  p50Ms: number;
  p95Ms: number;
  vsBaseline?: { diff: number; ci95: [number, number]; baselineRunId: string };
  // --- context the pinned interface doesn't carry, but a report needs ---
  judgeModelId: ModelId;
  baseline: boolean;
  gitSha: string | null;
  promptVersionId: string | null;
  itemsAttempted: number;
  failedItems: number;
  gradedItems: number;
  createdAt: string;
  /**
   * Per-item rows, attached so a caller can hand them straight to
   * {@link import("./report").writeReports} without a second query. Not part
   * of what is persisted in `eval_runs.metrics`.
   */
  results: EvalResultRow[];
}

export interface RunEvalArgs {
  step: Step;
  /** The model under test. Defaults to the step's default model. */
  modelId?: ModelId;
  /** Restrict the run to these `eval_items.id`s. */
  itemIds?: string[];
  /** Grader model. Fixed by default and should stay that way (spec §7). */
  judgeModelId?: ModelId;
  /** Mark this run as the baseline future runs are compared against. */
  baseline?: boolean;
  gitSha?: string | null;
  /** `--items N`: run only the first N items of the set. */
  limit?: number;
  /** Whose budget pays. `null` (the default) = owner CLI, budget bypassed. */
  userId?: string | null;
  /** Items evaluated in parallel. Small by default — providers rate-limit. */
  concurrency?: number;
  seed?: number;
  onProgress?: (event: {
    index: number;
    total: number;
    item: GoldenItem;
    row: EvalResultRow;
  }) => void;
}

function judgeMean(scores: JudgeOutput): number {
  return mean(JUDGE_AXES.map((axis) => scores[axis]));
}

/** Run `worker` over `items` with at most `limit` in flight, preserving order. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length));

  await Promise.all(
    Array.from({ length: size }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    }),
  );

  return results;
}

/**
 * Score one item end to end. Never throws: a provider error becomes a row with
 * `error` set, so one bad posting cannot abort a 40-item run.
 */
async function evaluateItem(
  db: Db,
  item: GoldenItem,
  args: { modelId: ModelId; judgeModelId: ModelId; userId: string | null },
): Promise<EvalResultRow> {
  const base: EvalResultRow = {
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
    latencyMs: null,
    error: null,
  };

  try {
    // Analysis is an input to `tailor`, not part of what is being measured:
    // always the default model, cached on the job row after the first run.
    const analysis = await ensureAnalysis(db, item, { userId: args.userId });
    base.costUsd += analysis.costUsd;

    const tailored = await runTailor(db, {
      analysis: analysis.analysis,
      facts: item.facts,
      jobId: item.jobId ?? undefined,
      userId: args.userId,
      modelId: args.modelId,
    });
    base.generationId = tailored.generationId;
    base.costUsd += tailored.costUsd;
    base.latencyMs = tailored.latencyMs;

    // The mechanical check runs against the item's *frozen* labels, not the
    // user's current profile — the whole point of the snapshot.
    const hallucination = checkCitations(
      tailored.output as TailorOutput,
      factLabels(item.facts),
    );
    base.totalClaims = hallucination.totalClaims;
    base.hallucinationCount = hallucination.unsupported.length;
    base.unsupportedClaims = hallucination.unsupported;

    const judged = await runJudge(db, {
      job: { title: item.title, company: item.company, description: item.description },
      facts: item.facts,
      tailor: tailored.output as TailorOutput,
      jobId: item.jobId ?? undefined,
      userId: args.userId,
      modelId: args.judgeModelId,
    });
    base.costUsd += judged.costUsd;
    base.judgeScores = judged.output;
    base.meanScore = judgeMean(judged.output);
  } catch (error) {
    base.error = error instanceof Error ? error.message : String(error);
  }

  return base;
}

/** The most recent `baseline = true` run for this step, if there is one. */
async function findBaselineRun(
  db: Db,
  step: Step,
  excludeRunId: string,
): Promise<{ id: string; scores: Map<string, number> } | null> {
  const [run] = await db
    .select({ id: evalRuns.id })
    .from(evalRuns)
    .where(and(eq(evalRuns.step, step), eq(evalRuns.baseline, true), ne(evalRuns.id, excludeRunId)))
    .orderBy(desc(evalRuns.createdAt))
    .limit(1);
  if (!run) return null;

  const rows = await db
    .select({ itemId: evalResults.itemId, judgeScores: evalResults.judgeScores })
    .from(evalResults)
    .where(eq(evalResults.runId, run.id));

  const scores = new Map<string, number>();
  for (const row of rows) {
    if (!row.itemId || !row.judgeScores) continue;
    scores.set(row.itemId, judgeMean(row.judgeScores as JudgeOutput));
  }
  return { id: run.id, scores };
}

/**
 * Judge-vs-human agreement: weighted kappa per axis over the items that carry
 * human grades, averaged across the four axes. `null` below
 * {@link MIN_GRADED_ITEMS_FOR_KAPPA} graded items.
 */
export function computeKappa(rows: readonly EvalResultRow[]): number | null {
  const paired = rows.filter((row) => row.judgeScores && row.humanGrades);
  if (paired.length < MIN_GRADED_ITEMS_FOR_KAPPA) return null;

  const perAxis = JUDGE_AXES.map((axis) =>
    weightedKappa(
      paired.map((row) => row.judgeScores![axis]),
      paired.map((row) => row.humanGrades![axis]),
      { min: 1, max: 5, weights: "quadratic" },
    ),
  );
  return mean(perAxis);
}

/** Reduce per-item rows to the run's headline numbers. */
export function summarizeRows(rows: readonly EvalResultRow[]): {
  n: number;
  meanScore: number;
  hallucinationRate: number;
  kappa: number | null;
  costUsd: number;
  p50Ms: number;
  p95Ms: number;
  failedItems: number;
  gradedItems: number;
} {
  const scored = rows.filter((row) => row.meanScore != null && !row.error);
  // An item whose step call reported no latency is absent from the sample, not
  // a 0 ms item: coercing it would drag p50/p95 down and quietly flatter the run.
  const latencies = scored
    .map((row) => row.latencyMs)
    .filter((value): value is number => value != null);
  const totalClaims = scored.reduce((sum, row) => sum + row.totalClaims, 0);
  const unsupported = scored.reduce((sum, row) => sum + row.hallucinationCount, 0);

  return {
    n: scored.length,
    meanScore: scored.length ? mean(scored.map((row) => row.meanScore as number)) : 0,
    hallucinationRate: totalClaims === 0 ? 0 : unsupported / totalClaims,
    kappa: computeKappa(scored),
    costUsd: rows.reduce((sum, row) => sum + row.costUsd, 0),
    p50Ms: latencies.length ? percentile(latencies, 0.5) : 0,
    p95Ms: latencies.length ? percentile(latencies, 0.95) : 0,
    failedItems: rows.length - scored.length,
    gradedItems: scored.filter((row) => row.humanGrades).length,
  };
}

export async function runEval(db: Db, args: RunEvalArgs): Promise<EvalRunSummary> {
  const step = args.step;
  const modelId = args.modelId ?? defaultModelForStep(step);
  const judgeModelId = args.judgeModelId ?? JUDGE_MODEL_ID;
  const userId = args.userId ?? null;

  const items = await loadGoldenItems(db, {
    step,
    itemIds: args.itemIds,
    limit: args.limit,
  });
  if (items.length === 0) {
    throw new Error(
      `No eval_items for step "${step}". Run \`npm run cli -- golden select --n 40\` first.`,
    );
  }

  const promptVersionId = await ensurePromptVersion(db, step);

  // The run row goes in first: `eval_results.run_id` is a foreign key, and a
  // run that crashes half way should still leave its rows behind for triage.
  const [run] = await db
    .insert(evalRuns)
    .values({
      step,
      modelId,
      promptVersionId,
      gitSha: args.gitSha ?? null,
      itemCount: items.length,
      baseline: args.baseline ?? false,
    })
    .returning({ id: evalRuns.id, createdAt: evalRuns.createdAt });

  const rows = await mapWithConcurrency(
    items,
    args.concurrency ?? 3,
    async (item, index) => {
      const row = await evaluateItem(db, item, { modelId, judgeModelId, userId });
      args.onProgress?.({ index, total: items.length, item, row });
      return row;
    },
  );

  if (rows.length > 0) {
    await db.insert(evalResults).values(
      rows.map((row) => ({
        runId: run.id,
        itemId: row.itemId,
        generationId: row.generationId,
        judgeScores: row.judgeScores
          ? {
              grounding: row.judgeScores.grounding,
              coverage: row.judgeScores.coverage,
              specificity: row.judgeScores.specificity,
              stuffing_penalty: row.judgeScores.stuffing_penalty,
            }
          : null,
        hallucinationCount: row.hallucinationCount,
        unsupportedClaims: row.error
          ? { error: row.error }
          : { totalClaims: row.totalClaims, unsupported: row.unsupportedClaims },
        costUsd: row.costUsd.toFixed(6),
        latencyMs: row.latencyMs,
      })),
    );
  }

  const stats = summarizeRows(rows);

  // Compare against the current baseline on the items the two runs share, so
  // a shorter `--items 20` gate run still compares like with like.
  let vsBaseline: EvalRunSummary["vsBaseline"];
  let pairedItems = 0;
  const baselineRun = await findBaselineRun(db, step, run.id);
  if (baselineRun) {
    const current: number[] = [];
    const previous: number[] = [];
    for (const row of rows) {
      const before = baselineRun.scores.get(row.itemId);
      if (before == null || row.meanScore == null || row.error) continue;
      current.push(row.meanScore);
      previous.push(before);
    }
    pairedItems = current.length;
    if (current.length >= 2) {
      const boot = bootstrapMeanDiff(current, previous, {
        iterations: BOOTSTRAP_ITERATIONS,
        seed: args.seed ?? DEFAULT_BOOTSTRAP_SEED,
      });
      vsBaseline = { diff: boot.diff, ci95: boot.ci95, baselineRunId: baselineRun.id };
    }
  }

  const metrics = {
    mean_score: stats.meanScore,
    hallucination_rate: stats.hallucinationRate,
    // `kappa` is null until the owner has graded MIN_GRADED_ITEMS_FOR_KAPPA
    // items. The column's declared type (src/db/schema.ts, owned by Task 2)
    // says `number`; jsonb happily stores null, and every reader here treats
    // it as `number | null`, so the cast is the honest narrow spot.
    kappa: stats.kappa,
    cost_usd: stats.costUsd,
    p50_ms: stats.p50Ms,
    p95_ms: stats.p95Ms,
    // `item_count` is overwritten below with the *scored* count, so the two
    // numbers that say how much of the set actually ran live here — otherwise a
    // 40-item run where 37 items errored reads exactly like a clean 3-item one.
    items_attempted: stats.n + stats.failedItems,
    failed_items: stats.failedItems,
    ci95: vsBaseline
      ? {
          diff: vsBaseline.diff,
          lo: vsBaseline.ci95[0],
          hi: vsBaseline.ci95[1],
          baseline_run_id: vsBaseline.baselineRunId,
          iterations: BOOTSTRAP_ITERATIONS,
          seed: args.seed ?? DEFAULT_BOOTSTRAP_SEED,
          paired_items: pairedItems,
        }
      : {},
  } as unknown as typeof evalRuns.$inferInsert.metrics;

  await db
    .update(evalRuns)
    .set({ metrics, itemCount: stats.n })
    .where(eq(evalRuns.id, run.id));

  return {
    runId: run.id,
    step,
    modelId,
    n: stats.n,
    meanScore: stats.meanScore,
    hallucinationRate: stats.hallucinationRate,
    kappa: stats.kappa,
    costUsd: stats.costUsd,
    p50Ms: stats.p50Ms,
    p95Ms: stats.p95Ms,
    vsBaseline,
    judgeModelId,
    baseline: args.baseline ?? false,
    gitSha: args.gitSha ?? null,
    promptVersionId,
    itemsAttempted: rows.length,
    failedItems: stats.failedItems,
    gradedItems: stats.gradedItems,
    createdAt: run.createdAt.toISOString(),
    results: rows,
  };
}

/** Re-read a persisted run for the `/evals` page and the report writer. */
export async function loadRunResults(db: Db, runId: string) {
  return db
    .select({
      itemId: evalResults.itemId,
      generationId: evalResults.generationId,
      judgeScores: evalResults.judgeScores,
      hallucinationCount: evalResults.hallucinationCount,
      costUsd: evalResults.costUsd,
      latencyMs: evalResults.latencyMs,
      humanGrades: evalItems.humanGrades,
    })
    .from(evalResults)
    .leftJoin(evalItems, eq(evalItems.id, evalResults.itemId))
    .where(eq(evalResults.runId, runId));
}

export interface EvalRunListItem {
  id: string;
  step: Step;
  modelId: string;
  baseline: boolean;
  gitSha: string | null;
  createdAt: Date;
  itemCount: number | null;
  itemsAttempted: number | null;
  failedItems: number | null;
  meanScore: number | null;
  hallucinationRate: number | null;
  kappa: number | null;
  costUsd: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  vsBaseline: { diff: number; ci95: [number, number]; baselineRunId: string } | null;
}

/**
 * The `/evals` runs table. Metrics are read back out of the `eval_runs.metrics`
 * jsonb rather than recomputed — a historical run's numbers must not change
 * because the code that computes them did.
 */
export async function listEvalRuns(db: Db, limit = 50): Promise<EvalRunListItem[]> {
  const rows = await db
    .select({
      id: evalRuns.id,
      step: evalRuns.step,
      modelId: evalRuns.modelId,
      baseline: evalRuns.baseline,
      gitSha: evalRuns.gitSha,
      createdAt: evalRuns.createdAt,
      itemCount: evalRuns.itemCount,
      metrics: evalRuns.metrics,
    })
    .from(evalRuns)
    .orderBy(desc(evalRuns.createdAt))
    .limit(limit);

  return rows.map((row) => {
    // `metrics` is written by runEval above; older/partial rows may be missing
    // keys, so every read is defensive.
    const metrics = (row.metrics ?? {}) as Partial<{
      mean_score: number;
      hallucination_rate: number;
      kappa: number | null;
      cost_usd: number;
      p50_ms: number;
      p95_ms: number;
      items_attempted: number;
      failed_items: number;
      ci95: { diff?: number; lo?: number; hi?: number; baseline_run_id?: string };
    }>;
    const ci = metrics.ci95;

    return {
      id: row.id,
      step: row.step,
      modelId: row.modelId,
      baseline: row.baseline,
      gitSha: row.gitSha,
      createdAt: row.createdAt,
      itemCount: row.itemCount,
      itemsAttempted: metrics.items_attempted ?? null,
      failedItems: metrics.failed_items ?? null,
      meanScore: metrics.mean_score ?? null,
      hallucinationRate: metrics.hallucination_rate ?? null,
      kappa: metrics.kappa ?? null,
      costUsd: metrics.cost_usd ?? null,
      p50Ms: metrics.p50_ms ?? null,
      p95Ms: metrics.p95_ms ?? null,
      vsBaseline:
        ci && ci.diff != null && ci.lo != null && ci.hi != null
          ? {
              diff: ci.diff,
              ci95: [ci.lo, ci.hi],
              baselineRunId: ci.baseline_run_id ?? "",
            }
          : null,
    };
  });
}
