import { describe, expect, it, vi } from "vitest";
import type { Db } from "../../src/db/client";
import type { AnalyzeOutput, FitOutput } from "../../src/pipeline/schemas";
import { BudgetExceededError, type BudgetDecision } from "../../src/llm/budget";
import type { RankableJob } from "../../src/rank/rank";

/**
 * `rankForUser`'s real logic — candidate selection, the
 * `BudgetExceededError` break, the `skipped` counter, and "the keyword row
 * is written even when fit throws" — mocked the same way
 * `tests/pipeline/steps.test.ts` and `tests/agent/run.test.ts` fake a
 * drizzle surface, plus `vi.mock` on `runAnalyze`/`runFit` (the two real
 * LLM calls) and on `getPrefs`/`getConfirmedFacts` (their own DB reads,
 * irrelevant to what this file is testing).
 */
vi.mock("../../src/profile/facts", () => ({
  getConfirmedFacts: vi.fn(async () => []),
  getPrefs: vi.fn(async () => null),
}));

vi.mock("../../src/pipeline/steps", () => ({
  runAnalyze: vi.fn(),
  runFit: vi.fn(),
}));

import { runFit } from "../../src/pipeline/steps";
import { jobScores } from "../../src/db/schema";
import { pickFitScoreRow, rankForUser, scoreFit } from "../../src/rank/rank";
import type { SearchPrefsRow } from "../../src/profile/facts";

const ANALYSIS: AnalyzeOutput = {
  requirements: [{ text: "3 years of Go", must_have: true }],
  nice_to_have: ["Kubernetes"],
  seniority: "mid",
  years_min: 3,
  work_auth_signal: "unclear",
  keywords: ["go", "payments"],
  summary: "Backend role on the payments team.",
};

const FIT: FitOutput = {
  score: 64,
  matched: [{ requirement: "3 years of Go", fact_ids: ["F-001"] }],
  gaps: ["No Kubernetes"],
  rationale: "Strong payments signal, no infra work.",
};

/** Minimal, valid `StepResult<FitOutput>` — usage/latency are unused by `rankForUser`. */
function fitStepResult(generationId: string, costUsd: number) {
  return {
    output: FIT,
    generationId,
    usage: { inputTokens: 100, outputTokens: 50 },
    costUsd,
    latencyMs: 10,
  };
}

function job(id: string): RankableJob {
  return {
    id,
    title: `Job ${id}`,
    companyName: "Acme",
    atsVendor: "greenhouse",
    // Remote + no geography always satisfies `isPreferredLocation` with no
    // prefs on file (the mocked `getPrefs` above), regardless of location
    // logic — not what this file is testing.
    location: "Remote",
    remote: true,
    description: "Backend role.",
    // Pre-cached so `ensureAnalysis` never calls the mocked `runAnalyze` or
    // writes to `jobs` — this file is about the ranking loop, not analysis.
    analysis: ANALYSIS,
    postedAt: new Date("2026-08-20T00:00:00Z"),
    scrapedAt: new Date("2026-08-20T00:00:00Z"),
  };
}

/**
 * Fake drizzle surface for `rankForUser`'s own two queries:
 *   1. the id-only candidate pool: `.select(...).from().leftJoin().where().orderBy().limit()`
 *   2. the full-row fetch for the surviving ids: `.select(...).from().leftJoin().where()`
 * plus `jobScores` upserts: `.insert().values().onConflictDoUpdate()`.
 */
function fakeDb(candidates: RankableJob[]) {
  const scoreInserts: { table: unknown; values: Record<string, unknown> }[] = [];
  let selectCalls = 0;

  const db = {
    select() {
      selectCalls++;
      const isIdQuery = selectCalls % 2 === 1;
      const q = {
        from: () => q,
        leftJoin: () => q,
        where: () =>
          isIdQuery
            ? { orderBy: () => ({ limit: async () => candidates }) }
            : Promise.resolve(candidates),
      };
      return q;
    },
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown>) {
          return {
            onConflictDoUpdate: async () => {
              scoreInserts.push({ table, values });
            },
          };
        },
      };
    },
  };
  return { db: db as unknown as Db, scoreInserts };
}

function budgetDecision(): BudgetDecision {
  return {
    allowed: false,
    reason: "Daily budget spent.",
    spentToday: 1,
    dailyBudget: 1,
    estimate: 0.01,
    remainingUsd: 0,
  };
}

