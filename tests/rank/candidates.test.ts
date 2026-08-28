import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  appliedJobIds,
  CANDIDATE_STALE_AFTER_DAYS,
  candidateConditions,
  countryOverlapCondition,
  countryUnknownCondition,
  countsAsApplied,
} from "../../src/rank/candidates";

const dialect = new PgDialect();

describe("candidateConditions", () => {
  it("returns 3 conditions for a Canadian user with a countries preference", () => {
    const conditions = candidateConditions({ countries: ["CA", "US"], workAuth: "canada" });
    expect(conditions).toHaveLength(3);
  });

  it("returns one fewer condition when countries is empty (anywhere)", () => {
    const conditions = candidateConditions({ countries: [], workAuth: "canada" });
    expect(conditions).toHaveLength(2);
  });

  it("also skips the country condition when countries is null", () => {
    const conditions = candidateConditions({ countries: null, workAuth: "canada" });
    expect(conditions).toHaveLength(2);
  });

  it("skips the needs_us_auth exclusion for a user who already has US work authorization", () => {
    const withCountries = candidateConditions({ countries: ["CA", "US"], workAuth: "us_citizen_pr" });
    expect(withCountries).toHaveLength(2); // country overlap + staleness, no work-auth block

    const tnEligible = candidateConditions({ countries: [], workAuth: "tn_eligible" });
    expect(tnEligible).toHaveLength(1); // staleness only
  });

  it("treats a null prefs row the same as no countries and no US authorization", () => {
    const conditions = candidateConditions(null);
    expect(conditions).toHaveLength(2); // work-auth block (missing => lacks auth) + staleness
  });

  it("treats a missing/needs_sponsorship workAuth as lacking US authorization", () => {
    expect(candidateConditions({ countries: [], workAuth: null })).toHaveLength(2);
    expect(candidateConditions({ countries: [], workAuth: "needs_sponsorship" })).toHaveLength(2);
  });

  it("always includes the staleness condition regardless of prefs", () => {
    const rendered = dialect.sqlToQuery(candidateConditions(null)[candidateConditions(null).length - 1]);
    expect(rendered.sql).toContain(`interval '${CANDIDATE_STALE_AFTER_DAYS} days'`);
    expect(rendered.sql).toContain("posted_at");
  });
});

describe("countryOverlapCondition", () => {
  it("binds the wanted countries as a single parameterized text[] value, not inlined SQL", () => {
    const rendered = dialect.sqlToQuery(countryOverlapCondition(["CA", "US"]));
    expect(rendered.sql).not.toContain("CA");
    expect(rendered.sql).not.toContain("US");
    expect(rendered.sql).toMatch(/&&\s*\$1::text\[\]/);
    expect(rendered.params).toHaveLength(1);
    expect(rendered.params[0]).toEqual(["CA", "US"]);
  });

  it("treats null/empty jobs.countries as allowed (unknown = anywhere)", () => {
    const rendered = dialect.sqlToQuery(countryOverlapCondition(["CA"]));
    expect(rendered.sql).toContain("is null");
    expect(rendered.sql).toContain("cardinality");
  });
});

describe("countryUnknownCondition", () => {
  it("renders a null-or-empty check with no bound parameters", () => {
    const rendered = dialect.sqlToQuery(countryUnknownCondition());
    expect(rendered.params).toHaveLength(0);
    expect(rendered.sql).toContain("is null");
    expect(rendered.sql).toContain("cardinality");
  });
});

describe("countsAsApplied", () => {
  it("withdrawn does not count as applied — the job must reappear on /jobs", () => {
    expect(countsAsApplied("withdrawn")).toBe(false);
  });

  it("draft does not count as applied", () => {
    expect(countsAsApplied("draft")).toBe(false);
  });

  it("every other status counts as applied, including terminal ones", () => {
    for (const status of ["applied", "responded", "interviewing", "offer", "rejected", "ghosted"]) {
      expect(countsAsApplied(status)).toBe(true);
    }
  });
});

describe("appliedJobIds", () => {
  // Covers the actual call sites the original regression lived in —
  // app/(app)/jobs/page.tsx's appliedJobIds (feeding both the notInArray
  // exclusion and each row's alreadyApplied) — rather than only the pure
  // countsAsApplied helper.
  it("excludes a job whose only applications row is withdrawn", () => {
    const rows = [{ jobId: "job-1", status: "withdrawn" }];
    expect(appliedJobIds(rows)).toEqual(new Set());
  });

  it("excludes a job whose only applications row is still draft", () => {
    const rows = [{ jobId: "job-1", status: "draft" }];
    expect(appliedJobIds(rows)).toEqual(new Set());
  });

  it("includes a job whose applications row is rejected — that still counts as applied", () => {
    const rows = [{ jobId: "job-1", status: "rejected" }];
    expect(appliedJobIds(rows)).toEqual(new Set(["job-1"]));
  });

  it("handles a mix of jobs across statuses independently", () => {
    const rows = [
      { jobId: "job-applied", status: "applied" },
      { jobId: "job-withdrawn", status: "withdrawn" },
      { jobId: "job-rejected", status: "rejected" },
      { jobId: "job-draft", status: "draft" },
    ];
    expect(appliedJobIds(rows)).toEqual(new Set(["job-applied", "job-rejected"]));
  });

  it("returns an empty set for no rows", () => {
    expect(appliedJobIds([])).toEqual(new Set());
  });
});
