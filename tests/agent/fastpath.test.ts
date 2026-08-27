import { describe, it, expect } from "vitest";
import {
  detectAts,
  buildApplicantData,
  fastPathFields,
  fillFastPath,
  type ApplicantData,
  type FastPathPage,
} from "../../src/agent/ats-fastpath";

/**
 * A fake Playwright `Page` that knows which selectors "exist" and records
 * every fill/upload it is asked to perform. It deliberately implements only
 * the handful of methods `fillFastPath` is allowed to use — if the fast path
 * ever reaches for something richer (page.evaluate, element handles, …) this
 * test stops compiling, which is the point: the fast path stays a flat
 * selector → value table that can be reasoned about without a browser.
 */
function fakePage(present: string[], url = "https://job-boards.greenhouse.io/acme/jobs/1") {
  const fills: { selector: string; value: string }[] = [];
  const uploads: { selector: string; files: string }[] = [];
  const known = new Set(present);
  const page: FastPathPage = {
    url: () => url,
    $: async (selector: string) => (known.has(selector) ? { selector } : null),
    fill: async (selector: string, value: string) => {
      if (!known.has(selector)) throw new Error(`fill on missing selector ${selector}`);
      fills.push({ selector, value });
    },
    setInputFiles: async (selector: string, files: string) => {
      if (!known.has(selector)) throw new Error(`upload on missing selector ${selector}`);
      uploads.push({ selector, files });
    },
    waitForTimeout: async () => {},
  };
  return { page, fills, uploads };
}

function applicant(overrides: Partial<ApplicantData> = {}): ApplicantData {
  return {
    firstName: "Ada",
    lastName: "Lovelace",
    fullName: "Ada Lovelace",
    email: "ada@example.test",
    phone: "555-0100",
    linkedin: "https://www.linkedin.com/in/ada",
    github: "https://github.com/ada",
    website: "https://ada.example.test",
    city: "Calgary",
    currentOrg: null,
    workAuthorized: "yes",
    requiresSponsorship: "no",
    workAuthRegion: "Canada",
    workAuthLabel: "Authorised to work in Canada without sponsorship.",
    ...overrides,
  };
}

describe("detectAts", () => {
  it("recognises the four URL shapes the fast path handles", () => {
    expect(detectAts("https://job-boards.greenhouse.io/acme/jobs/4567")).toBe("greenhouse");
    expect(detectAts("https://jobs.lever.co/acme/2f0e-441a")).toBe("lever");
    expect(detectAts("https://jobs.ashbyhq.com/acme/9d1c-4c2b")).toBe("ashby");
    expect(detectAts("https://careers.acme.example/openings/backend-intern")).toBe("generic");
  });

  it("recognises greenhouse and lever behind a company's own domain", () => {
    // Embedded Greenhouse board: the vendor only shows up in the query string.
    expect(detectAts("https://www.acme.example/careers?gh_jid=4567")).toBe("greenhouse");
    expect(detectAts("https://grnh.se/abc123")).toBe("greenhouse");
    expect(detectAts("https://acme.example/careers/lever.co/apply")).toBe("lever");
    expect(detectAts("HTTPS://BOARDS.GREENHOUSE.IO/ACME/JOBS/1")).toBe("greenhouse");
  });

  it("falls back to generic for junk instead of throwing", () => {
    expect(detectAts("")).toBe("generic");
    expect(detectAts("not a url")).toBe("generic");
  });
});

describe("buildApplicantData", () => {
  it("derives names, links and work-auth answers from the profile row, not from constants", () => {
    const data = buildApplicantData({
      contact: {
        name: "Grace Hopper",
        email: "grace@example.test",
        phone: "555-0199",
        links: [
          "https://github.com/grace",
          "https://www.linkedin.com/in/grace",
          "https://grace.example.test",
        ],
      },
      prefs: { locations: ["Toronto, ON", "Remote"], workAuth: "canada" },
    });

    expect(data.fullName).toBe("Grace Hopper");
    expect(data.firstName).toBe("Grace");
    expect(data.lastName).toBe("Hopper");
    expect(data.email).toBe("grace@example.test");
    expect(data.linkedin).toBe("https://www.linkedin.com/in/grace");
    expect(data.github).toBe("https://github.com/grace");
    expect(data.website).toBe("https://grace.example.test");
    expect(data.city).toBe("Toronto");
    expect(data.workAuthorized).toBe("yes");
    expect(data.requiresSponsorship).toBe("no");
    expect(data.workAuthRegion).toBe("Canada");
    expect(data.workAuthLabel).toContain("Canada");
  });

  it("says 'unknown' rather than guessing when the profile is empty", () => {
    const data = buildApplicantData({ contact: null, prefs: null });
    expect(data.fullName).toBe("");
    expect(data.firstName).toBe("");
    expect(data.email).toBe("");
    expect(data.linkedin).toBeNull();
    expect(data.city).toBeNull();
    expect(data.workAuthorized).toBe("unknown");
    expect(data.requiresSponsorship).toBe("unknown");
    expect(data.workAuthRegion).toBeNull();
    expect(data.workAuthLabel).toBeNull();
  });

  it("maps needs_sponsorship to sponsorship=yes", () => {
    const data = buildApplicantData({
      contact: { name: "A B" },
      prefs: { workAuth: "needs_sponsorship" },
    });
    expect(data.requiresSponsorship).toBe("yes");
    expect(data.workAuthorized).toBe("no");
    // No country is claimed: "needs sponsorship" is true everywhere.
    expect(data.workAuthRegion).toBeNull();
  });

  it("keeps TN eligibility scoped to the United States, not stated as authorisation", () => {
    const data = buildApplicantData({
      contact: { name: "A B" },
      prefs: { workAuth: "tn_eligible" },
    });
    expect(data.workAuthorized).toBe("no");
    expect(data.requiresSponsorship).toBe("yes");
    expect(data.workAuthRegion).toBe("the United States");
    expect(data.workAuthLabel).toContain("TN");
  });

  it("keeps a multi-word surname together", () => {
    const data = buildApplicantData({ contact: { name: "Ada van der Berg" }, prefs: null });
    expect(data.firstName).toBe("Ada");
    expect(data.lastName).toBe("van der Berg");
  });
});

