import { describe, it, expect } from "vitest";
import {
  bootstrapMeanDiff,
  mean,
  percentile,
  weightedKappa,
} from "../../src/eval/stats";

describe("percentile", () => {
  it("interpolates linearly between order statistics", () => {
    // The build plan's worked example: median of [1,2,3,4] is 2.5.
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
  });

  it("returns the endpoints for p=0 and p=1", () => {
    expect(percentile([4, 1, 3, 2], 0)).toBe(1);
    expect(percentile([4, 1, 3, 2], 1)).toBe(4);
  });

  it("does not depend on input order", () => {
    expect(percentile([4, 2, 1, 3], 0.5)).toBe(percentile([1, 2, 3, 4], 0.5));
  });

  it("computes p50/p95 of a latency-shaped sample", () => {
    const xs = [100, 120, 140, 160, 180, 200, 220, 240, 260, 2000];
    expect(percentile(xs, 0.5)).toBe(190);
    // rank = 0.95 * 9 = 8.55 → between 260 and 2000
    expect(percentile(xs, 0.95)).toBeCloseTo(260 + 0.55 * (2000 - 260), 6);
  });

  it("handles a single value and rejects an empty sample", () => {
    expect(percentile([7], 0.42)).toBe(7);
    expect(() => percentile([], 0.5)).toThrow(/empty/i);
  });

  it("rejects a p outside [0,1]", () => {
    expect(() => percentile([1, 2], 1.5)).toThrow(/between 0 and 1/i);
  });
});

describe("mean", () => {
  it("averages", () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
  });

  it("rejects an empty sample", () => {
    expect(() => mean([])).toThrow(/empty/i);
  });
});

describe("weightedKappa", () => {
  const opts = { min: 1, max: 5, weights: "quadratic" as const };

  it("is 1 for perfect agreement", () => {
    expect(weightedKappa([1, 2, 3, 4, 5], [1, 2, 3, 4, 5], opts)).toBe(1);
  });

  it("is negative for perfectly reversed grades", () => {
    expect(weightedKappa([1, 2, 3, 4, 5], [5, 4, 3, 2, 1], opts)).toBeLessThan(0);
  });

  it("is symmetric in its two raters", () => {
    const a = [1, 3, 3, 5, 2, 4];
    const b = [2, 3, 4, 5, 1, 4];
    expect(weightedKappa(a, b, opts)).toBeCloseTo(weightedKappa(b, a, opts), 12);
  });

  it("scores near-misses above wild misses (quadratic weighting)", () => {
    const truth = [1, 2, 3, 4, 5];
    const near = weightedKappa(truth, [1, 2, 3, 4, 4], opts);
    const wild = weightedKappa(truth, [1, 2, 3, 4, 1], opts);
    expect(near).toBeGreaterThan(wild);
    expect(near).toBeGreaterThan(0.9);
  });

  it("matches a hand-computed value", () => {
    // 4 items, scale 1..5, weights w = ((i-j)/4)^2.
    // a = [1,2,3,4], b = [1,2,3,5]: one disagreement of 1 step.
    // Observed disagreement  = (1/4) * (1/4)^2 = 0.015625
    // Marginals: a → 1,2,3,4 each .25 ; b → 1,2,3,5 each .25
    // Expected disagreement = (1/16) * Σ_ij w(a_i, b_j) over the 16 pairs.
    const w = (i: number, j: number) => ((i - j) / 4) ** 2;
    const av = [1, 2, 3, 4];
    const bv = [1, 2, 3, 5];
    let expected = 0;
    for (const i of av) for (const j of bv) expected += w(i, j) / 16;
    const observed = 0.015625;
    expect(weightedKappa(av, bv, opts)).toBeCloseTo(1 - observed / expected, 12);
  });

  it("returns 1 when both raters are constant and identical (no chance variance)", () => {
    expect(weightedKappa([3, 3, 3], [3, 3, 3], opts)).toBe(1);
  });

  it("returns 0 when chance disagreement is 0 but the raters disagree", () => {
    // Both raters constant but different: expected disagreement is 0, so
    // kappa is mathematically undefined; we report no agreement.
    expect(weightedKappa([3, 3, 3], [4, 4, 4], opts)).toBe(0);
  });

  it("supports linear weights", () => {
    const linear = weightedKappa([1, 2, 3, 4], [1, 2, 3, 5], {
      min: 1,
      max: 5,
      weights: "linear",
    });
    expect(linear).toBeGreaterThan(0);
    expect(linear).toBeLessThan(1);
  });

  it("rejects mismatched lengths, empty input and out-of-range grades", () => {
    expect(() => weightedKappa([1, 2], [1], opts)).toThrow(/same length/i);
    expect(() => weightedKappa([], [], opts)).toThrow(/empty/i);
    expect(() => weightedKappa([9], [1], opts)).toThrow(/out of range/i);
  });
});

