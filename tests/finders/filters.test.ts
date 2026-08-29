import { describe, expect, it } from "vitest";
import {
  classifyEntryLevel,
  detectWorkAuth,
  hasUsableDescription,
  isEntryLevel,
  isPreferredLocation,
  isRelevantRole,
  normalizeLocation,
  titleEntrySignal,
} from "../../src/finders/filters";

describe("isEntryLevel", () => {
  it("rejects seniority in the title", () => {
    expect(isEntryLevel("Senior Software Engineer", "")).toBe(false);
    expect(isEntryLevel("Sr. Backend Engineer", "")).toBe(false);
    expect(isEntryLevel("Staff Software Engineer", "")).toBe(false);
    expect(isEntryLevel("Principal Engineer", "")).toBe(false);
    expect(isEntryLevel("Engineering Manager", "")).toBe(false);
    expect(isEntryLevel("Tech Lead, Payments", "")).toBe(false);
    expect(isEntryLevel("Software Engineer III", "")).toBe(false);
    expect(isEntryLevel("Senior / Expert 3D Animator", "")).toBe(false);
  });

  it("accepts explicit new-grad / junior wording", () => {
    expect(isEntryLevel("Software Engineer, New Grad 2026", "")).toBe(true);
    expect(isEntryLevel("Junior Platform Developer", "")).toBe(true);
    expect(isEntryLevel("Software Engineer Intern (Summer)", "")).toBe(true);
    expect(isEntryLevel("Associate Software Developer", "")).toBe(true);
    expect(isEntryLevel("Backend Engineer", "Entry-level role, 0-2 years")).toBe(
      true,
    );
  });

  it("does not treat 'leadership' or 'download' as a seniority hit", () => {
    // v1 used substring matching, so a description mentioning "leadership"
    // rejected the job. Word-boundary matching is the fix.
    expect(
      isEntryLevel("New Grad Software Engineer", "You will show leadership."),
    ).toBe(true);
  });

  it("rejects multi-year experience requirements", () => {
    expect(
      isEntryLevel("Software Engineer", "5+ years of professional experience"),
    ).toBe(false);
    expect(
      isEntryLevel("New Grad Engineer", "Requires 4-6 years building systems"),
    ).toBe(false);
    expect(isEntryLevel("Software Engineer", "10 years of Java")).toBe(false);
  });

  it("rejects advanced-degree and senior-context requirements", () => {
    expect(isEntryLevel("Research Engineer", "PhD required")).toBe(false);
    expect(
      isEntryLevel("Software Engineer", "You have extensive experience in Go"),
    ).toBe(false);
    expect(
      isEntryLevel("Software Engineer", "A proven track record of shipping"),
    ).toBe(false);
  });

  it("accepts an exactly-generic title with no experience mention", () => {
    expect(isEntryLevel("Software Engineer", "Build things with us.")).toBe(
      true,
    );
    expect(isEntryLevel("Full Stack Developer", "Build things with us.")).toBe(
      true,
    );
  });

  it("accepts a non-senior title with no entry-level signal (relaxed 2026-08-27)", () => {
    // Most Canadian postings say plain "Software Engineer"; only senior signals reject now.
    expect(
      isEntryLevel("Machine Learning Engineer, Ranking", "Build models."),
    ).toBe(true);
  });

  it("a stray year in a non-graduation context no longer matters (title has no senior signal)", () => {
    // Relaxed rule: no senior signal → entry-level, regardless of graduation-year wording.
    // Bare "2026" is everywhere (copyright lines, "Updated 2026"), so it must
    // not on its own mark a job entry level.
    expect(
      isEntryLevel("Machine Learning Engineer", "© 2026 Acme Inc."),
    ).toBe(true);
    expect(
      isEntryLevel("Machine Learning Engineer", "For the class of 2026."),
    ).toBe(true);
  });
});

