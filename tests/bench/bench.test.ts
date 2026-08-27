import { describe, expect, it, afterEach, vi } from "vitest";
import {
  BENCH_STEPS,
  bestByValue,
  bootstrapMeanCi,
  checkFitCitations,
  clearRubricCache,
  isBenchmarkRun,
  latestPerStepModel,
  loadJudgeRubric,
  planBench,
  renderBenchTable,
  toBenchmarkRow,
  type BenchRunSummary,
} from "../../src/bench/bench";
import { DEFAULT_MODEL_BY_STEP } from "../../src/llm/defaults";
import { LlmError } from "../../src/llm/model-id";
import type { FitOutput } from "../../src/pipeline/schemas";

afterEach(() => {
  vi.unstubAllEnvs();
  clearRubricCache();
});

describe("planBench", () => {
  it("runs the models whose provider has a key and skips the rest by name", () => {
    const plan = planBench({
      models: ["openai:gpt-5.4-mini", "anthropic:claude-haiku-4-5"],
      available: { openai: false, anthropic: true },
    });

    expect(plan.models).toEqual(["anthropic:claude-haiku-4-5"]);
    expect(plan.skipped).toEqual([
      { modelId: "openai:gpt-5.4-mini", reason: "missing OPENAI_API_KEY" },
    ]);
  });

  it("names the exact env var per provider so the fix is copy-pasteable", () => {
    const plan = planBench({
      models: ["google:gemini-3.7-flash", "anthropic:claude-sonnet-5"],
      available: { google: false, anthropic: false },
    });

    expect(plan.models).toEqual([]);
    expect(plan.skipped).toEqual([
      { modelId: "google:gemini-3.7-flash", reason: "missing GOOGLE_GENERATIVE_AI_API_KEY" },
      { modelId: "anthropic:claude-sonnet-5", reason: "missing ANTHROPIC_API_KEY" },
    ]);
  });

  it("falls back to the real environment for a provider the caller did not mention", () => {
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "key-shaped-string");

    const plan = planBench({
      models: ["google:gemini-3.7-flash", "anthropic:claude-haiku-4-5"],
      available: { openai: false },
    });

    expect(plan.models).toEqual(["anthropic:claude-haiku-4-5"]);
    expect(plan.skipped.map((s) => s.modelId)).toEqual(["google:gemini-3.7-flash"]);
  });

  it("keeps the requested order, de-duplicates and ignores blanks", () => {
    const plan = planBench({
      models: [
        "google:gemini-2.5-flash-lite",
        "  ",
        "google:gemini-3.7-flash",
        "google:gemini-2.5-flash-lite",
      ],
      available: { google: true },
    });

    expect(plan.models).toEqual([
      "google:gemini-2.5-flash-lite",
      "google:gemini-3.7-flash",
    ]);
    expect(plan.skipped).toEqual([]);
  });

  it("skips a model with no pricing row rather than failing mid-run", () => {
    const plan = planBench({
      models: ["google:gemini-9.9-imaginary"],
      available: { google: true },
    });

    expect(plan.models).toEqual([]);
    expect(plan.skipped).toEqual([
      { modelId: "google:gemini-9.9-imaginary", reason: "no pricing row in src/llm/pricing.ts" },
    ]);
  });

  it("throws on a malformed model id — a typo in --models is not a skip", () => {
    expect(() => planBench({ models: ["antropic:claude-haiku-4-5"] })).toThrow(LlmError);
  });
});

describe("judge rubrics", () => {
  it("loads one rubric per non-tailor step, each stored under its own version", () => {
    for (const step of ["analyze", "fit", "suggest"] as const) {
      const rubric = loadJudgeRubric(step);
      expect(rubric.grades).toBe(step);
      expect(rubric.storedVersion).toBe(`1.0.0-${step}`);
      expect(rubric.sha256).toMatch(/^[0-9a-f]{64}$/);
      // Every rubric must still grade the four axes the schema requires.
      for (const axis of ["grounding", "coverage", "specificity", "stuffing_penalty"]) {
        expect(rubric.content).toContain(axis);
      }
    }
  });

  it("gives the three rubrics three different bodies", () => {
    const hashes = (["analyze", "fit", "suggest"] as const).map(
      (step) => loadJudgeRubric(step).sha256,
    );
    expect(new Set(hashes).size).toBe(3);
  });
});

