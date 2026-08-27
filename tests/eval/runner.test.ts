import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MIN_GRADED_ITEMS_FOR_KAPPA,
  computeKappa,
  summarizeRows,
  type EvalResultRow,
  type EvalRunSummary,
} from "../../src/eval/runner";
import { buildReportJson, renderReportHtml, writeReports } from "../../src/eval/report";

function row(overrides: Partial<EvalResultRow> = {}): EvalResultRow {
  const judge = overrides.judgeScores ?? {
    grounding: 4,
    coverage: 4,
    specificity: 4,
    stuffing_penalty: 4,
    rationale: "fine",
  };
  const meanScore =
    overrides.meanScore !== undefined
      ? overrides.meanScore
      : (judge.grounding + judge.coverage + judge.specificity + judge.stuffing_penalty) / 4;

  return {
    itemId: "item-1",
    jobId: "job-1",
    title: "Backend Engineer",
    company: "Acme",
    generationId: "gen-1",
    judgeScores: judge,
    meanScore,
    humanGrades: null,
    totalClaims: 10,
    hallucinationCount: 0,
    unsupportedClaims: [],
    costUsd: 0.01,
    latencyMs: 1000,
    error: null,
    ...overrides,
  };
}

describe("summarizeRows", () => {
  it("averages the per-item mean scores over scored items only", () => {
    const stats = summarizeRows([
      row({ itemId: "a", meanScore: 5 }),
      row({ itemId: "b", meanScore: 3 }),
      row({ itemId: "c", judgeScores: null, meanScore: null, error: "boom" }),
    ]);
    expect(stats.n).toBe(2);
    expect(stats.meanScore).toBe(4);
    expect(stats.failedItems).toBe(1);
  });

  it("pools the hallucination rate across every claim in the run", () => {
    const stats = summarizeRows([
      row({ itemId: "a", totalClaims: 10, hallucinationCount: 1 }),
      row({ itemId: "b", totalClaims: 30, hallucinationCount: 0 }),
    ]);
    // 1 unsupported claim out of 40, not the mean of 10% and 0%.
    expect(stats.hallucinationRate).toBeCloseTo(1 / 40, 12);
  });

  it("counts a run's whole cost, failed items included", () => {
    const stats = summarizeRows([
      row({ itemId: "a", costUsd: 0.02 }),
      row({ itemId: "b", costUsd: 0.03, error: "boom", meanScore: null, judgeScores: null }),
    ]);
    expect(stats.costUsd).toBeCloseTo(0.05, 12);
  });

  it("reports p50/p95 of the step latency", () => {
    const stats = summarizeRows(
      [500, 1000, 1500, 2000].map((latencyMs, i) => row({ itemId: `i${i}`, latencyMs })),
    );
    expect(stats.p50Ms).toBe(1250);
    expect(stats.p95Ms).toBeCloseTo(1925, 6);
  });

  it("leaves an item with no measured latency out of the percentile sample", () => {
    const stats = summarizeRows([
      row({ itemId: "a", latencyMs: 1000 }),
      row({ itemId: "b", latencyMs: 2000 }),
      // No latency reported — absent from the sample, not a 0 ms item, which
      // would otherwise drag p50 down to 1000 and flatter the run.
      row({ itemId: "c", latencyMs: null }),
    ]);
    expect(stats.p50Ms).toBe(1500);
    expect(stats.p95Ms).toBeCloseTo(1950, 6);
  });

  it("reports 0 ms percentiles when no item measured a latency", () => {
    const stats = summarizeRows([row({ itemId: "a", latencyMs: null })]);
    expect(stats.p50Ms).toBe(0);
    expect(stats.p95Ms).toBe(0);
  });

  it("survives a run in which every item failed", () => {
    const stats = summarizeRows([
      row({ itemId: "a", error: "boom", meanScore: null, judgeScores: null, totalClaims: 0 }),
    ]);
    expect(stats.n).toBe(0);
    expect(stats.meanScore).toBe(0);
    expect(stats.hallucinationRate).toBe(0);
    expect(stats.kappa).toBeNull();
  });
});

