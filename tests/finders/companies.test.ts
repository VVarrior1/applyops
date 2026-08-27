import { describe, expect, it } from "vitest";
import {
  careersUrlFor,
  parseOpenJobsCompanies,
  parseV1Allowlists,
  prettifySlug,
  vendorFromAtsUrl,
} from "../../src/finders/companies";

describe("vendorFromAtsUrl", () => {
  it("recognises every vendor shape the OpenJobs data actually contains", () => {
    const cases: Array<[string, string, string]> = [
      ["https://boards.greenhouse.io/bungie", "greenhouse", "bungie"],
      ["https://job-boards.greenhouse.io/1047games", "greenhouse", "1047games"],
      ["https://boards.eu.greenhouse.io/someco/", "greenhouse", "someco"],
      ["https://jobs.lever.co/voodoo", "lever", "voodoo"],
      ["https://jobs.eu.lever.co/crytek/", "lever", "crytek"],
      ["https://jobs.ashbyhq.com/Pocket%20Worlds/", "ashby", "Pocket Worlds"],
      ["https://careers.smartrecruiters.com/Ubisoft2/", "smartrecruiters", "Ubisoft2"],
      [
        "https://careers.smartrecruiters.com/KeywordsAustralia/wickedworkshop",
        "smartrecruiters",
        "KeywordsAustralia",
      ],
      ["https://11bitstudios.recruitee.com/", "recruitee", "11bitstudios"],
      ["https://bigpoint.jobs.personio.de/", "personio", "bigpoint"],
      ["https://vertigo-games.jobs.personio.com/?language=en", "personio", "vertigo-games"],
      ["https://www.ycombinator.com/companies/rosebud-ai/jobs", "yc", "rosebud-ai"],
    ];
    for (const [url, vendor, slug] of cases) {
      expect(vendorFromAtsUrl(url), url).toEqual({ vendor, slug });
    }
  });

  it("skips ATSs with no finder, placeholders and bare careers pages", () => {
    for (const url of [
      "https://apply.workable.com/someco/",
      "https://jobs.jobvite.com/someco",
      "https://www.linkedin.com/company/someco/jobs/",
      "https://warnerbros.wd5.myworkdayjobs.com/careers",
      "https://cusmat.com/careers/",
      "aaaaaaaaaaaaaaaaaaaa",
      "",
      "https://boards.greenhouse.io/",
      "https://apply.recruitee.com/",
    ]) {
      expect(vendorFromAtsUrl(url), url).toBeNull();
    }
  });
});

describe("careersUrlFor", () => {
  it("builds a human-facing board URL per vendor and nothing for 'other'", () => {
    expect(careersUrlFor("lever", "voodoo")).toBe("https://jobs.lever.co/voodoo");
    expect(careersUrlFor("recruitee", "11bitstudios")).toBe(
      "https://11bitstudios.recruitee.com",
    );
    expect(careersUrlFor("other", "x")).toBeNull();
  });
});

describe("prettifySlug", () => {
  it("turns a board slug into something readable", () => {
    expect(prettifySlug("weights-biases")).toBe("Weights Biases");
    expect(prettifySlug("modern-treasury")).toBe("Modern Treasury");
    expect(prettifySlug("stripe")).toBe("Stripe");
  });
});

describe("parseV1Allowlists", () => {
  // A faithful miniature of `/Users/abdu/Job_Auto_Apply/scripts/scrape-apis.ts`:
  // section comments between entries, a commented-out slug, and the Workday
  // object literals.
  const SOURCE = `
const GREENHOUSE_COMPANIES = [
  // Existing companies
  'airbnb', 'doordash',
  // 'commented-out',
  'weights-biases',
]

const LEVER_COMPANIES = [
  'anthropic', 'figma',
]

const FETCH_GREENHOUSE_DETAILS = process.env.GREENHOUSE_FETCH_DETAILS === 'true'

const WORKDAY_CONFIG = [
  { tenant: 'tcenergy', site: 'careers', label: 'TC Energy' },
  { tenant: 'amd', site: 'External', label: 'AMD' },
]
`;

  it("reads the three lists and ignores commented-out entries", () => {
    const parsed = parseV1Allowlists(SOURCE);
    const slugs = (vendor: string) =>
      parsed.filter((c) => c.atsVendor === vendor).map((c) => c.atsSlug);

    expect(slugs("greenhouse")).toEqual(["airbnb", "doordash", "weights-biases"]);
    expect(slugs("lever")).toEqual(["anthropic", "figma"]);
    expect(slugs("other")).toEqual(["tcenergy/careers", "amd/External"]);
  });

  it("keeps Workday tenants as data with their real labels", () => {
    const amd = parseV1Allowlists(SOURCE).find((c) => c.atsSlug === "amd/External");
    expect(amd).toEqual({
      name: "AMD",
      atsVendor: "other",
      atsSlug: "amd/External",
      careersUrl: "https://amd.wd3.myworkdayjobs.com/External",
      source: "v1_allowlist",
    });
  });

  it("names slug-only companies readably", () => {
    const wb = parseV1Allowlists(SOURCE).find((c) => c.atsSlug === "weights-biases");
    expect(wb?.name).toBe("Weights Biases");
    expect(wb?.careersUrl).toBe("https://job-boards.greenhouse.io/weights-biases");
  });
});

describe("parseOpenJobsCompanies", () => {
  const DATA = [
    {
      name: "Bungie",
      type: "gaming",
      industry_category: "gaming",
      ats_links: ["https://boards.greenhouse.io/bungie", "https://job-boards.greenhouse.io/bungie"],
    },
    {
      name: "Rosebud AI",
      type: "tech",
      industry_category: "tech",
      ats_links: ["https://www.ycombinator.com/companies/rosebud-ai/jobs"],
    },
    { name: "Cusmat", type: "tech", industry_category: "gaming", ats_links: ["https://cusmat.com/careers/"] },
    { name: "No Links", type: "ai", industry_category: null, ats_links: [] },
  ];

  it("keeps only companies on a supported ATS and dedupes their boards", () => {
    const { candidates, unknownVendor } = parseOpenJobsCompanies(DATA, { techOnly: false });
    expect(candidates.map((c) => `${c.atsVendor}:${c.atsSlug}`)).toEqual([
      "greenhouse:bungie",
      "yc:rosebud-ai",
    ]);
    expect(candidates[0]).toMatchObject({ name: "Bungie", source: "openjobs" });
    expect(unknownVendor).toBe(1); // cusmat.com/careers
  });

  it("filters to software/tech when asked", () => {
    const { candidates } = parseOpenJobsCompanies(DATA, { techOnly: true });
    expect(candidates.map((c) => c.atsSlug)).toEqual(["rosebud-ai"]);
  });
});
