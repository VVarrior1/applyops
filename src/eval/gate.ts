/**
 * The CI quality gate (spec §7).
 *
 * A pull request that touches `src/pipeline/**`, `src/eval/**` or `src/llm/**`
 * re-runs a 20-item subset of the golden set and hands the resulting
 * {@link EvalRunSummary} to {@link evaluateGate}. If the gate fails, the check
 * fails and the branch does not merge. This is the "it refuses to get worse"
 * property of the whole system, so the rules here are deliberately few, cheap
 * to explain, and hard to argue with:
 *
 *   1. **Hallucination ceiling.** More than 2% of citable claims unsupported
 *      by a confirmed profile fact fails. This is the one number the product
 *      promise rests on, so it is an absolute bar, not a comparison.
 *   2. **No statistically-real regression.** The run's mean judge score is
 *      compared against the current baseline run on the items the two share,
 *      via a 1000-resample bootstrap. The gate fails only when the whole 95%
 *      CI of (mean − baseline) sits below zero — an interval that straddles
 *      zero is noise, and failing on noise would train everyone to re-run the
 *      job until it goes green, which is worse than having no gate.
 *   3. **The run actually ran.** `item_count` on an `eval_runs` row is the
 *      *scored* count, so a 40-item run where 37 items threw looks exactly
 *      like a clean 3-item run from the outside. `failedItems` is what tells
 *      those apart: a green check that only means "the three items that worked
 *      were fine" is a lie. The tolerance is a *fraction* (10%), not zero,
 *      because provider capacity errors are real — the first live gate run of
 *      this workflow lost exactly one of twenty items to "This model is
 *      currently experiencing high demand". A gate that goes red on one
 *      transient 503 gets switched off within a month, which costs more than
 *      the 19-item comparison it was protecting.
 *
 * Thresholds live in {@link DEFAULT_GATE_THRESHOLDS} and can be overridden per
 * call; the workflow uses the defaults.
 *
 * Every check reports itself in {@link GateResult.checks} — including the ones
 * that passed or were skipped — because the job summary a human reads after a
 * red build needs to show what *was* verified, not only what broke.
 */

import type { EvalRunSummary } from "./runner";

/**
 * What the gate needs from a run.
 *
 * Structural rather than `EvalRunSummary` itself so the gate can read either
 * an in-memory summary (the CLI's `--gate` path) or the `summary` object
 * parsed out of `eval-report.json` (which is an `EvalRunSummary` minus its
 * per-item `results`). Both satisfy this shape.
 */
export interface GateInput {
  /** Pooled unsupported-claims ÷ citable-claims for the run, 0–1. */
  hallucinationRate: number;
  /** Items that produced a graded result. */
  n: number;
  /** Items whose model calls threw. `null`/absent on runs recorded before this was tracked. */
  failedItems?: number | null;
  /** Scored + failed. `null`/absent on older runs. */
  itemsAttempted?: number | null;
  /** Bootstrap comparison against the current baseline run, when one exists. */
  vsBaseline?: { diff: number; ci95: [number, number]; baselineRunId: string };
  costUsd?: number;
  meanScore?: number;
  step?: string;
  modelId?: string;
  runId?: string;
  gitSha?: string | null;
  kappa?: number | null;
}

export interface GateThresholds {
  /** Fail above this fraction of unsupported claims. Spec §7: 0.02. */
  maxHallucinationRate: number;
  /**
   * Fail above this fraction of attempted items whose model calls threw.
   * A fraction rather than a count so the same rule works for a 3-item smoke
   * run and a 40-item baseline.
   */
  maxFailedItemRate: number;
  /** Fail below this many scored items — a run that graded nothing proves nothing. */
  minScoredItems: number;
}

export const DEFAULT_GATE_THRESHOLDS: GateThresholds = {
  maxHallucinationRate: 0.02,
  maxFailedItemRate: 0.1,
  minScoredItems: 1,
};

export interface GateCheck {
  /** Stable id (`hallucination`, `regression`, `failed_items`, `coverage`). */
  name: string;
  /** `skipped` = the run carried no evidence either way; never a failure. */
  status: "pass" | "fail" | "skipped";
  /** One line, human-readable, safe to paste into a job summary. */
  detail: string;
}

export interface GateResult {
  pass: boolean;
  /** One sentence per failed check, in check order. Empty when `pass`. */
  reasons: string[];
  /** Every check, including passes and skips — for the job summary. */
  checks: GateCheck[];
}

const pct = (value: number): string => `${(value * 100).toFixed(2)}%`;
const num = (value: number): string => value.toFixed(2);

/**
 * Run the gate over one eval run.
 *
 * @param current    the run under test (an `EvalRunSummary` or a parsed report summary)
 * @param thresholds partial override of {@link DEFAULT_GATE_THRESHOLDS}
 */
