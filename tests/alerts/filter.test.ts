import { describe, it, expect } from "vitest";
import {
  isCanadian,
  isAmbiguousRemote,
  isSoftwareRole,
  looksEntryLevelTitle,
  hasEntryLevelMarker,
  isFresh,
  isInternship,
  shortlist,
} from "@/src/alerts/filter";
import type { FeedListing } from "@/src/alerts/sources";

function listing(over: Partial<FeedListing> = {}): FeedListing {
  return {
    source: "simplify-newgrad",
    externalKey: "simplify-newgrad:abc",
    company: "Yelp",
    title: "Software Engineer",
    url: "https://example.test/job/1",
    locations: ["Toronto, ON, Canada"],
    postedAt: new Date("2026-08-29T12:00:00Z"),
    category: "Software Engineering",
    sponsorship: null,
    ...over,
  };
}

describe("isCanadian", () => {
  it("accepts explicit Canada", () => {
    expect(isCanadian(["Montreal, QC, Canada"])).toBe(true);
    expect(isCanadian(["Remote in Canada"])).toBe(true);
  });

  it("accepts a province code", () => {
    expect(isCanadian(["Ottawa, ON"])).toBe(true);
    expect(isCanadian(["Calgary, AB"])).toBe(true);
  });

  it("accepts a bare Canadian city", () => {
    expect(isCanadian(["Calgary"])).toBe(true);
    expect(isCanadian(["Toronto"])).toBe(true);
  });

  // The feed genuinely contains "Vancouver, WA" — Washington, not BC.
  it("rejects a Canadian-sounding city in a US state", () => {
    expect(isCanadian(["Vancouver, WA"])).toBe(false);
    expect(isCanadian(["London, KY"])).toBe(false);
    expect(isCanadian(["Waterloo, IA"])).toBe(false);
  });

  it("rejects plainly US locations and empty input", () => {
    expect(isCanadian(["SF"])).toBe(false);
    expect(isCanadian(["New York, NY"])).toBe(false);
    expect(isCanadian([])).toBe(false);
  });
});

describe("isSoftwareRole", () => {
  it("keeps software and data categories", () => {
    expect(isSoftwareRole(listing({ category: "Software Engineering" }))).toBe(true);
    expect(isSoftwareRole(listing({ category: "AI/ML/Data" }))).toBe(true);
  });

  it("drops hardware and product-management categories", () => {
    expect(isSoftwareRole(listing({ category: "Hardware", title: "ASIC Engineer" }))).toBe(false);
    expect(isSoftwareRole(listing({ category: "Product Management", title: "APM" }))).toBe(false);
  });

  it("falls back to the title when a feed gives no category", () => {
    expect(isSoftwareRole(listing({ category: null, title: "Backend Developer" }))).toBe(true);
    expect(isSoftwareRole(listing({ category: null, title: "Gradesperson - Survey Technologist" }))).toBe(false);
    expect(isSoftwareRole(listing({ category: null, title: "Field Technical Service Representative" }))).toBe(false);
  });
});

describe("looksEntryLevelTitle", () => {
  it("rejects titles that are plainly above entry level", () => {
    for (const t of [
      "Senior Software Engineer",
      "Staff Software Engineer",
      "Principal ML System Engineer",
      "Engineering Manager",
      "Software Engineer II",
      "Software Engineer III",
      "Director, Software Development",
      "Architect",
    ]) {
      expect(looksEntryLevelTitle(t), t).toBe(false);
    }
  });

  it("keeps entry-level and plain titles", () => {
    for (const t of [
      "Software Engineer",
      "Software Engineer I",
      "Junior Site Reliability Engineer",
      "New Grad Software Engineer",
      "Associate Developer",
    ]) {
      expect(looksEntryLevelTitle(t), t).toBe(true);
    }
  });
});

describe("hasEntryLevelMarker", () => {
  it("spots explicit new-grad wording", () => {
    expect(hasEntryLevelMarker("New Grad Software Engineer")).toBe(true);
    expect(hasEntryLevelMarker("Junior Developer")).toBe(true);
  });
});

describe("isFresh", () => {
  const now = new Date("2026-08-29T18:00:00Z");

  it("accepts a recent posting and rejects an old one", () => {
    expect(isFresh(listing({ postedAt: new Date("2026-08-29T12:00:00Z") }), 24, now)).toBe(true);
    expect(isFresh(listing({ postedAt: new Date("2026-08-20T12:00:00Z") }), 24, now)).toBe(false);
  });

  it("never calls an undated listing fresh", () => {
    expect(isFresh(listing({ postedAt: null }), 24, now)).toBe(false);
  });
});