describe("checkFitCitations", () => {
  const fit = (matched: FitOutput["matched"]): FitOutput => ({
    score: 70,
    matched,
    gaps: [],
    rationale: "because",
  });

  it("accepts matches whose fact ids are all confirmed, case-insensitively", () => {
    const report = checkFitCitations(
      fit([{ requirement: "Python", fact_ids: [" f-001 "] }]),
      new Set(["F-001"]),
    );
    expect(report.totalClaims).toBe(1);
    expect(report.unsupported).toEqual([]);
    expect(report.rate).toBe(0);
  });

  it("flags an uncited match and an invented label", () => {
    const report = checkFitCitations(
      fit([
        { requirement: "Python", fact_ids: [] },
        { requirement: "Kubernetes", fact_ids: ["F-001", "F-999"] },
      ]),
      new Set(["F-001"]),
    );
    expect(report.unsupported).toEqual([
      { path: "matched[0]", text: "Python", badIds: [] },
      { path: "matched[1]", text: "Kubernetes", badIds: ["F-999"] },
    ]);
    expect(report.rate).toBe(1);
  });

  it("reports no claims (rate 0) for an assessment that matched nothing", () => {
    const report = checkFitCitations(fit([]), new Set(["F-001"]));
    expect(report).toEqual({ totalClaims: 0, unsupported: [], rate: 0 });
  });
});

describe("latestPerStepModel", () => {
  const run = (id: string, step: string, modelId: string) => ({
    id,
    step: step as never,
    modelId,
    itemCount: 40,
    createdAt: new Date("2026-08-27T12:00:00Z"),
    promptVersion: "1.0.0",
    metrics: {},
  });

  it("keeps the newest run per step x model and drops the older ones", () => {
    // Input is newest-first, as the query returns it.
    const kept = latestPerStepModel([
      run("new-tailor-a", "tailor", "google:gemini-3.7-flash"),
      run("new-fit-a", "fit", "google:gemini-3.7-flash"),
      run("old-tailor-a", "tailor", "google:gemini-3.7-flash"),
      run("new-tailor-b", "tailor", "google:gemini-2.5-flash-lite"),
    ]);

    expect(kept.map((r) => r.id)).toEqual(["new-tailor-a", "new-fit-a", "new-tailor-b"]);
  });
});

describe("isBenchmarkRun", () => {
  const row = (over: Record<string, unknown>) => ({
    id: "r",
    step: "tailor" as never,
    modelId: "google:gemini-3.7-flash",
    itemCount: 40,
    createdAt: new Date("2026-08-27T12:00:00Z"),
    promptVersion: "1.0.0",
    metrics: { bench: true, mean_score: 4.5 } as Record<string, unknown> | null,
    ...over,
  });

  it("accepts a finished bench run", () => {
    expect(isBenchmarkRun(row({}))).toBe(true);
  });

  it("rejects a plain eval/CI-gate run, which carries no per-item cost", () => {
    expect(isBenchmarkRun(row({ metrics: { mean_score: 4.5 } }))).toBe(false);
  });

  it("rejects an in-flight run — runEval writes its row before the first item", () => {
    expect(isBenchmarkRun(row({ metrics: null }))).toBe(false);
    expect(isBenchmarkRun(row({ metrics: { bench: true } }))).toBe(false);
  });

  it("rejects a run that scored nothing — an outage is not a result", () => {
    expect(
      isBenchmarkRun(row({ itemCount: 0, metrics: { bench: true, mean_score: 0 } })),
    ).toBe(false);
  });
});

