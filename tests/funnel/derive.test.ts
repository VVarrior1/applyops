import { describe, it, expect } from "vitest";
import {
  deriveFunnel,
  wilson95,
  currentStage,
  stageForEventType,
  type FunnelApplication,
} from "../../src/funnel/derive";

/** Builds a minimal `FunnelApplication` for the tests below. */
function app(
  id: string,
  createdAt: string,
  promptVersion: string | null,
  events: { type: FunnelApplication["events"][number]["type"]; occurredAt: string }[],
): FunnelApplication {
  return {
    id,
    createdAt: new Date(createdAt),
    promptVersion,
    events: events.map((e) => ({ type: e.type, occurredAt: new Date(e.occurredAt) })),
  };
}

describe("deriveFunnel", () => {
  it("4 apps: 2 responded, 1 interview, 1 ghosted -> responseRate 0.5, interviewRate 0.25, Wilson CI within [0,1] and containing 0.5", () => {
    const apps: FunnelApplication[] = [
      app("a1", "2026-08-01T00:00:00Z", "tailor@1", [
        { type: "applied", occurredAt: "2026-08-01T00:00:00Z" },
        { type: "response", occurredAt: "2026-08-03T00:00:00Z" },
      ]),
      app("a2", "2026-08-01T00:00:00Z", "tailor@1", [
        { type: "applied", occurredAt: "2026-08-01T00:00:00Z" },
        { type: "response", occurredAt: "2026-08-04T00:00:00Z" },
      ]),
      app("a3", "2026-08-01T00:00:00Z", "tailor@1", [
        { type: "applied", occurredAt: "2026-08-01T00:00:00Z" },
        { type: "response", occurredAt: "2026-08-03T00:00:00Z" },
        { type: "interview", occurredAt: "2026-08-10T00:00:00Z" },
      ]),
      app("a4", "2026-08-01T00:00:00Z", "tailor@1", [
        { type: "applied", occurredAt: "2026-08-01T00:00:00Z" },
        { type: "ghosted", occurredAt: "2026-08-20T00:00:00Z" },
      ]),
    ];

    const [row] = deriveFunnel(apps, { groupBy: "all" });

    expect(row.applied).toBe(4);
    expect(row.responded).toBe(2);
    expect(row.interviewing).toBe(1);
    expect(row.offers).toBe(0);
    expect(row.rejected).toBe(0);
    expect(row.ghosted).toBe(1);
    expect(row.responseRate).toBe(0.5);
    expect(row.interviewRate).toBe(0.25);

    const [lower, upper] = row.responseRateCi95;
    expect(lower).toBeGreaterThanOrEqual(0);
    expect(upper).toBeLessThanOrEqual(1);
    expect(lower).toBeLessThanOrEqual(0.5);
    expect(upper).toBeGreaterThanOrEqual(0.5);
  });

  it("groups by week using ISO week keys, one row per distinct week", () => {
    const apps: FunnelApplication[] = [
      app("a1", "2026-08-26T00:00:00Z", null, []), // ISO week 2026-W35 (Tue)
      app("a2", "2026-08-30T00:00:00Z", null, []), // same ISO week (Sat)
      app("a3", "2026-09-07T00:00:00Z", null, []), // ISO week 2026-W36
    ];

    const rows = deriveFunnel(apps, { groupBy: "week" });

    expect(rows.map((r) => r.key)).toEqual(["2026-W35", "2026-W36"]);
    expect(rows[0].applied).toBe(2);
    expect(rows[1].applied).toBe(1);
  });

  it("groups by prompt_version, with null promptVersion bucketed as 'unknown'", () => {
    const apps: FunnelApplication[] = [
      app("a1", "2026-08-01T00:00:00Z", "tailor@2", []),
      app("a2", "2026-08-02T00:00:00Z", "tailor@1", []),
      app("a3", "2026-08-03T00:00:00Z", null, []),
    ];

    const rows = deriveFunnel(apps, { groupBy: "prompt_version" });

    expect(rows.map((r) => r.key)).toEqual(["tailor@1", "tailor@2", "unknown"]);
  });

  it("groupBy 'all' collapses every application into a single row", () => {
    const apps: FunnelApplication[] = [
      app("a1", "2026-08-01T00:00:00Z", "v1", []),
      app("a2", "2026-09-01T00:00:00Z", "v2", []),
    ];

    const rows = deriveFunnel(apps, { groupBy: "all" });

    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("all");
    expect(rows[0].applied).toBe(2);
  });

  it("an application with no events sits in the applied stage (not counted as responded/interviewing/etc.)", () => {
    const rows = deriveFunnel([app("a1", "2026-08-01T00:00:00Z", null, [])], {
      groupBy: "all",
    });

    expect(rows[0]).toMatchObject({
      applied: 1,
      responded: 0,
      interviewing: 0,
      offers: 0,
      rejected: 0,
      ghosted: 0,
      responseRate: 0,
      interviewRate: 0,
    });
  });

  it("an empty group list produces no rows", () => {
    expect(deriveFunnel([], { groupBy: "all" })).toEqual([]);
  });
});

