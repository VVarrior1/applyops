import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseWorkdayPostedOn,
  parseWorkdayUrl,
  splitWorkdaySlug,
  workdayFinder,
} from "../../src/finders/workday";

const FIXTURES = path.join(__dirname, "fixtures");
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name), "utf8");

/** Serves recorded bodies by URL substring; anything unmatched is a 404 (same
 * convention as adapters.test.ts's `stubFetch`). */
function stubFetch(routes: Array<[string, string, number?]>) {
  const seen: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      const hit = routes.find(([frag]) => url.includes(frag));
      if (!hit) return new Response("not found", { status: 404 });
      return new Response(hit[1], { status: hit[2] ?? 200 });
    }),
  );
  return seen;
}

afterEach(() => vi.unstubAllGlobals());

describe("parseWorkdayPostedOn", () => {
  const now = new Date("2026-08-27T12:00:00.000Z");

  it("parses 'Posted Today' as now", () => {
    expect(parseWorkdayPostedOn("Posted Today", now)).toEqual(now);
  });

  it("parses 'Posted 3 Days Ago' as now minus 3 days", () => {
    expect(parseWorkdayPostedOn("Posted 3 Days Ago", now)?.toISOString()).toBe(
      "2026-08-24T12:00:00.000Z",
    );
  });

  it("parses 'Posted 30+ Days Ago' as now minus 30 days", () => {
    expect(parseWorkdayPostedOn("Posted 30+ Days Ago", now)?.toISOString()).toBe(
      "2026-07-28T12:00:00.000Z",
    );
  });

  it("parses 'Posted Yesterday' as now minus 1 day", () => {
    expect(parseWorkdayPostedOn("Posted Yesterday", now)?.toISOString()).toBe(
      "2026-08-26T12:00:00.000Z",
    );
  });

  it("returns null for missing or unrecognised phrasing", () => {
    expect(parseWorkdayPostedOn(undefined, now)).toBeNull();
    expect(parseWorkdayPostedOn(null, now)).toBeNull();
    expect(parseWorkdayPostedOn("", now)).toBeNull();
    expect(parseWorkdayPostedOn("Open until filled", now)).toBeNull();
  });
});

describe("splitWorkdaySlug", () => {
  it("splits 'tenant/site'", () => {
    expect(splitWorkdaySlug("suncor/Suncor_External")).toEqual({
      tenant: "suncor",
      site: "Suncor_External",
    });
  });

  it("splits a site that itself contains slashes, keeping the rest as the site", () => {
    expect(splitWorkdaySlug("tcenergy/CAREER_SITE_TC")).toEqual({
      tenant: "tcenergy",
      site: "CAREER_SITE_TC",
    });
  });

  it("throws on a slug with no '/'", () => {
    expect(() => splitWorkdaySlug("suncor")).toThrow();
  });

  it("throws on an empty tenant or site", () => {
    expect(() => splitWorkdaySlug("/Suncor_External")).toThrow();
    expect(() => splitWorkdaySlug("suncor/")).toThrow();
  });
});

describe("parseWorkdayUrl", () => {
  it("recovers tenant/host/site from a bare board URL", () => {
    expect(parseWorkdayUrl("https://suncor.wd1.myworkdayjobs.com/Suncor_External")).toEqual({
      tenant: "suncor",
      host: "wd1",
      site: "Suncor_External",
    });
  });

  it("recovers tenant/host/site from a deep job-posting URL with a locale segment", () => {
    expect(
      parseWorkdayUrl(
        "https://tcenergy.wd3.myworkdayjobs.com/en-US/CAREER_SITE_TC/job/Calgary-Alberta/Automation-Engineer_JR-10643",
      ),
    ).toEqual({ tenant: "tcenergy", host: "wd3", site: "CAREER_SITE_TC" });
  });

  it("returns null for a non-Workday host", () => {
    expect(parseWorkdayUrl("https://jobs.lever.co/spotify")).toBeNull();
    expect(parseWorkdayUrl("not a url at all")).toBeNull();
  });
});

describe("workdayFinder.fetchJobs", () => {
  it("maps postings to RawJob, fetching detail only for the relevant title", async () => {
    const seen = stubFetch([
      [
        "wday/cxs/tcenergy/CAREER_SITE_TC/job/Calgary-Alberta/Automation-Engineer_JR-10643",
        fixture("workday.tcenergy.detail.json"),
      ],
      ["wday/cxs/tcenergy/CAREER_SITE_TC/jobs", fixture("workday.tcenergy.jobs.json")],
    ]);

    const jobs = await workdayFinder.fetchJobs("tcenergy/CAREER_SITE_TC");

    expect(jobs).toHaveLength(2);

    // Exactly one list request and one detail request — the irrelevant title
    // ("Talent Acquisition Coordinator") must not trigger a detail fetch.
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe("https://tcenergy.wd3.myworkdayjobs.com/wday/cxs/tcenergy/CAREER_SITE_TC/jobs");
    expect(seen[1]).toBe(
      "https://tcenergy.wd3.myworkdayjobs.com/wday/cxs/tcenergy/CAREER_SITE_TC/job/Calgary-Alberta/Automation-Engineer_JR-10643",
    );

    const engineer = jobs.find((j) => j.title === "Automation Engineer");
    expect(engineer).toBeDefined();
    expect(engineer!.externalId).toBe("Automation-Engineer_JR-10643");
    expect(engineer!.url).toBe(
      "https://tcenergy.wd3.myworkdayjobs.com/CAREER_SITE_TC/job/Calgary-Alberta/Automation-Engineer_JR-10643",
    );
    expect(engineer!.location).toBe("Calgary, Alberta");
    expect(engineer!.remote).toBe(false);
    // Description came from the detail fetch (HTML stripped, entity decoded).
    expect(engineer!.description).toContain("Determined, imaginative, curious—if these");
    expect(engineer!.description).not.toMatch(/<\/?[a-z][^>]*>/i);
    expect(engineer!.postedAt).not.toBeNull();

    const coordinator = jobs.find((j) => j.title === "Talent Acquisition Coordinator");
    expect(coordinator).toBeDefined();
    // No detail fetch happened for this one, so the description falls back to the title.
    expect(coordinator!.description).toBe("Talent Acquisition Coordinator");
    expect(coordinator!.externalId).toBe("Talent-Acquisition-Coordinator_JR-99999");
    expect(coordinator!.postedAt).not.toBeNull();
  });

  it("returns [] for a tenant/site with no postings", async () => {
    stubFetch([
      ["wday/cxs/tcenergy/CAREER_SITE_TC/jobs", JSON.stringify({ total: 0, jobPostings: [] })],
    ]);
    expect(await workdayFinder.fetchJobs("tcenergy/CAREER_SITE_TC")).toEqual([]);
  });
});