describe("toBenchmarkRow", () => {
  const base = {
    id: "run-1",
    step: "tailor" as never,
    modelId: "google:gemini-3.7-flash",
    itemCount: 40,
    createdAt: new Date("2026-08-27T12:00:00Z"),
    promptVersion: "1.0.0",
  };

  it("reads the benchmark metrics a bench run recorded", () => {
    const row = toBenchmarkRow({
      ...base,
      metrics: {
        mean_score: 4.5,
        hallucination_rate: 0.01,
        p50_ms: 1200,
        p95_ms: 3000,
        cost_per_item_usd: 0.0068,
        judge_model_id: "google:gemini-3.7-flash",
        mean_ci95: { lo: 4.3, hi: 4.7, iterations: 1000 },
      },
    });

    expect(row).toMatchObject({
      runId: "run-1",
      provider: "google",
      n: 40,
      meanScore: 4.5,
      meanCi: [4.3, 4.7],
      hallucinationRate: 0.01,
      costPerItemUsd: 0.0068,
      p50Ms: 1200,
      p95Ms: 3000,
      judgeModelId: "google:gemini-3.7-flash",
      createdAt: "2026-08-27T12:00:00.000Z",
    });
  });

  it("derives $/item from the run's step cost when the key is absent", () => {
    const row = toBenchmarkRow({ ...base, metrics: { step_cost_usd: 0.4 } });
    expect(row.costPerItemUsd).toBeCloseTo(0.01, 12);
  });

  it("drops the degenerate interval a one-item run records", () => {
    const row = toBenchmarkRow({
      ...base,
      itemCount: 1,
      metrics: { mean_score: 5, mean_ci95: { lo: 5, hi: 5, iterations: 0 } },
    });
    expect(row.meanScore).toBe(5);
    expect(row.meanCi).toBeNull();
  });

  it("leaves $/item null for a plain eval run that recorded no step cost", () => {
    const row = toBenchmarkRow({ ...base, metrics: { mean_score: 4.9 } });
    expect(row.costPerItemUsd).toBeNull();
    expect(row.meanCi).toBeNull();
  });

  it("marks the model src/llm/defaults.ts currently ships for that step", () => {
    const shipped = toBenchmarkRow({
      ...base,
      modelId: DEFAULT_MODEL_BY_STEP.tailor,
      metrics: {},
    });
    const other = toBenchmarkRow({ ...base, modelId: "google:not-the-default", metrics: {} });
    expect(shipped.isDefault).toBe(true);
    expect(other.isDefault).toBe(false);
  });
});

describe("bootstrapMeanCi", () => {
  it("brackets the sample mean and is deterministic for a seed", () => {
    const scores = [4.0, 4.25, 4.5, 4.75, 5.0, 4.5, 4.25, 4.75];
    const a = bootstrapMeanCi(scores, 20260827);
    const b = bootstrapMeanCi(scores, 20260827);

    expect(a).toEqual(b);
    expect(a!.iterations).toBe(1000);
    const sampleMean = scores.reduce((x, y) => x + y, 0) / scores.length;
    expect(a!.lo).toBeLessThanOrEqual(sampleMean);
    expect(a!.hi).toBeGreaterThanOrEqual(sampleMean);
  });

  it("returns null below two scored items — one item has no interval", () => {
    expect(bootstrapMeanCi([4.5], 1)).toBeNull();
    expect(bootstrapMeanCi([], 1)).toBeNull();
  });
});

function benchRun(
  overrides: Partial<BenchRunSummary> & {
    costPerItem?: number;
    /** `null` = a run that recorded no interval (a single-item run). */
    ci?: [number, number] | null;
  },
) {
  const { costPerItem = 0.01, ci = [4.3, 4.7], ...rest } = overrides;
  return {
    runId: "run",
    step: "tailor",
    modelId: "google:gemini-3.7-flash",
    n: 40,
    meanScore: 4.5,
    hallucinationRate: 0,
    kappa: null,
    costUsd: 1,
    p50Ms: 1000,
    p95Ms: 2000,
    judgeModelId: "google:gemini-3.7-flash",
    baseline: false,
    gitSha: null,
    promptVersionId: null,
    itemsAttempted: 40,
    failedItems: 0,
    gradedItems: 0,
    createdAt: "2026-08-27T12:00:00.000Z",
    results: [],
    benchMetrics: {
      bench: true as const,
      judge_model_id: "google:gemini-3.7-flash",
      item_step: "tailor" as const,
      step_cost_usd: costPerItem * 40,
      cost_per_item_usd: costPerItem,
      mean_ci95: ci
        ? { lo: ci[0], hi: ci[1], iterations: 1000, seed: 1 }
        : { lo: 0, hi: 0, iterations: 0, seed: 1 },
    },
    ...rest,
  } as BenchRunSummary;
}