describe("computeKappa", () => {
  const graded = (n: number, offset = 0) =>
    Array.from({ length: n }, (_, i) => {
      const score = (i % 5) + 1;
      const human = Math.min(5, Math.max(1, score + offset));
      return row({
        itemId: `i${i}`,
        judgeScores: {
          grounding: score,
          coverage: score,
          specificity: score,
          stuffing_penalty: score,
          rationale: "r",
        },
        humanGrades: {
          grounding: human,
          coverage: human,
          specificity: human,
          stuffing_penalty: human,
        },
      });
    });

  it("is null below the minimum number of graded items", () => {
    expect(computeKappa(graded(MIN_GRADED_ITEMS_FOR_KAPPA - 1))).toBeNull();
  });

  it("is 1 when the judge and the human agree on every axis", () => {
    expect(computeKappa(graded(MIN_GRADED_ITEMS_FOR_KAPPA))).toBe(1);
  });

  it("drops below 1 when the human is consistently one point apart", () => {
    const kappa = computeKappa(graded(10, 1));
    expect(kappa).not.toBeNull();
    expect(kappa as number).toBeLessThan(1);
  });

  it("ignores items with no human grade", () => {
    const rows = [...graded(5), row({ itemId: "ungraded", humanGrades: null })];
    expect(computeKappa(rows)).toBe(1);
  });
});

function summary(overrides: Partial<EvalRunSummary> = {}): EvalRunSummary {
  return {
    runId: "run-1",
    step: "tailor",
    modelId: "google:gemini-3.7-flash",
    n: 2,
    meanScore: 4.25,
    hallucinationRate: 0.01,
    kappa: null,
    costUsd: 0.04,
    p50Ms: 1200,
    p95Ms: 2400,
    judgeModelId: "google:gemini-3.7-flash",
    baseline: false,
    gitSha: "abc123",
    promptVersionId: "pv-1",
    itemsAttempted: 2,
    failedItems: 0,
    gradedItems: 0,
    createdAt: "2026-08-27T00:00:00.000Z",
    results: [],
    ...overrides,
  };
}

describe("reports", () => {
  it("writes both files and strips the duplicated rows from the summary", () => {
    const rows = [row({ itemId: "a" }), row({ itemId: "b", error: "provider exploded" })];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-report-"));
    const written = writeReports(summary({ results: rows }), rows, dir);

    expect(fs.existsSync(written.json)).toBe(true);
    expect(fs.existsSync(written.html)).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(written.json, "utf8"));
    expect(parsed.summary.results).toBeUndefined();
    expect(parsed.results).toHaveLength(2);
    expect(parsed.summary.runId).toBe("run-1");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("puts the headline numbers and every item in the HTML", () => {
    const rows = [row({ itemId: "a", title: "Backend Engineer" })];
    const html = renderReportHtml(summary({ results: rows }), rows);
    expect(html).toContain("Backend Engineer");
    expect(html).toContain("4.25");
    expect(html).toContain("pending grades");
    expect(html).toContain("google:gemini-3.7-flash");
  });

  it("escapes hostile text rather than injecting it into the page", () => {
    const rows = [row({ itemId: "a", title: "<script>alert(1)</script>" })];
    const html = renderReportHtml(summary({ results: rows }), rows);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders the baseline comparison when there is one", () => {
    const withBaseline = summary({
      vsBaseline: { diff: -0.4, ci95: [-0.9, -0.1], baselineRunId: "run-0" },
    });
    const json = buildReportJson(withBaseline, []);
    expect(json.summary.vsBaseline?.ci95).toEqual([-0.9, -0.1]);
    expect(renderReportHtml(withBaseline, [])).toContain("95% CI [-0.90, -0.10]");
  });
});