describe("isRelevantRole", () => {
  it("keeps engineering titles", () => {
    expect(isRelevantRole("Software Engineer")).toBe(true);
    expect(isRelevantRole("Backend Developer, Platform")).toBe(true);
    expect(isRelevantRole("Site Reliability Engineer")).toBe(true);
    expect(isRelevantRole("Data Engineer")).toBe(true);
  });

  it("drops non-technical titles", () => {
    expect(isRelevantRole("Account Executive")).toBe(false);
    expect(isRelevantRole("Product Manager")).toBe(false);
    expect(isRelevantRole("Technical Recruiter")).toBe(false);
    expect(isRelevantRole("Paralegal")).toBe(false);
    expect(isRelevantRole("Customer Support Specialist")).toBe(false);
    expect(isRelevantRole("Support Associate (Gurgaon)")).toBe(false);
    expect(isRelevantRole("IT Support Administrator I")).toBe(false);
    expect(isRelevantRole("IT Service Desk Intern")).toBe(false);
    expect(isRelevantRole("Product Designer")).toBe(false);
    expect(isRelevantRole("Senior General Ledger Accountant")).toBe(false);
    expect(isRelevantRole("Business Analyst")).toBe(false);
  });

  it("does not drop a title merely containing an excluded word", () => {
    // "designer" is excluded, "design" is not: hardware/compiler design roles
    // are engineering jobs.
    expect(isRelevantRole("Hardware Design Engineer")).toBe(true);
    expect(isRelevantRole("Machine Learning Engineer, Ranking")).toBe(true);
    expect(isRelevantRole("Junior Platform Developer, AdTech")).toBe(true);
  });

  it("drops non-technical titles that carry no excluded word either", () => {
    // Real titles from an audit of 4,000 scraped postings: every one of these
    // reached `is_relevant_role = true` under v1's exclusion-only filter.
    for (const title of [
      "Seasonal Warehouse Associate",
      "Food Safety Associate",
      "Internship (Facilities)",
      "Materials Associate, Warehouse",
      "Football Video Systems Technician - Bolzano",
      "Binance Accelerator Program - UX Researcher (Non-technical)",
    ]) {
      expect(isRelevantRole(title), title).toBe(false);
    }
  });
});

describe("normalizeLocation", () => {
  it("collapses whitespace and drops placeholders", () => {
    expect(normalizeLocation("  Calgary,   AB  ")).toBe("calgary, ab");
    expect(normalizeLocation("Unknown")).toBeNull();
    expect(normalizeLocation("N/A")).toBeNull();
    expect(normalizeLocation("")).toBeNull();
    expect(normalizeLocation(null)).toBeNull();
  });
});

describe("isPreferredLocation", () => {
  it("uses the default Canada/US allow-list when no prefs are given", () => {
    expect(isPreferredLocation("Calgary, AB", false)).toBe(true);
    expect(isPreferredLocation("Toronto, Canada", false)).toBe(true);
    expect(isPreferredLocation("New York, NY", false)).toBe(true);
    expect(isPreferredLocation("Warszawa, Mazowieckie, Poland", false)).toBe(
      false,
    );
    expect(isPreferredLocation("Montreuil, IDF, France", false)).toBe(false);
  });

  it("keeps unrestricted remote roles but drops remote roles in other regions", () => {
    expect(isPreferredLocation("Remote", true)).toBe(true);
    expect(isPreferredLocation("Remote (US)", true)).toBe(true);
    expect(isPreferredLocation("Remote - Canada", true)).toBe(true);
    expect(isPreferredLocation("Remote - India", true)).toBe(false);
    expect(isPreferredLocation("Remote (EMEA)", true)).toBe(false);
  });

  it("keeps a remote role with an unknown location, drops an onsite one", () => {
    expect(isPreferredLocation(null, true)).toBe(true);
    expect(isPreferredLocation(null, false)).toBe(false);
  });

  it("with prefs, the city list is advisory: geography is enforced by country in SQL", () => {
    const prefs = { locations: ["Calgary", "Vancouver"], remote: "any" };
    expect(isPreferredLocation("Calgary, AB", false, prefs)).toBe(true);
    expect(isPreferredLocation("Calgary, Alberta, Canada", false, prefs)).toBe(true);
    expect(isPreferredLocation("New York, NY", false, prefs)).toBe(true);
    expect(isPreferredLocation("Canada", true, prefs)).toBe(true);
    // unknown location: remote kept, onsite dropped
    expect(isPreferredLocation(null, true, prefs)).toBe(true);
    expect(isPreferredLocation(null, false, prefs)).toBe(false);
  });

  it("honours the remote mode in prefs", () => {
    expect(
      isPreferredLocation("Calgary, AB", false, {
        locations: [],
        remote: "remote",
      }),
    ).toBe(false);
    expect(
      isPreferredLocation("Remote", true, { locations: [], remote: "onsite" }),
    ).toBe(false);
    expect(
      isPreferredLocation("Remote", true, { locations: [], remote: "remote" }),
    ).toBe(true);
  });
});