describe("fastPathFields", () => {
  it("never emits a field whose value is missing", () => {
    const fields = fastPathFields("greenhouse", applicant({ linkedin: null, website: null }));
    const names = fields.map((f) => f.name);
    expect(names).not.toContain("linkedin");
    expect(names).not.toContain("website");
    expect(names).toContain("email");
  });

  it("uses the full name for lever/ashby and split names for greenhouse", () => {
    const gh = fastPathFields("greenhouse", applicant()).map((f) => f.name);
    expect(gh).toContain("first_name");
    expect(gh).toContain("last_name");

    const lever = fastPathFields("lever", applicant());
    expect(lever.find((f) => f.name === "full_name")?.value).toBe("Ada Lovelace");
  });
});

describe("fillFastPath", () => {
  it("fills the Greenhouse fields that are present and reports the rest as remaining", async () => {
    const { page, fills } = fakePage([
      "input#first_name",
      "input#last_name",
      "input#email",
      "input#phone",
    ]);

    const result = await fillFastPath(page, "greenhouse", applicant());

    expect(fills).toEqual([
      { selector: "input#first_name", value: "Ada" },
      { selector: "input#last_name", value: "Lovelace" },
      { selector: "input#email", value: "ada@example.test" },
      { selector: "input#phone", value: "555-0100" },
    ]);
    expect(result.filled).toEqual(["first_name", "last_name", "email", "phone"]);
    // Nothing on the fake page matches these, so the tool loop has to finish them.
    expect(result.remaining).toContain("linkedin");
    expect(result.remaining).toContain("website");
    expect(result.remaining).toContain("location");
  });

  it("falls back to a later selector when the first one is absent", async () => {
    const { page, fills } = fakePage(['input[type="email"]', 'input[type="tel"]']);
    const result = await fillFastPath(page, "greenhouse", applicant());
    expect(fills).toEqual([
      { selector: 'input[type="email"]', value: "ada@example.test" },
      { selector: 'input[type="tel"]', value: "555-0100" },
    ]);
    expect(result.filled).toEqual(["email", "phone"]);
    expect(result.remaining).toContain("first_name");
  });

  it("uploads the resume only when a resume path is supplied", async () => {
    const withPath = fakePage(["input#first_name", 'input[type="file"]']);
    const uploaded = await fillFastPath(withPath.page, "greenhouse", applicant(), {
      resumePath: "/tmp/resume.pdf",
    });
    expect(withPath.uploads).toEqual([
      { selector: 'input[type="file"]', files: "/tmp/resume.pdf" },
    ]);
    expect(uploaded.filled).toContain("resume");

    const withoutPath = fakePage(["input#first_name", 'input[type="file"]']);
    const skipped = await fillFastPath(withoutPath.page, "greenhouse", applicant());
    expect(withoutPath.uploads).toEqual([]);
    expect(skipped.remaining).toContain("resume");
  });

  it("fills Lever's name/url fields", async () => {
    const { page, fills } = fakePage(
      ['input[name="name"]', 'input[name="email"]', 'input[name="urls[LinkedIn]"]'],
      "https://jobs.lever.co/acme/2f0e",
    );
    const result = await fillFastPath(page, "lever", applicant());
    expect(fills).toEqual([
      { selector: 'input[name="name"]', value: "Ada Lovelace" },
      { selector: 'input[name="email"]', value: "ada@example.test" },
      { selector: 'input[name="urls[LinkedIn]"]', value: "https://www.linkedin.com/in/ada" },
    ]);
    expect(result.filled).toEqual(["full_name", "email", "linkedin"]);
  });

  it("fills Ashby's fields", async () => {
    const { page, fills } = fakePage(
      ['input[name="name"]', 'input[name="_systemfield_email"]'],
      "https://jobs.ashbyhq.com/acme/9d1c",
    );
    const result = await fillFastPath(page, "ashby", applicant());
    expect(fills.map((f) => f.value)).toEqual(["Ada Lovelace", "ada@example.test"]);
    expect(result.filled).toEqual(["full_name", "email"]);
  });

  it("survives a selector that throws mid-fill and keeps going", async () => {
    const { fills } = fakePage([]);
    const page: FastPathPage = {
      url: () => "https://job-boards.greenhouse.io/acme/jobs/1",
      $: async (selector: string) =>
        selector === "input#first_name" || selector === "input#email" ? { selector } : null,
      fill: async (selector: string, value: string) => {
        if (selector === "input#first_name") throw new Error("detached");
        fills.push({ selector, value });
      },
      waitForTimeout: async () => {},
    };
    const result = await fillFastPath(page, "greenhouse", applicant());
    expect(result.filled).toEqual(["email"]);
    expect(result.remaining).toContain("first_name");
    expect(fills).toEqual([{ selector: "input#email", value: "ada@example.test" }]);
  });
});
