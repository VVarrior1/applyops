import { describe, it, expect, vi } from "vitest";
import { applications, jobs, outcomeEvents, profiles } from "../../src/db/schema";
import type { Db } from "../../src/db/client";
import { computeGateStatus, loadPublicResults } from "../../src/funnel/public-results";
import type { EvalRunListItem } from "../../src/eval/runner";

// `loadPublicResults` also reads `eval_runs` via `listEvalRuns` — out of
// scope for the placeholder-filter test below, so it's stubbed to "no runs"
// rather than modelled in the fake `Db`.
vi.mock("../../src/eval/runner", () => ({ listEvalRuns: vi.fn(async () => []) }));

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

/**
 * A fake `Db` covering exactly the tables `loadPublicResults` touches
 * (`profiles`, the `applications`/`jobs`/`generations`/`promptVersions`
 * join, `outcome_events`, and the `jobs`/`companies` lookup for recent
 * applications). The `applications`+`jobs` join applies the real
 * `is_placeholder = false` filter itself — mirroring, at the JS level, the
 * SQL `tests/funnel/query.test.ts` separately proves `ownerApplicationRows`
 * actually generates — so this test's job is verifying `loadPublicResults`
 * never re-surfaces an excluded application through some other path (e.g.
 * the separate `jobs` lookup below), not re-proving the SQL exists.
 */
function fakeResultsDb(fixture: {
  ownerId: string;
  applicationRows: { id: string; userId: string; jobId: string; createdAt: Date }[];
  jobRows: { id: string; title: string; companyId: string | null; isPlaceholder: boolean }[];
  companyRows: { id: string; name: string }[];
  eventRows: { applicationId: string; type: string; occurredAt: Date }[];
}) {
  const db = {
    select() {
      return {
        from(table: unknown) {
          if (table === profiles) {
            return { where: () => ({ limit: async () => [{ userId: fixture.ownerId }] }) };
          }
          if (table === applications) {
            return {
              innerJoin: () => ({
                leftJoin: () => ({
                  leftJoin: () => ({
                    where: async () =>
                      fixture.applicationRows
                        .filter((a) => a.userId === fixture.ownerId)
                        .filter((a) => fixture.jobRows.some((j) => j.id === a.jobId && !j.isPlaceholder))
                        .map((a) => ({ id: a.id, createdAt: a.createdAt, jobId: a.jobId, promptVersion: null })),
                  }),
                }),
              }),
            };
          }
          if (table === outcomeEvents) {
            return { where: async () => fixture.eventRows };
          }
          if (table === jobs) {
            return {
              leftJoin: () => ({
                where: async () =>
                  fixture.jobRows.map((j) => ({
                    id: j.id,
                    title: j.title,
                    companyName: fixture.companyRows.find((c) => c.id === j.companyId)?.name ?? null,
                  })),
              }),
            };
          }
          throw new Error(`fakeResultsDb: unexpected table in select().from()`);
        },
      };
    },
  };
  return db as unknown as Db;
}

describe("loadPublicResults", () => {
  it("excludes an application on an isPlaceholder job from both the funnel and recent applications", async () => {
    const db = fakeResultsDb({
      ownerId: "owner-1",
      jobRows: [
        { id: "job-real", title: "Backend Engineer", companyId: "co-1", isPlaceholder: false },
        { id: "job-orphan", title: "Unknown position (v1 job abc)", companyId: "co-2", isPlaceholder: true },
      ],
      companyRows: [
        { id: "co-1", name: "Real Co" },
        { id: "co-2", name: "Unknown (v1 orphaned job)" },
      ],
      applicationRows: [
        { id: "app-real", userId: "owner-1", jobId: "job-real", createdAt: new Date("2026-08-01T00:00:00Z") },
        { id: "app-orphan", userId: "owner-1", jobId: "job-orphan", createdAt: new Date("2025-11-01T00:00:00Z") },
      ],
      eventRows: [
        { applicationId: "app-real", type: "applied", occurredAt: new Date("2026-08-01T00:00:00Z") },
        { applicationId: "app-orphan", type: "applied", occurredAt: new Date("2025-11-01T00:00:00Z") },
      ],
    });

    const results = await loadPublicResults(db);

    expect(results).not.toBeNull();
    const totalApplied = results!.funnelByWeek.reduce((sum, row) => sum + row.applied, 0);
    expect(totalApplied).toBe(1); // only the real job's application counted
    expect(results!.recentApplications).toHaveLength(1);
    expect(results!.recentApplications[0]?.roleFamily).not.toMatch(/unknown/i);
  });

  it("returns null when there is no owner profile", async () => {
    const db = {
      select() {
        return { from: () => ({ where: () => ({ limit: async () => [] }) }) };
      },
    } as unknown as Db;

    const results = await loadPublicResults(db);
    expect(results).toBeNull();
  });
});