describe("detectWorkAuth", () => {
  it("flags US-authorization-only postings", () => {
    expect(
      detectWorkAuth(
        "Applicants must be authorized to work in the US without sponsorship.",
      ),
    ).toBe("needs_us_auth");
    expect(detectWorkAuth("We are unable to sponsor visas at this time.")).toBe(
      "needs_us_auth",
    );
    expect(detectWorkAuth("No visa sponsorship is available.")).toBe(
      "needs_us_auth",
    );
    expect(detectWorkAuth("Visa: US citizen/visa only")).toBe("needs_us_auth");
    expect(detectWorkAuth("We cannot sponsor work visas for this role.")).toBe(
      "needs_us_auth",
    );
  });

  it("flags TN-friendly postings", () => {
    expect(detectWorkAuth("We support TN visa candidates.")).toBe("tn_friendly");
    expect(detectWorkAuth("Open to TN-1 status holders.")).toBe("tn_friendly");
    expect(detectWorkAuth("USMCA professionals welcome.")).toBe("tn_friendly");
  });

  it("does not read 'TN1' out of a base64 blob", () => {
    // A real posting embedded a base64 image whose text contained "…r2tn1jd…";
    // `+` and `/` are non-word characters, so a bare \btn1\b matched inside it.
    expect(
      detectWorkAuth("pfxeex9cetm/nswvrczhmbq3icp9jhvt2w+95yfzfgah+h1zpo9hduh2iy9mccp7kupujqptmnb+1gt/wdlscrk5r2tn1jdpjqo0joeu"),
    ).toBe("unclear");
    expect(detectWorkAuth("Eligible for TN-1 status.")).toBe("tn_friendly");
  });

  it("flags Canadian hiring when the text says so", () => {
    expect(
      detectWorkAuth(
        "Toronto, Canada. We hire employees in Canada through our Canadian entity.",
      ),
    ).toBe("hires_canadians");
    expect(
      detectWorkAuth("Vancouver, BC. Canadian applicants are welcome."),
    ).toBe("hires_canadians");
  });

  it("returns unclear when a Canadian location carries no hiring signal", () => {
    expect(detectWorkAuth("Toronto, Canada. Competitive salary and equity.")).toBe(
      "unclear",
    );
    expect(detectWorkAuth("")).toBe("unclear");
    expect(
      detectWorkAuth("Visa: US citizenship/visa not required"),
    ).toBe("unclear");
    // Real sentences from the scraped corpus that say "do not offer" about
    // something other than sponsorship — these must not read as US-only.
    expect(
      detectWorkAuth(
        "We are an office-first company and value in-person collaboration; we do not offer remote-only roles.",
      ),
    ).toBe("unclear");
    expect(
      detectWorkAuth("Please note that we do not offer relocation at this time."),
    ).toBe("unclear");
  });
});

describe("isRelevantRole excludes non-software engineering and IT-ops titles", () => {
  it.each([
    "Pipeline Hydraulic Engineer",
    "Reciprocating Equipment and Turbomachinery Engineer",
    "Staff Rotating Equipment Engineer",
    "Mechanical Engineer",
    "Contact Engineer",
    "Project Engineer",
    "Engineering Technologist",
    "Windows Engineer",
    "Network Engineer",
    "Linux Engineer",
  ])("%s → false", async (t) => {
    const { isRelevantRole } = await import("../../src/finders/filters");
    expect(isRelevantRole(t)).toBe(false);
  });
  it.each(["Software Engineer", "Automation Engineer, Test", "Site Reliability Engineer", "Platform Engineer", "Data Engineer", "Machine Learning Engineer", "Cloud Engineer"])("%s → true", async (t) => {
    const { isRelevantRole } = await import("../../src/finders/filters");
    expect(isRelevantRole(t)).toBe(true);
  });
});

describe("isEntryLevel judges year ranges by their lower bound", () => {
  it("keeps 1-3 / 0 to 2 year ranges, still rejects 2-5 and 4-6", async () => {
    const { isEntryLevel } = await import("../../src/finders/filters");
    expect(isEntryLevel("Software Developer", "1-3 years of experience with TypeScript")).toBe(true);
    expect(isEntryLevel("Software Developer", "0 to 2 years of experience")).toBe(true);
    expect(isEntryLevel("Software Developer", "1–3 years' experience")).toBe(true);
    expect(isEntryLevel("Software Developer", "2 to 5 years of relevant engineering experience")).toBe(false);
    expect(isEntryLevel("GenAI Software Developer", "4-6 years of experience in software dev")).toBe(false);
    expect(isEntryLevel("Software Developer", "1-3 years preferred; 5+ years for senior track")).toBe(false);
  });
});

