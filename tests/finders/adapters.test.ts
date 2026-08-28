import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ashbyFinder } from "../../src/finders/ashby";
import { greenhouseFinder } from "../../src/finders/greenhouse";
import { stripHtml } from "../../src/finders/http";
import { leverFinder } from "../../src/finders/lever";
import { personioFinder } from "../../src/finders/personio";
import { recruiteeFinder } from "../../src/finders/recruitee";
import { smartrecruitersFinder } from "../../src/finders/smartrecruiters";
import type { RawJob } from "../../src/finders/types";
import { VendorRequiresKeyError } from "../../src/finders/types";
import { ycFinder } from "../../src/finders/yc";

/**
 * Every fixture in `fixtures/` is a real response, recorded once from the
 * vendor's public endpoint (Greenhouse `stripe`, Lever `spotify`, Ashby
 * `ramp`, Recruitee `11bitstudios`, Personio `bigpoint`, SmartRecruiters
 * `Ubisoft2`, YC `kalam-labs`) and trimmed to a couple of postings. They are
 * the contract these adapters are written against: if a vendor changes its
 * shape, re-record the fixture and the diff shows exactly what moved.
 */
const FIXTURES = path.join(__dirname, "fixtures");
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name), "utf8");

/** Serves recorded bodies by URL substring; anything unmatched is a 404. */
function stubFetch(routes: Array<[string, string, number?]>) {
  const seen: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      const hit = routes.find(([frag]) => url.includes(frag));
      if (!hit) {
        return new Response("not found", { status: 404 });
      }
      return new Response(hit[1], { status: hit[2] ?? 200 });
    }),
  );
  return seen;
}

afterEach(() => vi.unstubAllGlobals());