describe("bootstrapMeanDiff", () => {
  it("reports a zero diff with a CI containing 0 for identical samples", () => {
    const r = bootstrapMeanDiff([3, 3, 3], [3, 3, 3], {
      iterations: 1000,
      seed: 1,
    });
    expect(r.diff).toBe(0);
    expect(r.ci95[0]).toBeLessThanOrEqual(0);
    expect(r.ci95[1]).toBeGreaterThanOrEqual(0);
  });

  it("is deterministic for a given seed and differs across seeds", () => {
    const a = [4.2, 3.1, 4.8, 2.9, 3.7, 4.4, 3.3, 4.9];
    const b = [3.9, 3.4, 4.1, 3.0, 3.2, 4.0, 3.1, 4.2];
    const one = bootstrapMeanDiff(a, b, { iterations: 500, seed: 7 });
    const two = bootstrapMeanDiff(a, b, { iterations: 500, seed: 7 });
    const other = bootstrapMeanDiff(a, b, { iterations: 500, seed: 8 });
    expect(one).toEqual(two);
    expect(one.ci95).not.toEqual(other.ci95);
  });

  it("computes the point estimate as mean(current) - mean(baseline)", () => {
    const r = bootstrapMeanDiff([5, 5, 5, 5], [3, 3, 3, 3], {
      iterations: 200,
      seed: 3,
    });
    expect(r.diff).toBeCloseTo(2, 12);
    expect(r.ci95[0]).toBeCloseTo(2, 12);
    expect(r.ci95[1]).toBeCloseTo(2, 12);
  });

  it("puts a clearly worse current run's CI entirely below 0", () => {
    const baseline = [4.5, 4.6, 4.4, 4.7, 4.5, 4.6, 4.4, 4.5];
    const current = [3.1, 3.0, 3.2, 2.9, 3.1, 3.0, 3.2, 3.1];
    const r = bootstrapMeanDiff(current, baseline, {
      iterations: 1000,
      seed: 42,
    });
    expect(r.diff).toBeLessThan(0);
    expect(r.ci95[1]).toBeLessThan(0);
  });

  it("brackets the point estimate", () => {
    const current = [4, 3, 5, 2, 4, 5, 3, 4, 4, 3];
    const baseline = [3, 3, 4, 2, 3, 4, 3, 3, 4, 2];
    const r = bootstrapMeanDiff(current, baseline, {
      iterations: 1000,
      seed: 11,
    });
    expect(r.ci95[0]).toBeLessThanOrEqual(r.diff);
    expect(r.ci95[1]).toBeGreaterThanOrEqual(r.diff);
    expect(r.iterations).toBe(1000);
    expect(r.paired).toBe(true);
  });

  it("falls back to an unpaired bootstrap when the samples differ in length", () => {
    const r = bootstrapMeanDiff([4, 4, 4, 4, 4], [3, 3, 3], {
      iterations: 300,
      seed: 5,
    });
    expect(r.paired).toBe(false);
    expect(r.diff).toBeCloseTo(1, 12);
  });

  it("rejects empty samples", () => {
    expect(() => bootstrapMeanDiff([], [1], { iterations: 10, seed: 1 })).toThrow(
      /empty/i,
    );
  });
});
