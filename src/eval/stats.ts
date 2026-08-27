/**
 * The three statistics the eval harness reports (spec §7), implemented here
 * with no dependencies so they are unit-testable and deterministic:
 *
 *   - {@link percentile}         — p50/p95 latency;
 *   - {@link weightedKappa}      — judge-vs-human agreement, quadratic weights;
 *   - {@link bootstrapMeanDiff}  — 95% CI on (current − baseline) mean score.
 *
 * All three are pure functions over plain arrays: nothing here touches the
 * database, the network, or `Math.random()` (the bootstrap takes an explicit
 * seed, so a CI gate that fails is reproducible on a laptop).
 */

/** Arithmetic mean. Throws on an empty sample — a mean of nothing is a bug. */
export function mean(xs: readonly number[]): number {
  if (xs.length === 0) throw new Error("mean() of an empty sample");
  let total = 0;
  for (const x of xs) total += x;
  return total / xs.length;
}

/**
 * Linearly-interpolated percentile (the "R type 7" / `numpy.percentile`
 * default): rank `p * (n - 1)` into the sorted sample, interpolating between
 * the two neighbouring order statistics.
 *
 * `percentile([1,2,3,4], 0.5) === 2.5`.
 *
 * @param p in [0, 1] — 0.5 is the median, 0.95 the p95.
 */
export function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) throw new Error("percentile() of an empty sample");
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    throw new Error(`percentile(): p must be between 0 and 1, got ${p}`);
  }

  const sorted = [...xs].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];

  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (rank - lo) * (sorted[hi] - sorted[lo]);
}

export interface KappaOptions {
  /** Lowest grade on the rubric (1 for the four judge axes). */
  min: number;
  /** Highest grade on the rubric (5 for the four judge axes). */
  max: number;
  /**
   * `quadratic` (the spec's choice) punishes a 1-vs-5 disagreement 16× harder
   * than a 1-vs-2 one, which is what you want for an ordered rubric: a judge
   * that is usually one point off is nearly as useful as one that agrees.
   */
  weights?: "quadratic" | "linear";
}

/**
 * Weighted Cohen's kappa between two raters over the same items — here the
 * judge model and the owner's human grades on one rubric axis (spec §7).
 *
 * 1 = perfect agreement, 0 = no better than chance, negative = systematically
 * worse than chance (e.g. the raters ordered items oppositely).
 *
 * Degenerate case: when both raters use a single grade for every item there
 * is no chance variance, so the denominator is 0 and kappa is mathematically
 * undefined. We return 1 when the raters nonetheless agreed on every item and
 * 0 when they did not, rather than NaN — a NaN would silently poison the run
 * metrics, and both answers are the honest reading of "no variance to explain".
 */
export function weightedKappa(
  a: readonly number[],
  b: readonly number[],
  options: KappaOptions,
): number {
  if (a.length !== b.length) {
    throw new Error(
      `weightedKappa(): raters must have the same length (${a.length} vs ${b.length})`,
    );
  }
  if (a.length === 0) throw new Error("weightedKappa() of an empty sample");

  const { min, max } = options;
  const k = Math.round(max - min) + 1;
  if (k < 2) throw new Error("weightedKappa(): the scale needs ≥ 2 categories");

  const index = (value: number, rater: string): number => {
    const i = Math.round(value) - min;
    if (!Number.isFinite(value) || i < 0 || i >= k) {
      throw new Error(
        `weightedKappa(): grade ${value} from ${rater} is out of range [${min}, ${max}]`,
      );
    }
    return i;
  };

  const exponent = options.weights === "linear" ? 1 : 2;
  const weight = (i: number, j: number) => Math.abs(i - j) ** exponent / (k - 1) ** exponent;

  const n = a.length;
  const observed: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  const marginalA = new Array<number>(k).fill(0);
  const marginalB = new Array<number>(k).fill(0);

  for (let t = 0; t < n; t++) {
    const i = index(a[t], "rater a");
    const j = index(b[t], "rater b");
    observed[i][j] += 1 / n;
    marginalA[i] += 1 / n;
    marginalB[j] += 1 / n;
  }

  let observedDisagreement = 0;
  let expectedDisagreement = 0;
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      const w = weight(i, j);
      observedDisagreement += w * observed[i][j];
      expectedDisagreement += w * marginalA[i] * marginalB[j];
    }
  }

  if (expectedDisagreement === 0) {
    return observedDisagreement === 0 ? 1 : 0;
  }
  return 1 - observedDisagreement / expectedDisagreement;
}

export interface BootstrapOptions {
  /** Resamples to draw. Spec §7 fixes this at 1000 for the eval gate. */
  iterations: number;
  /** Seed for the PRNG — same seed, same interval, on any machine. */
  seed: number;
}

export interface BootstrapResult {
  /** `mean(current) − mean(baseline)`, computed on the real samples. */
  diff: number;
  /** Percentile bootstrap interval: the 2.5th and 97.5th resampled diffs. */
  ci95: [number, number];
  iterations: number;
  /**
   * True when the two samples were resampled as pairs (same length — the eval
   * runner passes per-item scores for the items both runs share, so a paired
   * bootstrap removes item difficulty from the variance). False when lengths
   * differ and the two samples were resampled independently.
   */
  paired: boolean;
}

/**
 * `mulberry32` — a 32-bit PRNG that is tiny, fast and, crucially, seedable.
 * `Math.random()` is not seedable, and a gate that fails differently on every
 * run is a gate nobody trusts.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Percentile bootstrap for the difference in mean score between a candidate
 * run and the baseline run (spec §7: 1000 resamples, 95% CI).
 *
 * The eval gate fails a PR when this interval lies entirely below 0 — i.e.
 * when the candidate is worse than the baseline by more than sampling noise
 * can explain.
 */
export function bootstrapMeanDiff(
  current: readonly number[],
  baseline: readonly number[],
  options: BootstrapOptions,
): BootstrapResult {
  if (current.length === 0 || baseline.length === 0) {
    throw new Error("bootstrapMeanDiff(): empty sample");
  }
  const iterations = Math.max(1, Math.floor(options.iterations));
  const rand = mulberry32(options.seed);
  const paired = current.length === baseline.length;
  const diff = mean(current) - mean(baseline);

  const diffs = new Array<number>(iterations);
  for (let it = 0; it < iterations; it++) {
    if (paired) {
      // Resample items, keeping each item's (current, baseline) pair together.
      let total = 0;
      const n = current.length;
      for (let i = 0; i < n; i++) {
        const pick = Math.floor(rand() * n);
        total += current[pick] - baseline[pick];
      }
      diffs[it] = total / n;
    } else {
      let currentTotal = 0;
      for (let i = 0; i < current.length; i++) {
        currentTotal += current[Math.floor(rand() * current.length)];
      }
      let baselineTotal = 0;
      for (let i = 0; i < baseline.length; i++) {
        baselineTotal += baseline[Math.floor(rand() * baseline.length)];
      }
      diffs[it] = currentTotal / current.length - baselineTotal / baseline.length;
    }
  }

  return {
    diff,
    ci95: [percentile(diffs, 0.025), percentile(diffs, 0.975)],
    iterations,
    paired,
  };
}
