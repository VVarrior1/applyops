import { describe, it, expect } from "vitest";
import { htmlToText, resolveApi } from "@/src/alerts/describe";

describe("resolveApi", () => {
  it("maps a Greenhouse posting to its board API", () => {
    expect(resolveApi("https://job-boards.greenhouse.io/assystinc/jobs/4371586009")?.apiUrl).toBe(
      "https://boards-api.greenhouse.io/v1/boards/assystinc/jobs/4371586009",
    );
  });

  it("maps a Lever posting, ignoring the /apply suffix", () => {
    expect(resolveApi("https://jobs.lever.co/analyticpartners/2b2d-44/apply")?.apiUrl).toBe(
      "https://api.lever.co/v0/postings/analyticpartners/2b2d-44",
    );
  });

  it("maps a SmartRecruiters posting, stripping the slug from the id", () => {
    expect(resolveApi("https://jobs.smartrecruiters.com/BoydGaming/3743990014633026-data-analyst")?.apiUrl).toBe(
      "https://api.smartrecruiters.com/v1/companies/BoydGaming/postings/3743990014633026",
    );
  });

  it("maps an Ashby posting to its board, keeping query params out of the way", () => {
    expect(resolveApi("https://jobs.ashbyhq.com/ambral/bfcfbd07-03b9/application?embed=true")?.apiUrl).toBe(
      "https://api.ashbyhq.com/posting-api/job-board/ambral",
    );
  });

  it("returns null for vendors with no public board API, and for junk", () => {
    // Real examples from the live feed — company-branded pages behind gh_jid,
    // iCIMS and Oracle Recruiting. A null here means "do not text", never "pass".
    expect(resolveApi("https://epicgames.com/careers/jobs/616?gh_jid=616")).toBeNull();
    expect(resolveApi("https://careers-sureway.icims.com/jobs/8031/job")).toBeNull();
    expect(resolveApi("not a url")).toBeNull();
  });
});

describe("htmlToText", () => {
  it("strips tags and scripts and decodes entities", () => {
    const text = htmlToText("<div><script>bad()</script><p>5+ years&nbsp;required &amp; a degree</p></div>");
    expect(text).not.toContain("bad()");
    expect(text).toContain("5+ years required & a degree");
  });

  it("keeps paragraph breaks so requirement lists stay readable", () => {
    expect(htmlToText("<li>One</li><li>Two</li>")).toBe("One\nTwo");
  });
});
