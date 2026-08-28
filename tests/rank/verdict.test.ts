import { describe, expect, it } from "vitest";
import { countsAsApplied } from "../../src/rank/candidates";
import { assessJob, hardPreferenceConflict, type VerdictInput } from "../../src/rank/verdict";

const NOW = new Date("2026-08-28T12:00:00Z");
const base: VerdictInput = {
  job: {
    title: "Software Engineer, New Grad",
    remote: true,
    countries: ["CA", "US"],
    postedAt: new Date("2026-08-20T00:00:00Z"),
    lastSeenAt: new Date("2026-08-28T00:00:00Z"),
    active: true,
    isEntryLevel: true,
    isRelevantRole: true,
    workAuthSignal: "unclear",
    location: "Remote - Canada",
  },
  analysis: { seniority: "new_grad", years_min: 0, requirements: [] },
  fitScore: 62,
  prefs: { countries: ["CA", "US"], workAuth: "canada", remote: "any", locations: ["Calgary, AB", "Remote"] },
  alreadyApplied: false,
  now: NOW,
};

describe("assessJob", () => {
  it("says apply for a fresh, in-country, entry-level role with a good fit", () => {
    const v = assessJob(base);
    expect(v.verdict).toBe("apply");
    expect(v.reasons).toEqual([]);
  });

  it("skips roles restricted to a country outside the user's list", () => {
    const v = assessJob({ ...base, job: { ...base.job, countries: ["MX"], location: "Remote - Mexico" } });
    expect(v.verdict).toBe("skip");
    expect(v.reasons.join(" ")).toMatch(/Mexico/);
  });

  it("skips US-auth-without-sponsorship roles for a Canadian applicant", () => {
    const v = assessJob({ ...base, job: { ...base.job, workAuthSignal: "needs_us_auth" } });
    expect(v.verdict).toBe("skip");
    expect(v.reasons.join(" ")).toMatch(/US work authorization/);
  });

  it("does not penalise needs_us_auth when the user already has US authorization", () => {
    const v = assessJob({ ...base, job: { ...base.job, workAuthSignal: "needs_us_auth" }, prefs: { ...base.prefs!, workAuth: "us_citizen_pr" } });
    expect(v.verdict).toBe("apply");
  });

  it("skips when the posting wants 3+ years or a senior title", () => {
    expect(assessJob({ ...base, analysis: { ...base.analysis!, years_min: 4 } }).verdict).toBe("skip");
    expect(assessJob({ ...base, job: { ...base.job, title: "Senior Software Engineer" } }).verdict).toBe("skip");
  });

  it("skips stale or inactive postings, flags older ones as maybe", () => {
    expect(assessJob({ ...base, job: { ...base.job, postedAt: new Date("2026-06-01T00:00:00Z") } }).verdict).toBe("skip");
    expect(assessJob({ ...base, job: { ...base.job, active: false } }).verdict).toBe("skip");
    const v = assessJob({ ...base, job: { ...base.job, postedAt: new Date("2026-08-01T00:00:00Z") } });
    expect(v.verdict).toBe("maybe");
    expect(v.reasons.join(" ")).toMatch(/27 days/);
  });

  it("uses the fit score when present: low → skip, middling → maybe", () => {
    expect(assessJob({ ...base, fitScore: 20 }).verdict).toBe("skip");
    expect(assessJob({ ...base, fitScore: 45 }).verdict).toBe("maybe");
  });

  it("is maybe (not apply) when unscored, and says so", () => {
    const v = assessJob({ ...base, fitScore: null });
    expect(v.verdict).toBe("maybe");
    expect(v.reasons.join(" ")).toMatch(/not scored/i);
  });

  it("is maybe for onsite roles outside the user's locations", () => {
    const v = assessJob({ ...base, job: { ...base.job, remote: false, location: "Toronto, ON", countries: ["CA"] } });
    expect(v.verdict).toBe("maybe");
    expect(v.reasons.join(" ")).toMatch(/onsite/i);
  });

  it("skips jobs already applied to", () => {
    expect(assessJob({ ...base, alreadyApplied: true }).verdict).toBe("skip");
  });

  it("derives alreadyApplied from the applications row set the way app/(app)/jobs/[id]/page.tsx does — withdrawn-only doesn't block, rejected still does", () => {
    // Mirrors `appliedRows.some((row) => countsAsApplied(row.status))` from
    // app/(app)/jobs/[id]/page.tsx: at most one `applications` row exists
    // per user+job (applications_user_job_uq), but the derivation has to
    // treat a withdrawn row as not-applied regardless of row count.
    const withdrawnOnly = [{ status: "withdrawn" }];
    const rejected = [{ status: "rejected" }];

    const withdrawnVerdict = assessJob({
      ...base,
      alreadyApplied: withdrawnOnly.some((row) => countsAsApplied(row.status)),
    });
    expect(withdrawnVerdict.verdict).toBe("apply");

    const rejectedVerdict = assessJob({
      ...base,
      alreadyApplied: rejected.some((row) => countsAsApplied(row.status)),
    });
    expect(rejectedVerdict.verdict).toBe("skip");
    expect(rejectedVerdict.reasons.join(" ")).toMatch(/already applied/i);
  });

  it("orders reasons hard-blockers first and never duplicates", () => {
    const v = assessJob({ ...base, job: { ...base.job, countries: ["AR"], workAuthSignal: "needs_us_auth" }, fitScore: 10 });
    expect(v.verdict).toBe("skip");
    expect(new Set(v.reasons).size).toBe(v.reasons.length);
    expect(v.reasons[0]).toMatch(/Argentina|US work authorization/);
  });

  it("skips a concrete place it cannot map to a country, but not a bare Remote", () => {
    const v = assessJob({ ...base, job: { ...base.job, countries: [], location: "Ouagadougou Office", remote: false } });
    expect(v.verdict).toBe("skip");
    expect(v.reasons[0]).toMatch(/Ouagadougou/);
    const r = assessJob({ ...base, job: { ...base.job, countries: [], location: "Remote", remote: true } });
    expect(r.verdict).toBe("apply");
  });
});