export function evaluateGate(
  current: GateInput,
  thresholds: Partial<GateThresholds> = {},
): GateResult {
  // Resolved key by key, not by spreading: an explicit `{maxHallucinationRate:
  // undefined}` (what an optional CLI flag produces when it was not passed)
  // must fall back to the default, not blow the ceiling away.
  const limits: GateThresholds = {
    maxHallucinationRate:
      thresholds.maxHallucinationRate ?? DEFAULT_GATE_THRESHOLDS.maxHallucinationRate,
    maxFailedItemRate:
      thresholds.maxFailedItemRate ?? DEFAULT_GATE_THRESHOLDS.maxFailedItemRate,
    minScoredItems: thresholds.minScoredItems ?? DEFAULT_GATE_THRESHOLDS.minScoredItems,
  };
  const checks: GateCheck[] = [];

  // 1. Hallucination ceiling. Strict `>`: a rate exactly at the ceiling is
  // allowed. The rate is a single division (unsupported / totalClaims) with no
  // accumulated error, so there is nothing here for an epsilon to rescue.
  const ceiling = limits.maxHallucinationRate;
  checks.push(
    current.hallucinationRate > ceiling
      ? {
          name: "hallucination",
          status: "fail",
          detail: `Hallucination rate ${pct(current.hallucinationRate)} exceeds the ${pct(ceiling)} ceiling.`,
        }
      : {
          name: "hallucination",
          status: "pass",
          detail: `Hallucination rate ${pct(current.hallucinationRate)} is within the ${pct(ceiling)} ceiling.`,
        },
  );

  // 2. Regression vs. the current baseline. No baseline (or too few shared
  // items to bootstrap) means no evidence, which is not the same as evidence
  // of no regression — say so rather than quietly passing.
  const vs = current.vsBaseline;
  if (!vs) {
    checks.push({
      name: "regression",
      status: "skipped",
      detail:
        "No baseline run to compare against — mark a run `--baseline` on main to enable this check.",
    });
  } else {
    const [lo, hi] = vs.ci95;
    const interval = `[${num(lo)}, ${num(hi)}]`;
    checks.push(
      hi < 0
        ? {
            name: "regression",
            status: "fail",
            detail:
              `Mean judge score regressed against baseline ${vs.baselineRunId}: ` +
              `diff ${num(vs.diff)}, 95% CI ${interval} lies entirely below 0.`,
          }
        : {
            name: "regression",
            status: "pass",
            detail:
              `Mean judge score vs baseline ${vs.baselineRunId}: ` +
              `diff ${num(vs.diff)}, 95% CI ${interval} includes 0 (no proven regression).`,
          },
    );
  }

  // 3. Did the run actually run? See the module header.
  const failed = current.failedItems;
  if (failed == null) {
    checks.push({
      name: "failed_items",
      status: "skipped",
      detail: "This run did not record `failed_items` (recorded before the field existed).",
    });
  } else {
    const attempted = current.itemsAttempted ?? current.n + failed;
    const rate = attempted === 0 ? 0 : failed / attempted;
    checks.push(
      rate > limits.maxFailedItemRate
        ? {
            name: "failed_items",
            status: "fail",
            detail:
              `${failed} of ${attempted} items (${pct(rate)}) failed to produce a graded result, ` +
              `over the ${pct(limits.maxFailedItemRate)} tolerance — the scores below cover only part of the set.`,
          }
        : {
            name: "failed_items",
            status: "pass",
            detail:
              failed === 0
                ? `All ${attempted} attempted items produced a graded result.`
                : `${failed} of ${attempted} items (${pct(rate)}) failed — within the ` +
                  `${pct(limits.maxFailedItemRate)} tolerance for transient provider errors.`,
          },
    );
  }

  // 4. Coverage floor: an empty run must never be a green check.
  checks.push(
    current.n < limits.minScoredItems
      ? {
          name: "coverage",
          status: "fail",
          detail:
            `The run scored no items (needed at least ${limits.minScoredItems}) — ` +
            "nothing was actually measured.",
        }
      : {
          name: "coverage",
          status: "pass",
          detail: `${current.n} items scored.`,
        },
  );

  const reasons = checks.filter((c) => c.status === "fail").map((c) => c.detail);
  return { pass: reasons.length === 0, reasons, checks };
}

const ICON: Record<GateCheck["status"], string> = {
  pass: "✅",
  fail: "❌",
  skipped: "➖",
};

/**
 * The GitHub Actions job summary (`$GITHUB_STEP_SUMMARY`).
 *
 * Spec §7 requires the run's cost to be logged here, so a reviewer can see
 * what each gate run spends without opening the report artifact.
 */
export function renderGateSummaryMarkdown(
  current: GateInput,
  result: GateResult,
): string {
  const lines: string[] = [];
  lines.push(`## ${ICON[result.pass ? "pass" : "fail"]} Eval gate: ${result.pass ? "PASS" : "FAIL"}`);
  lines.push("");

  const cost = current.costUsd ?? 0;
  const perItem = current.n > 0 ? cost / current.n : 0;
  lines.push("| | |");
  lines.push("|---|---|");
  lines.push(`| step | \`${current.step ?? "?"}\` |`);
  lines.push(`| model | \`${current.modelId ?? "?"}\` |`);
  if (current.meanScore != null) lines.push(`| mean judge score | ${num(current.meanScore)} / 5 |`);
  lines.push(`| hallucination rate | ${pct(current.hallucinationRate)} |`);
  lines.push(`| items scored | ${current.n}${current.failedItems ? ` (${current.failedItems} failed)` : ""} |`);
  lines.push(`| **cost** | **$${cost.toFixed(4)}** ($${perItem.toFixed(4)}/item) |`);
  if (current.runId) lines.push(`| eval run | \`${current.runId}\` |`);
  if (current.gitSha) lines.push(`| commit | \`${current.gitSha}\` |`);
  lines.push("");

  lines.push("### Checks");
  lines.push("");
  for (const check of result.checks) {
    lines.push(`- ${ICON[check.status]} **${check.name}** — ${check.detail}`);
  }
  lines.push("");

  if (!result.pass) {
    lines.push("### Why this PR is blocked");
    lines.push("");
    for (const reason of result.reasons) lines.push(`1. ${reason}`);
    lines.push("");
    lines.push(
      "Fix the prompt/model change, or — if the drop is intended — re-baseline on `main` after merging a deliberate quality trade-off.",
    );
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

/** Exit code the CLI should use. Kept here so the rule lives with the gate. */
export function gateExitCode(result: GateResult): 0 | 1 {
  return result.pass ? 0 : 1;
}