describe("rankForUser", () => {
  it("stops at a BudgetExceededError without incrementing skipped", async () => {
    const candidates = [job("j1"), job("j2"), job("j3")];
    const { db, scoreInserts } = fakeDb(candidates);
    const runFitMock = vi.mocked(runFit);
    runFitMock
      .mockResolvedValueOnce(fitStepResult("gen-1", 0.01))
      .mockRejectedValueOnce(new BudgetExceededError("Daily budget spent.", budgetDecision()));

    const result = await rankForUser(db, "user-1", { maxJobs: 3 });

    expect(result).toEqual({ scored: 1, skipped: 0, costUsd: 0.01 });
    // j1's fit-v1 + keyword-v1, j2's keyword-v1 only (fit threw before its
    // own upsert) — j3 never reached because the loop broke.
    expect(scoreInserts).toHaveLength(3);
    expect(scoreInserts.filter((i) => i.table === jobScores)).toHaveLength(3);
    expect(runFitMock).toHaveBeenCalledTimes(2);
  });

  it("counts a non-budget error as skipped and keeps scoring the rest", async () => {
    const candidates = [job("j1"), job("j2")];
    const { db } = fakeDb(candidates);
    const runFitMock = vi.mocked(runFit);
    runFitMock
      .mockRejectedValueOnce(new Error("schema validation failed"))
      .mockResolvedValueOnce(fitStepResult("gen-2", 0.02));

    const result = await rankForUser(db, "user-1", { maxJobs: 2 });

    expect(result).toEqual({ scored: 1, skipped: 1, costUsd: 0.02 });
  });

  it("reports the failure reason for a non-budget error via the log callback", async () => {
    const candidates = [job("j1")];
    const { db } = fakeDb(candidates);
    vi.mocked(runFit).mockRejectedValueOnce(new Error("provider unavailable"));
    const lines: string[] = [];

    const result = await rankForUser(db, "user-1", { maxJobs: 1, log: (line) => lines.push(line) });

    expect(result).toEqual({ scored: 0, skipped: 1, costUsd: 0 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("j1");
    expect(lines[0]).toContain("provider unavailable");
  });

  it("writes the keyword-v1 row before the fit call, so it survives a fit failure", async () => {
    const candidates = [job("j1")];
    const { db, scoreInserts } = fakeDb(candidates);
    vi.mocked(runFit).mockRejectedValueOnce(new Error("boom"));

    const result = await rankForUser(db, "user-1", { maxJobs: 1 });

    expect(result.skipped).toBe(1);
    expect(scoreInserts).toHaveLength(1);
    expect(scoreInserts[0].values).toMatchObject({ jobId: "j1", rankerVersion: "keyword-v1" });
  });
});

const PREFS: SearchPrefsRow = {
  userId: "user-1",
  roles: null,
  locations: ["Calgary, AB", "Remote"],
  remote: "any",
  seniority: null,
  workAuth: "canada",
  keywords: null,
  excludedCompanies: [],
  countries: ["CA", "US"],
};

describe("scoreFit", () => {
  it("clamps a score above 40 to 40 when the posting is onsite outside the candidate's locations", async () => {
    const { db } = fakeDb([]);
    vi.mocked(runFit).mockResolvedValueOnce(fitStepResult("gen-1", 0.01));

    const result = await scoreFit(
      db,
      "user-1",
      { ...job("j1"), remote: false, location: "Research Triangle Park, NC" },
      ANALYSIS,
      { facts: [], prefs: PREFS },
    );

    expect(result.output.score).toBe(40);
    // The rest of the model's output — matched/gaps/rationale — passes
    // through untouched; only the number the model got wrong is corrected.
    expect(result.output.matched).toEqual(FIT.matched);
    expect(result.output.rationale).toBe(FIT.rationale);
  });

  it("never raises a score, only ever caps it", async () => {
    const { db } = fakeDb([]);
    vi.mocked(runFit).mockResolvedValueOnce({ ...fitStepResult("gen-1", 0.01), output: { ...FIT, score: 12 } });

    const result = await scoreFit(
      db,
      "user-1",
      { ...job("j1"), remote: false, location: "Research Triangle Park, NC" },
      ANALYSIS,
      { facts: [], prefs: PREFS },
    );

    expect(result.output.score).toBe(12);
  });

  it("leaves the score untouched when nothing conflicts with the candidate's preferences", async () => {
    const { db } = fakeDb([]);
    vi.mocked(runFit).mockResolvedValueOnce(fitStepResult("gen-1", 0.01));

    const result = await scoreFit(db, "user-1", { ...job("j1"), remote: false, location: "Calgary, AB" }, ANALYSIS, {
      facts: [],
      prefs: PREFS,
    });

    expect(result.output.score).toBe(64);
  });
});

describe("pickFitScoreRow", () => {
  const CURRENT = "fit-v1:google:gemini-2.5-flash-lite";

  it("picks the current-version row when one exists, even if an older row is newer", () => {
    const older = { rankerVersion: CURRENT, createdAt: new Date("2026-01-01") };
    const newerButStale = { rankerVersion: "fit-v1:google:gemini-3.7-flash", createdAt: new Date("2026-06-01") };

    const result = pickFitScoreRow([newerButStale, older], CURRENT);

    expect(result).toEqual({ row: older, stale: false });
  });

  it("falls back to the newest older-version row when the current version was never scored — the real 6903598 scenario", () => {
    const oldest = { rankerVersion: "fit-v1:google:gemini-2.0-flash", createdAt: new Date("2025-06-01") };
    const stranded = { rankerVersion: "fit-v1:google:gemini-3.7-flash", createdAt: new Date("2026-06-01") };

    const result = pickFitScoreRow([oldest, stranded], CURRENT);

    expect(result).toEqual({ row: stranded, stale: true });
  });

  it("ignores the keyword-v1 row for both the current-version match and the fallback", () => {
    const keyword = { rankerVersion: "keyword-v1", createdAt: new Date("2026-06-01") };

    expect(pickFitScoreRow([keyword], CURRENT)).toBeNull();
  });

  it("returns null when no fit-v1 row exists at all", () => {
    expect(pickFitScoreRow([], CURRENT)).toBeNull();
  });
});