describe("isEntryLevel reads years-of-experience written as number words", () => {
  const pad = " ".concat("Build great things with a great team. ".repeat(8));

  it.each([
    ["five years", "We require five years of professional experience building systems."],
    ["minimum of five (5) years", "Minimum of five (5) years of relevant experience."],
    ["at least three years", "At least three years of experience in a similar role."],
    ["five or more years", "Five or more years of experience is required."],
    ["five+ years", "five+ years of Java."],
    ["ten years", "Ten years of relevant professional background."],
    ["at least 5 full years", "You have at least 5 full years of hands-on experience."],
    ["5 or more years", "5 or more years of experience required."],
    ["5+ yrs", "5+ yrs preferred for this position."],
  ])("rejects %s", (_label, description) => {
    expect(isEntryLevel("Software Engineer", description + pad)).toBe(false);
  });

  it.each([
    ["one to three years", "We want one to three years of experience with TypeScript."],
    ["1-3 years", "1-3 years of experience with TypeScript."],
    ["two years", "Two years of experience is plenty for this role."],
    ["2+ yrs", "2+ yrs preferred for this position."],
  ])("keeps %s", (_label, description) => {
    expect(isEntryLevel("Software Engineer", description + pad)).toBe(true);
  });

  it("does not read a recruiting flourish as a requirement (real posting, Aug 2026)", () => {
    // "Associate Product Engineer (College Grad 2027)" — the only "three
    // years" in the body is a comparison, not an ask.
    const body =
      "We give you real problems that matter. You'll grow faster here in one year " +
      "than you would in three years at a big tech company. It will be hard." + pad;
    expect(isEntryLevel("Associate Product Engineer (College Grad 2027)", body)).toBe(true);
  });

  it("still rejects the real postings that DO state the ask in words (Aug 2026)", () => {
    expect(
      isEntryLevel(
        "Detection Engineer, Information Security",
        "You have a degree in Computer Science. You have at least five years of " +
          "experience as an Information Security Consultant or similar." + pad,
      ),
    ).toBe(false);
    expect(
      isEntryLevel(
        "Quality Engineer",
        "The ideal candidate will have five years of related experience and/or " +
          "training; or equivalent combination." + pad,
      ),
    ).toBe(false);
  });
});

describe("hasUsableDescription", () => {
  it("rejects null, empty, too-short, and title-only descriptions", () => {
    expect(hasUsableDescription(null, "Software Engineer")).toBe(false);
    expect(hasUsableDescription("", "Software Engineer")).toBe(false);
    expect(hasUsableDescription("   ", "Software Engineer")).toBe(false);
    // The exact placeholder the capped Workday/SmartRecruiters finders stored.
    expect(hasUsableDescription("Software Engineer", "Software Engineer")).toBe(false);
    expect(hasUsableDescription("x".repeat(199), "Software Engineer")).toBe(false);
  });

  it("accepts a real posting body", () => {
    expect(hasUsableDescription("x".repeat(200), "Software Engineer")).toBe(true);
  });

  it("rejects a long description that is only the title repeated back", () => {
    const longTitle = "Software Engineer ".repeat(20).trim();
    expect(hasUsableDescription(longTitle, longTitle)).toBe(false);
  });
});

describe("titleEntrySignal", () => {
  it.each([
    "Junior Platform Developer",
    "Software Engineer, New Grad 2026",
    "Graduate Software Engineer",
    "Software Engineer Intern (Summer)",
    "Software Developer Co-op",
    "Associate Software Developer",
    "Entry-Level Backend Engineer",
    "Software Engineer I",
    "Developer 1, Platform",
    "Software Engineer, Level 1",
  ])("%s → true", (title) => {
    expect(titleEntrySignal(title)).toBe(true);
  });

  it.each([
    "Software Engineer",
    "Software Engineer II",
    "Senior Software Engineer",
    "Staff Backend Engineer",
  ])("%s → false", (title) => {
    expect(titleEntrySignal(title)).toBe(false);
  });
});

describe("classifyEntryLevel", () => {
  const body = (text: string) => text + " ".concat("More about the role. ".repeat(15));

  it("is null when the description was never fetched and the title says nothing", () => {
    // The exact shape of the 48 title-only rows this fix was written for.
    expect(classifyEntryLevel("Software Engineer", "Software Engineer")).toBeNull();
    expect(classifyEntryLevel("Software Engineer", null)).toBeNull();
    expect(classifyEntryLevel("Machine Learning Engineer", "")).toBeNull();
  });

  it("is true from the title alone when the title carries an entry signal", () => {
    expect(classifyEntryLevel("Software Engineer Intern", null)).toBe(true);
    expect(classifyEntryLevel("Junior Platform Developer", "Junior Platform Developer")).toBe(true);
    expect(classifyEntryLevel("Software Engineer I", null)).toBe(true);
  });

  it("is false from the title alone when the title is disqualifying", () => {
    expect(classifyEntryLevel("Senior Software Engineer", null)).toBe(false);
    expect(classifyEntryLevel("Staff Software Engineer", "Staff Software Engineer")).toBe(false);
    expect(classifyEntryLevel("Software Engineer II", null)).toBe(false);
    // Seniority beats the entry-level word "associate".
    expect(classifyEntryLevel("Associate Director, Engineering", null)).toBe(false);
  });

  it("defers to isEntryLevel once there is a real description", () => {
    expect(
      classifyEntryLevel("Software Engineer", body("We require five years of professional experience.")),
    ).toBe(false);
    expect(classifyEntryLevel("Software Engineer", body("Build things with us."))).toBe(true);
  });
});
