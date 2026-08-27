import { describe, it, expect } from "vitest";
import { computeGateStatus } from "../../src/funnel/public-results";
import type { EvalRunListItem } from "../../src/eval/runner";

/**
 * Pins `computeGateStatus`'s thresholds against Task 12's real
 * `DEFAULT_GATE_THRESHOLDS` (`src/eval/gate.ts`: maxHallucinationRate 0.02,
 * maxFailedItemRate 0.1, minScoredItems 1) so the public `/results` badge
 * never disagrees with the CI gate that actually blocks merges. If Task 12
 * changes its defaults, this test (and `computeGateStatus`'s constants)
 * must change with it.
 */
function baseRun(overrides: Partial<EvalRunListItem> = {}): EvalRunListItem {
  return {
    id: "run-1",
    step: "tailor",
    modelId: "google:gemini-3.7-flash",
    baseline: false,
    gitSha: null,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    itemCount: 20,
    itemsAttempted: 20,
    failedItems: 0,
    meanScore: 4.5,
    hallucinationRate: 0,
    kappa: null,
    costUsd: 0.5,
    p50Ms: 1200,
    p95Ms: 2400,
    vsBaseline: null,
    ...overrides,
  };
}

describe("computeGateStatus", () => {
  it("passes at exactly the 2% hallucination threshold", () => {
    const result = computeGateStatus(baseRun({ hallucinationRate: 0.02 }));
    expect(result.status).toBe("pass");
    expect(result.reasons).toEqual([]);
  });

  it("fails above the 2% hallucination threshold", () => {
    const result = computeGateStatus(baseRun({ hallucinationRate: 0.021 }));
    expect(result.status).toBe("fail");
    expect(result.reasons.join(" ")).toMatch(/hallucination rate/);
  });

  it("fails when the vs-baseline 95% CI is entirely below zero", () => {
    const result = computeGateStatus(
      baseRun({
        vsBaseline: { diff: -0.9, ci95: [-1.14, -0.64], baselineRunId: "baseline-1" },
      }),
    );
    expect(result.status).toBe("fail");
    expect(result.reasons.join(" ")).toMatch(/below zero/);
  });

  it("passes when the vs-baseline 95% CI straddles zero", () => {
    const result = computeGateStatus(
      baseRun({
        vsBaseline: { diff: 0.1, ci95: [-0.2, 0.4], baselineRunId: "baseline-1" },
      }),
    );
    expect(result.status).toBe("pass");
    expect(result.reasons).toEqual([]);
  });

  it("passes when failed items are within the 10% fractional tolerance (1 of 20, matching the real gate's documented transient-503 case)", () => {
    const result = computeGateStatus(baseRun({ itemCount: 19, itemsAttempted: 20, failedItems: 1 }));
    expect(result.status).toBe("pass");
    expect(result.reasons).toEqual([]);
  });

  it("fails when failed items exceed the 10% fractional tolerance", () => {
    const result = computeGateStatus(baseRun({ itemCount: 15, itemsAttempted: 20, failedItems: 5 }));
    expect(result.status).toBe("fail");
    expect(result.reasons.join(" ")).toMatch(/5 of 20 items failed to run \(25% > 10% threshold\)/);
  });

  it("does not fail on a single failed item out of a large attempted count (would have failed the old failedItems > 0 rule)", () => {
    const result = computeGateStatus(baseRun({ itemCount: 39, itemsAttempted: 40, failedItems: 1 }));
    expect(result.status).toBe("pass");
  });

  it("fails a run that scored zero items, even with 0% hallucination reported, so an all-errored run cannot read as passed", () => {
    const result = computeGateStatus(baseRun({ itemCount: 0, itemsAttempted: 5, failedItems: 5, hallucinationRate: 0 }));
    expect(result.status).toBe("fail");
    expect(result.reasons.join(" ")).toMatch(/scored item/);
  });

  it("combines multiple failing checks into multiple reasons", () => {
    const result = computeGateStatus(
      baseRun({
        hallucinationRate: 0.05,
        vsBaseline: { diff: -1, ci95: [-1.5, -0.5], baselineRunId: "baseline-1" },
      }),
    );
    expect(result.status).toBe("fail");
    expect(result.reasons).toHaveLength(2);
  });
});