describe("hardPreferenceConflict", () => {
  const job = { remote: false, location: "Research Triangle Park, NC", companyName: "Cisco" };
  const prefs = { remote: "any" as const, locations: ["Calgary, AB", "Remote"], excludedCompanies: [] };

  it("flags an onsite posting outside every location the candidate named", () => {
    const reason = hardPreferenceConflict({ job, prefs });
    expect(reason).toMatch(/Research Triangle Park, NC/);
    expect(reason).toMatch(/not one of your locations/);
  });

  it("is silent when the posting is in one of the candidate's locations", () => {
    expect(hardPreferenceConflict({ job: { ...job, location: "Calgary, AB" }, prefs })).toBeNull();
  });

  it("is silent when remote and the candidate listed Remote", () => {
    expect(hardPreferenceConflict({ job: { ...job, remote: true }, prefs })).toBeNull();
  });

  it("flags a remote-only candidate against an onsite posting", () => {
    const reason = hardPreferenceConflict({ job, prefs: { ...prefs, remote: "remote" } });
    expect(reason).toMatch(/only interested in remote/);
  });

  it("flags an onsite-only candidate against a remote posting", () => {
    const reason = hardPreferenceConflict({ job: { ...job, remote: true }, prefs: { ...prefs, remote: "onsite" } });
    expect(reason).toMatch(/only interested in onsite/);
  });

  it("flags an excluded company regardless of location", () => {
    const reason = hardPreferenceConflict({
      job: { ...job, location: "Calgary, AB" },
      prefs: { ...prefs, excludedCompanies: ["cisco"] },
    });
    expect(reason).toMatch(/excluded-companies list/);
  });

  it("is silent when the candidate never set a locations preference", () => {
    expect(hardPreferenceConflict({ job, prefs: { ...prefs, locations: [] } })).toBeNull();
  });

  it("is silent with no prefs on file at all", () => {
    expect(hardPreferenceConflict({ job, prefs: null })).toBeNull();
  });
});