describe("currentStage / stageForEventType", () => {
  it("maps each outcome event type to its funnel stage", () => {
    expect(stageForEventType("applied")).toBe("applied");
    expect(stageForEventType("viewed")).toBe("applied");
    expect(stageForEventType("response")).toBe("responded");
    expect(stageForEventType("oa")).toBe("responded");
    expect(stageForEventType("phone_screen")).toBe("interviewing");
    expect(stageForEventType("interview")).toBe("interviewing");
    expect(stageForEventType("offer")).toBe("offer");
    expect(stageForEventType("rejected")).toBe("rejected");
    expect(stageForEventType("ghosted")).toBe("ghosted");
    expect(stageForEventType("withdrawn")).toBe("withdrawn");
  });

  it("uses the most recent event by occurredAt, not insertion order", () => {
    const events: FunnelApplication["events"] = [
      { type: "interview", occurredAt: new Date("2026-08-10T00:00:00Z") },
      { type: "rejected", occurredAt: new Date("2026-08-20T00:00:00Z") },
    ];
    expect(currentStage(events)).toBe("rejected");

    // Out-of-order input (e.g. a backdated event logged after the fact via
    // `--at`) still resolves to the chronologically latest one.
    const backdated: FunnelApplication["events"] = [
      { type: "rejected", occurredAt: new Date("2026-08-20T00:00:00Z") },
      { type: "interview", occurredAt: new Date("2026-08-10T00:00:00Z") },
    ];
    expect(currentStage(backdated)).toBe("rejected");
  });

  it("defaults to 'applied' with no events", () => {
    expect(currentStage([])).toBe("applied");
  });
});

describe("wilson95", () => {
  it("returns [0, 0] for zero total", () => {
    expect(wilson95(0, 0)).toEqual([0, 0]);
  });

  it("stays within [0, 1] and centers roughly on the observed rate", () => {
    const [lower, upper] = wilson95(2, 4);
    expect(lower).toBeGreaterThan(0);
    expect(upper).toBeLessThan(1);
    expect(lower).toBeLessThan(0.5);
    expect(upper).toBeGreaterThan(0.5);
  });

  it("narrows as the sample size grows", () => {
    const small = wilson95(5, 10);
    const large = wilson95(500, 1000);
    expect(large[1] - large[0]).toBeLessThan(small[1] - small[0]);
  });

  it("never goes below 0 or above 1 at the extremes", () => {
    expect(wilson95(0, 5)).toEqual([0, expect.any(Number)]);
    const [, upperAtZero] = wilson95(0, 5);
    expect(upperAtZero).toBeLessThanOrEqual(1);

    const [lowerAtFull] = wilson95(5, 5);
    expect(lowerAtFull).toBeGreaterThanOrEqual(0);
    expect(wilson95(5, 5)[1]).toBeLessThanOrEqual(1);
  });
});