describe("bestByValue", () => {
  it("takes the cheapest model the benchmark cannot tell apart from the best", () => {
    const winners = bestByValue([
      // Best mean, but its interval reaches down to 4.35 — the cheap model's
      // 4.40 sits inside it, so the two are not distinguishable and price wins.
      benchRun({
        runId: "a",
        modelId: "google:expensive",
        meanScore: 4.6,
        costPerItem: 0.02,
        ci: [4.35, 4.85],
      }),
      benchRun({ runId: "b", modelId: "google:cheap", meanScore: 4.4, costPerItem: 0.002 }),
      benchRun({
        runId: "c",
        step: "fit",
        modelId: "google:only-one",
        meanScore: 4.0,
        costPerItem: 0.001,
        ci: [3.8, 4.2],
      }),
    ]);

    expect(winners).toEqual([
      expect.objectContaining({ step: "fit", modelId: "google:only-one", runId: "c" }),
      expect.objectContaining({
        step: "tailor",
        modelId: "google:cheap",
        runId: "b",
        bestMeanScore: 4.6,
        contenders: 2,
      }),
    ]);
  });

  it("keeps the better model when the cheap one is measurably worse", () => {
    const winners = bestByValue([
      benchRun({
        runId: "a",
        modelId: "google:good",
        meanScore: 4.6,
        costPerItem: 0.02,
        ci: [4.5, 4.7],
      }),
      // 10x cheaper, but 3.2 is well below the best model's lower bound: a
      // pure score-per-dollar ratio would pick this, and it should not.
      benchRun({ runId: "b", modelId: "google:cheap-and-bad", meanScore: 3.2, costPerItem: 0.002 }),
    ]);

    expect(winners).toEqual([
      expect.objectContaining({ modelId: "google:good", runId: "a", contenders: 1 }),
    ]);
  });

  it("ignores a run that scored nothing — a model with no results has no value", () => {
    const winners = bestByValue([
      benchRun({ runId: "dead", modelId: "anthropic:billing-blocked", n: 0, meanScore: 0, costPerItem: 0 }),
      benchRun({ runId: "live", modelId: "google:gemini-3.7-flash", meanScore: 4.4 }),
    ]);

    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({ modelId: "google:gemini-3.7-flash", runId: "live" });
  });

  it("trusts only the best model itself when the run recorded no interval", () => {
    const winners = bestByValue([
      benchRun({ runId: "a", modelId: "google:best", meanScore: 4.6, costPerItem: 0.02, ci: null }),
      benchRun({ runId: "b", modelId: "google:cheap", meanScore: 4.5, costPerItem: 0.002, ci: null }),
    ]);

    expect(winners[0]).toMatchObject({ modelId: "google:best", contenders: 1 });
  });
});

describe("renderBenchTable", () => {
  it("renders one aligned line per run, with an em dash for a run that scored nothing", () => {
    const table = renderBenchTable([
      benchRun({ runId: "a", modelId: "google:gemini-3.7-flash", meanScore: 4.5 }),
      benchRun({
        runId: "b",
        step: "fit",
        modelId: "anthropic:claude-haiku-4-5",
        n: 0,
        failedItems: 3,
        meanScore: 0,
      }),
    ]);
    const lines = table.split("\n");

    expect(lines[0]).toContain("$/item");
    expect(lines).toHaveLength(4); // header + rule + two runs
    expect(lines[2]).toContain("4.50");
    expect(lines[2]).toContain("$0.01000");
    expect(lines[3]).toContain("anthropic:claude-haiku-4-5");
    expect(lines[3]).toContain("—");
    // Every line is padded to the same width.
    expect(new Set(lines.map((l) => l.length)).size).toBe(1);
  });
});

describe("BENCH_STEPS", () => {
  it("covers exactly the four steps spec §8 benchmarks", () => {
    expect([...BENCH_STEPS]).toEqual(["analyze", "fit", "tailor", "suggest"]);
  });
});