/** Every adapter must produce this much, for every posting it returns. */
function expectWellFormed(jobs: RawJob[]) {
  expect(jobs.length).toBeGreaterThan(0);
  for (const job of jobs) {
    expect(job.externalId).toBeTruthy();
    expect(job.url).toMatch(/^https:\/\//);
    expect(job.title.trim()).not.toBe("");
    expect(job.title).toBe(job.title.trim());
    expect(typeof job.remote).toBe("boolean");
    expect(job.description).not.toMatch(/<\/?[a-z][^>]*>/i);
    expect(job.description).not.toContain("&lt;");
    expect(job.description.trim()).not.toBe("");
    if (job.postedAt !== null) {
      expect(job.postedAt).toBeInstanceOf(Date);
      expect(Number.isNaN(job.postedAt.getTime())).toBe(false);
    }
  }
}

describe("stripHtml", () => {
  it("keeps prose and drops tags, entities, and embedded base64", () => {
    expect(stripHtml("&lt;p&gt;Hello &amp;amp; welcome&lt;/p&gt;")).toBe("Hello & welcome");
    expect(stripHtml("<p>Latency &lt;5ms</p>")).toBe("Latency <5ms");
    const withImage = `<p>Real text</p><img src="data:image/png;base64,${"QUJD".repeat(400)}">`;
    const cleaned = stripHtml(withImage);
    expect(cleaned).toBe("Real text");
    expect(cleaned).not.toContain("QUJD");
  });
});

describe("greenhouse", () => {
  it("maps the public board response to RawJob", async () => {
    const seen = stubFetch([["boards-api.greenhouse.io", fixture("greenhouse.stripe.json")]]);
    const jobs = await greenhouseFinder.fetchJobs("stripe");

    expect(seen[0]).toBe(
      "https://boards-api.greenhouse.io/v1/boards/stripe/jobs?content=true",
    );
    expectWellFormed(jobs);
    const ai = jobs.find((j) => j.title === "AI Engineer");
    expect(ai).toBeDefined();
    expect(ai!.url).toContain("stripe.com/jobs");
    expect(ai!.location).toBe("Chicago");
    expect(ai!.postedAt?.toISOString()).toBe("2026-07-03T12:01:02.000Z"); // first_published, not updated_at
    // `content` arrives HTML-entity-encoded; it must come out as plain text.
    expect(ai!.description).not.toContain("&lt;");
    expect(ai!.description.length).toBeGreaterThan(200);
  });

  it("returns [] for a board that does not exist", async () => {
    stubFetch([]);
    expect(await greenhouseFinder.fetchJobs("nope")).toEqual([]);
  });
});

describe("lever", () => {
  it("maps the postings response to RawJob", async () => {
    const seen = stubFetch([["api.lever.co", fixture("lever.spotify.json")]]);
    const jobs = await leverFinder.fetchJobs("spotify");

    expect(seen[0]).toBe("https://api.lever.co/v0/postings/spotify?mode=json");
    expectWellFormed(jobs);
    const android = jobs.find((j) => j.title === "Android Engineer - Advertising");
    expect(android).toBeDefined();
    expect(android!.url).toBe(
      "https://jobs.lever.co/spotify/a0fa7da3-4c3c-4fa2-97bd-7d6eb01eb9e5",
    );
    expect(android!.location).toBe("New York, NY");
    expect(android!.remote).toBe(true); // workplaceType: "remote"
    // createdAt is epoch millis.
    expect(android!.postedAt?.toISOString()).toBe("2026-03-18T18:07:05.234Z");
  });
});

describe("ashby", () => {
  it("maps the job-board response to RawJob", async () => {
    const seen = stubFetch([["api.ashbyhq.com", fixture("ashby.ramp.json")]]);
    const jobs = await ashbyFinder.fetchJobs("ramp");

    expect(seen[0]).toBe(
      "https://api.ashbyhq.com/posting-api/job-board/ramp?includeCompensation=true",
    );
    expectWellFormed(jobs);
    // Ashby titles routinely carry stray whitespace ("  Security Engineer, Cloud").
    const intern = jobs.find((j) => j.title === "Software Engineer Internship, Android");
    expect(intern).toBeDefined();
    expect(intern!.url).toContain("jobs.ashbyhq.com/ramp/");
    expect(intern!.remote).toBe(true);
    expect(intern!.postedAt?.toISOString()).toBe("2025-08-07T20:49:38.961Z");
  });
});

describe("recruitee", () => {
  it("maps the offers response to RawJob", async () => {
    const seen = stubFetch([["recruitee.com/api/offers", fixture("recruitee.11bitstudios.json")]]);
    const jobs = await recruiteeFinder.fetchJobs("11bitstudios");

    expect(seen[0]).toBe("https://11bitstudios.recruitee.com/api/offers");
    expectWellFormed(jobs);
    expect(jobs[0].url).toBe(
      "https://11bitstudios.recruitee.com/o/senior-expert-3d-animator-p12",
    );
    expect(jobs[0].location).toBe("Warszawa, Mazowieckie, Poland");
    expect(jobs[0].remote).toBe(false);
    expect(jobs[0].postedAt?.toISOString()).toBe("2026-08-19T13:16:05.000Z");
    // description + requirements are both HTML and both belong in the text.
    expect(jobs[0].description).toContain("11 bit studios");
  });
});

describe("personio", () => {
  it("parses the XML feed into RawJob", async () => {
    const seen = stubFetch([["jobs.personio.de/xml", fixture("personio.bigpoint.xml")]]);
    const jobs = await personioFinder.fetchJobs("bigpoint");

    expect(seen[0]).toBe("https://bigpoint.jobs.personio.de/xml?language=en");
    expectWellFormed(jobs);
    const junior = jobs.find((j) => j.title.startsWith("Junior Platform Developer"));
    expect(junior).toBeDefined();
    expect(junior!.externalId).toBe("2723821");
    expect(junior!.url).toBe(
      "https://bigpoint.jobs.personio.de/job/2723821?language=en",
    );
    expect(junior!.location).toBe("Singapore");
    expect(junior!.postedAt?.toISOString()).toBe("2026-07-22T13:48:14.000Z");
    // CDATA sections carry the real posting body.
    expect(junior!.description).toContain("Junior Platform Developer");
  });

  it("falls back to the .com host when .de 404s", async () => {
    const seen = stubFetch([["jobs.personio.com/xml", fixture("personio.bigpoint.xml")]]);
    const jobs = await personioFinder.fetchJobs("bigpoint");
    expect(seen).toEqual([
      "https://bigpoint.jobs.personio.de/xml?language=en",
      "https://bigpoint.jobs.personio.com/xml?language=en",
    ]);
    expect(jobs.length).toBeGreaterThan(0);
  });
});

describe("smartrecruiters", () => {
  it("maps the postings list and pulls descriptions from the posting detail", async () => {
    const seen = stubFetch([
      ["/postings/744000145929979", fixture("smartrecruiters.ubisoft2.posting.json")],
      // The other two postings have no recorded detail; a 404 there must fall
      // back to a synthesised description rather than dropping the job.
      ["/postings/744000145918119", "{}", 404],
      ["/postings/744000145800584", "{}", 404],
      ["/postings", fixture("smartrecruiters.ubisoft2.json")],
    ]);
    const jobs = await smartrecruitersFinder.fetchJobs("Ubisoft2");

    expect(seen[0]).toBe(
      "https://api.smartrecruiters.com/v1/companies/Ubisoft2/postings?limit=100&offset=0",
    );
    expectWellFormed(jobs);
    const engine = jobs.find((j) => j.title.startsWith("Engine Programmer"));
    expect(engine).toBeDefined();
    expect(engine!.externalId).toBe("744000145929979");
    expect(engine!.url).toContain("jobs.smartrecruiters.com/Ubisoft2/744000145929979");
    expect(engine!.location).toBe("Montreuil, IDF, France");
    expect(engine!.postedAt?.toISOString()).toBe("2026-08-27T09:05:04.997Z");
    // Description came from the jobAd sections on the detail endpoint.
    expect(engine!.description).toContain("Ubisoft");
    expect(seen).toContain(
      "https://api.smartrecruiters.com/v1/companies/Ubisoft2/postings/744000145929979",
    );
  });

  it("raises VendorRequiresKeyError when the listing endpoint is gated", async () => {
    stubFetch([["/postings", '{"message":"unauthorized"}', 401]]);
    await expect(smartrecruitersFinder.fetchJobs("Ubisoft2")).rejects.toBeInstanceOf(
      VendorRequiresKeyError,
    );
  });
});

describe("yc", () => {
  it("reads the public company jobs page into RawJob", async () => {
    const seen = stubFetch([["ycombinator.com/companies", fixture("yc.kalam-labs.html")]]);
    const jobs = await ycFinder.fetchJobs("kalam-labs");

    expect(seen[0]).toBe("https://www.ycombinator.com/companies/kalam-labs/jobs");
    expectWellFormed(jobs);
    const control = jobs.find((j) => j.title === "Control System Engineer");
    expect(control).toBeDefined();
    expect(control!.url).toBe(
      "https://www.ycombinator.com/companies/kalam-labs/jobs/HX9RL60-control-system-engineer",
    );
    expect(control!.location).toBe("Lucknow, UP, IN");
    // The board only publishes a relative age ("about 2 years") — approximate
    // it rather than dropping the date entirely.
    expect(control!.postedAt).toBeInstanceOf(Date);
    // The structured fields YC does publish are what the description is made of.
    expect(control!.description).toContain("US citizenship/visa not required");
    expect(control!.description).toContain("new grads ok");
  });
});
