/**
 * The CI gate (spec §7): the three questions a pull request has to answer
 * before a prompt or model change is allowed to land.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_GATE_THRESHOLDS,
  evaluateGate,
  renderGateSummaryMarkdown,
  type GateInput,
} from "../../src/eval/gate";
import type { EvalRunSummary } from "../../src/eval/runner";

/** A clean 20-item gate run: no unsupported claims, no regression, nothing failed. */
function summary(overrides: Partial<EvalRunSummary> = {}): EvalRunSummary {
  return {
    runId: "run-1",
    step: "tailor",
    modelId: "google:gemini-3.7-flash",
    n: 20,
    meanScore: 4.4,
    hallucinationRate: 0,
    kappa: 0.71,
    costUsd: 0.1234,
    p50Ms: 4200,
    p95Ms: 9100,
    judgeModelId: "google:gemini-3.7-flash",
    baseline: false,
    gitSha: "abc1234",
    promptVersionId: "pv-1",
    itemsAttempted: 20,
    failedItems: 0,
    gradedItems: 12,
    createdAt: "2026-08-27T00:00:00.000Z",
    results: [],
    ...overrides,
  };
}

describe("evaluateGate", () => {
  it("passes a clean run", () => {
    const result = evaluateGate(summary());
    expect(result.pass).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("fails when the hallucination rate exceeds the ceiling", () => {
    const result = evaluateGate(summary({ hallucinationRate: 0.05 }));
    expect(result.pass).toBe(false);
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toMatch(/hallucination/i);
    expect(result.reasons[0]).toContain("5.00%");
    expect(result.reasons[0]).toContain("2.00%");
  });

  it("fails when the 95% CI of (mean − baseline) lies entirely below zero", () => {
    const result = evaluateGate(
      summary({
        meanScore: 3.9,
        vsBaseline: { diff: -0.5, ci95: [-0.9, -0.1], baselineRunId: "run-0" },
      }),
    );
    expect(result.pass).toBe(false);
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toMatch(/baseline|regress/i);
    expect(result.reasons[0]).toContain("-0.90");
    expect(result.reasons[0]).toContain("-0.10");
  });

  // --- boundaries and the checks the three headline cases don't cover -------

  it("treats a rate exactly at the ceiling as a pass", () => {
    expect(evaluateGate(summary({ hallucinationRate: 0.02 })).pass).toBe(true);
    expect(evaluateGate(summary({ hallucinationRate: 0.0201 })).pass).toBe(false);
  });

  it("does not fail a run whose CI straddles zero", () => {
    const result = evaluateGate(
      summary({ vsBaseline: { diff: -0.2, ci95: [-0.7, 0.3], baselineRunId: "run-0" } }),
    );
    expect(result.pass).toBe(true);
    expect(result.checks.find((c) => c.name === "regression")?.status).toBe("pass");
  });

  it("skips the regression check when there is no baseline to compare against", () => {
    const result = evaluateGate(summary());
    expect(result.pass).toBe(true);
    expect(result.checks.find((c) => c.name === "regression")?.status).toBe("skipped");
  });

  it("fails a run where items errored instead of scoring", () => {
    // A 40-item run that scored 3 must not read like a clean 3-item run.
    const result = evaluateGate(summary({ n: 3, itemsAttempted: 40, failedItems: 37 }));
    expect(result.pass).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/37 of 40/);
  });

  it("tolerates the occasional transient provider error", () => {
    // Observed live: 1 of 20 items lost to "This model is currently
    // experiencing high demand". The other 19 still make a valid comparison.
    const result = evaluateGate(summary({ n: 19, itemsAttempted: 20, failedItems: 1 }));
    expect(result.pass).toBe(true);
    const check = result.checks.find((c) => c.name === "failed_items");
    expect(check?.status).toBe("pass");
    expect(check?.detail).toContain("1 of 20"); // still surfaced, not hidden
  });

  it("fails once failures pass the tolerance", () => {
    // 3 of 20 = 15%, over the 10% default.
    const result = evaluateGate(summary({ n: 17, itemsAttempted: 20, failedItems: 3 }));
    expect(result.pass).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/15\.00%/);
  });

  it("fails a run that scored nothing at all", () => {
    const result = evaluateGate(
      summary({ n: 0, meanScore: 0, itemsAttempted: 0, failedItems: 0 }),
    );
    expect(result.pass).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/no items/i);
  });

  it("reports every failure at once, not just the first", () => {
    const result = evaluateGate(
      summary({
        hallucinationRate: 0.09,
        vsBaseline: { diff: -0.8, ci95: [-1.2, -0.4], baselineRunId: "run-0" },
      }),
    );
    expect(result.pass).toBe(false);
    expect(result.reasons).toHaveLength(2);
  });

  it("treats a missing failed_items (runs recorded before it existed) as unknown, not zero", () => {
    const result = evaluateGate(summary({ failedItems: null as unknown as number }));
    expect(result.pass).toBe(true);
    expect(result.checks.find((c) => c.name === "failed_items")?.status).toBe("skipped");
  });

  it("honours an explicit threshold override", () => {
    const result = evaluateGate(summary({ hallucinationRate: 0.05 }), {
      maxHallucinationRate: 0.1,
    });
    expect(result.pass).toBe(true);
  });

  it("falls back to the defaults when an override is explicitly undefined", () => {
    // What an optional CLI flag produces when it was not passed.
    const result = evaluateGate(summary({ hallucinationRate: 0.05 }), {
      maxHallucinationRate: undefined,
      maxFailedItemRate: undefined,
    });
    expect(result.pass).toBe(false);
    expect(result.reasons[0]).toContain("2.00%");
  });

  it("uses 0.02 as the documented default ceiling", () => {
    expect(DEFAULT_GATE_THRESHOLDS.maxHallucinationRate).toBe(0.02);
  });

  it("accepts anything shaped like a run summary, including a parsed report", () => {
    // eval-report.json's `summary` is an EvalRunSummary minus `results`; the
    // gate must be able to read one straight off disk in a later CI step.
    const { results: _dropped, ...fromDisk } = summary();
    const input: GateInput = fromDisk;
    expect(evaluateGate(input).pass).toBe(true);
  });
});

describe("renderGateSummaryMarkdown", () => {
  it("leads with the verdict and always reports the run's cost", () => {
    const md = renderGateSummaryMarkdown(summary(), evaluateGate(summary()));
    expect(md).toContain("Eval gate: PASS");
    expect(md).toContain("$0.1234");
    expect(md).toContain("google:gemini-3.7-flash");
  });

  it("lists every reason when the gate fails", () => {
    const failing = summary({ hallucinationRate: 0.05 });
    const md = renderGateSummaryMarkdown(failing, evaluateGate(failing));
    expect(md).toContain("Eval gate: FAIL");
    expect(md).toMatch(/hallucination/i);
    expect(md).toContain("5.00%");
  });
});