describe("shortlist", () => {
  const now = new Date("2026-08-29T18:00:00Z");
  const base = { freshnessHours: 24, alreadySent: new Set<string>(), now };

  it("keeps a fresh Canadian entry-level software role", () => {
    expect(shortlist([listing()], base)).toHaveLength(1);
  });

  it("drops one already sent", () => {
    const out = shortlist([listing()], { ...base, alreadySent: new Set(["simplify-newgrad:abc"]) });
    expect(out).toHaveLength(0);
  });

  it("drops senior, non-software, US and stale listings", () => {
    const rejects = [
      listing({ title: "Senior Software Engineer", externalKey: "k1" }),
      listing({ title: "Best Buy Field Technical Rep", category: null, externalKey: "k2" }),
      listing({ locations: ["Vancouver, WA"], externalKey: "k3" }),
      listing({ postedAt: new Date("2026-08-01T00:00:00Z"), externalKey: "k4" }),
    ];
    expect(shortlist(rejects, base)).toHaveLength(0);
  });

  it("lets an undated listing through only when it is new since the last snapshot", () => {
    const undated = listing({ postedAt: null, externalKey: "speedy:x" });
    expect(shortlist([undated], { ...base, previouslySeen: new Set(["speedy:x"]) })).toHaveLength(0);
    expect(shortlist([undated], { ...base, previouslySeen: new Set() })).toHaveLength(1);
  });

  it("returns newest first", () => {
    const older = listing({ externalKey: "a", postedAt: new Date("2026-08-29T06:00:00Z") });
    const newer = listing({ externalKey: "b", postedAt: new Date("2026-08-29T17:00:00Z") });
    expect(shortlist([older, newer], base).map((l) => l.externalKey)).toEqual(["b", "a"]);
  });
});

describe("isCanadian — foreign cities that share a Canadian name", () => {
  // All three appeared in the live SimplifyJobs feed.
  it("rejects London UK, which is not London Ontario", () => {
    expect(isCanadian(["London, UK"])).toBe(false);
    expect(isCanadian(["London, United Kingdom"])).toBe(false);
  });

  it("still accepts London, Ontario", () => {
    expect(isCanadian(["London, ON"])).toBe(true);
    expect(isCanadian(["London, Ontario, Canada"])).toBe(true);
  });

  it("rejects explicitly non-Canadian remote", () => {
    expect(isCanadian(["Remote in USA"])).toBe(false);
    expect(isCanadian(["Remote - India"])).toBe(false);
  });

  it("prefers an explicit Canada over a foreign token in a multi-location posting", () => {
    expect(isCanadian(["Toronto, ON, Canada"])).toBe(true);
  });
});

describe("isAmbiguousRemote", () => {
  it("treats a bare Remote as undecidable, to be settled by the posting text", () => {
    expect(isAmbiguousRemote(["Remote"])).toBe(true);
  });

  it("does not treat a country-qualified remote as ambiguous", () => {
    expect(isAmbiguousRemote(["Remote in USA"])).toBe(false);
    expect(isAmbiguousRemote(["Remote in Canada"])).toBe(false);
  });
});

describe("isInternship — the owner wants permanent new-grad roles only", () => {
  it("rejects internships, co-ops and work terms", () => {
    for (const t of [
      "AI Automation Co-op (Fall 2026)",
      "Software Engineer Intern",
      "Web Engineer Intern - Tools & Portals",
      "Software Engineering Internship (Summer 2027)",
      "Backend Developer Coop",
      "Engineering Work Term Student",
      "Summer Analyst - Technology",
    ]) {
      expect(isInternship(t), t).toBe(true);
    }
  });

  it("does not mistake permanent roles for internships", () => {
    for (const t of [
      "Software Engineer",
      "New Grad Software Engineer",
      "Junior Backend Developer",
      "Software Engineer I",
      "Associate Data Engineer",
      // "International" contains "intern" as a substring — must not match.
      "International Software Engineer",
    ]) {
      expect(isInternship(t), t).toBe(false);
    }
  });

  it("keeps them out of the shortlist entirely", () => {
    const coop = {
      source: "simplify-newgrad",
      externalKey: "simplify-newgrad:coop",
      company: "Later",
      title: "AI Automation Co-op (Fall 2026)",
      url: "https://example.test/1",
      locations: ["Vancouver, BC, Canada"],
      postedAt: new Date("2026-08-29T12:00:00Z"),
      category: "Software",
      sponsorship: null,
    };
    const out = shortlist([coop], {
      freshnessHours: 24,
      alreadySent: new Set<string>(),
      now: new Date("2026-08-29T18:00:00Z"),
    });
    expect(out).toHaveLength(0);
  });
});

describe("hasEntryLevelMarker after the new-grad-only change", () => {
  it("counts new-grad wording", () => {
    expect(hasEntryLevelMarker("New Grad Software Engineer")).toBe(true);
    expect(hasEntryLevelMarker("Junior Developer")).toBe(true);
    expect(hasEntryLevelMarker("Software Engineer I")).toBe(true);
  });

  it("no longer counts intern or co-op as a new-grad signal", () => {
    expect(hasEntryLevelMarker("Software Engineer Intern")).toBe(false);
    expect(hasEntryLevelMarker("AI Automation Co-op (Fall 2026)")).toBe(false);
  });
});
