import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveExperienceFromSections,
  enrichExperience,
  enrichTailorFromBase,
  experienceRegion,
  extractBaseExperience,
  scoreEntryMatch,
  splitDateRange,
  type BaseExperienceEntry,
} from "@/src/pdf/base-entries";
import type { TailorOutput } from "@/src/pipeline/schemas";

const BASE = readFileSync(path.resolve(__dirname, "fixtures/resume-base.tex"), "utf-8");

function tailor(overrides: Partial<TailorOutput> = {}): TailorOutput {
  return {
    summary: "Backend-leaning new grad.",
    skills: ["TypeScript", "PostgreSQL"],
    sections: [],
    ...overrides,
  };
}

describe("extractBaseExperience", () => {
  it("reads employer, dates, title and location out of the Experience section", () => {
    const entries = extractBaseExperience(BASE);

    expect(entries.map((e) => e.organization)).toEqual([
      "Northwind Labs",
      "City Utilities Board",
      "Contoso Retail",
    ]);
    expect(entries[0]).toEqual({
      organization: "Northwind Labs",
      role: "Software Engineering Expert",
      location: "Remote",
      start: "November 2025",
      end: "Present",
    });
    expect(entries[2].start).toBe("March 2025");
    expect(entries[2].end).toBe("June 2025");
  });

  it("never reads the Education subheading as a job", () => {
    // Jake's template reuses `\resumeSubheading` for the degree with the
    // arguments in a different order — `{State University}{Springfield, ST}` —
    // so a document-wide scan would print a degree as an employer whose start
    // date is a city.
    const entries = extractBaseExperience(BASE);
    expect(entries.some((e) => /university/i.test(e.organization))).toBe(false);
    expect(entries.some((e) => /springfield, st/i.test(e.start))).toBe(false);
  });

  it("returns nothing for a base with no Experience section", () => {
    expect(extractBaseExperience("\\documentclass{article}")).toEqual([]);
    expect(experienceRegion("\\documentclass{article}")).toBeNull();
  });
});

describe("splitDateRange", () => {
  it("splits every dash a LaTeX resume actually uses", () => {
    expect(splitDateRange("November 2025 -- Present")).toEqual({
      start: "November 2025",
      end: "Present",
    });
    expect(splitDateRange("June 2025 – September 2025")).toEqual({
      start: "June 2025",
      end: "September 2025",
    });
    expect(splitDateRange("2023 - 2024")).toEqual({ start: "2023", end: "2024" });
  });

  it("keeps a single date as the start", () => {
    expect(splitDateRange("Dec 2026")).toEqual({ start: "Dec 2026", end: "" });
  });

  it("returns nothing at all for an argument that is not a date", () => {
    // A wrong start date on a job application is worse than a missing one.
    expect(splitDateRange("Calgary, AB")).toEqual({ start: "", end: "" });
    expect(splitDateRange("Springfield, ST")).toEqual({ start: "", end: "" });
  });
});

describe("enrichExperience", () => {
  const base: BaseExperienceEntry[] = [
    {
      organization: "Northwind Labs",
      role: "Software Engineering Expert",
      location: "Remote",
      start: "November 2025",
      end: "Present",
    },
    {
      organization: "Contoso Retail",
      role: "Data Intern",
      location: "Springfield, ST",
      start: "March 2025",
      end: "June 2025",
    },
  ];

  const bullets = [{ text: "Shipped a thing.", fact_ids: ["F-001"] }];

  it("fills the empty header fields the facts could not supply", () => {
    const [entry] = enrichExperience(
      [{ organization: "Northwind Labs", role: "", location: "", start: "", end: "", bullets }],
      base,
    );
    expect(entry).toMatchObject({
      role: "Software Engineering Expert",
      location: "Remote",
      start: "November 2025",
      end: "Present",
    });
  });

  it("never overwrites what the model cited from the facts", () => {
    const [entry] = enrichExperience(
      [
        {
          organization: "Northwind Labs",
          role: "AI Training Engineer",
          location: "Calgary, AB",
          start: "",
          end: "",
          bullets,
        },
      ],
      base,
    );
    expect(entry.role).toBe("AI Training Engineer");
    expect(entry.location).toBe("Calgary, AB");
    expect(entry.start).toBe("November 2025");
  });

  it("leaves an employer the base resume does not have alone", () => {
    const [entry] = enrichExperience(
      [{ organization: "Some Startup", role: "", location: "", start: "", end: "", bullets }],
      base,
    );
    expect(entry.start).toBe("");
    expect(entry.role).toBe("");
  });

  it("gives one base entry to at most one tailored entry", () => {
    // Two entries both matching "Northwind Labs" must not both print
    // November 2025 – Present: a duplicated date range reads as one job listed
    // twice, and nothing downstream catches it.
    const enriched = enrichExperience(
      [
        { organization: "Northwind Labs", role: "", location: "", start: "", end: "", bullets },
        { organization: "Northwind", role: "", location: "", start: "", end: "", bullets },
      ],
      base,
    );
    const starts = enriched.map((e) => e.start).filter(Boolean);
    expect(new Set(starts).size).toBe(starts.length);
  });

  it("matches when the base swapped employer and title", () => {
    // The owner's own resume writes one entry as `{Co-Founder}{…}{GenLabs
    // Inc.}{…}` — the title in the employer slot.
    const swapped: BaseExperienceEntry[] = [
      {
        organization: "Co-Founder",
        role: "GenLabs Inc. (genlabs.ca)",
        location: "Calgary, AB",
        start: "June 2025",
        end: "September 2025",
      },
    ];
    const [entry] = enrichExperience(
      [{ organization: "GenLabs", role: "Co-Founder", location: "", start: "", end: "", bullets }],
      swapped,
    );
    expect(entry.start).toBe("June 2025");
    expect(entry.end).toBe("September 2025");
  });

  it("does not match two different employers on a shared job title", () => {
    expect(
      scoreEntryMatch(
        { organization: "Globex", role: "Software Engineer" },
        {
          organization: "Initech",
          role: "Software Engineer",
          location: "",
          start: "",
          end: "",
        },
      ),
    ).toBe(0);
  });
});

describe("deriveExperienceFromSections", () => {
  const base = extractBaseExperience(BASE);

  it("names a legacy row's anonymous bullets after the base's real employers", () => {
    const derived = deriveExperienceFromSections(
      tailor({
        sections: [
          {
            heading: "Experience",
            bullets: [
              { text: "At Contoso Retail, analysed 100K+ rows.", fact_ids: ["F-002"] },
              { text: "At Northwind Labs, evaluated LLM output.", fact_ids: ["F-001"] },
            ],
          },
        ],
      }),
      base,
    );

    expect(derived.map((e) => e.organization)).toEqual(["Contoso Retail", "Northwind Labs"]);
    // Order follows the tailor's bullets ("most relevant first"), not the base.
    expect(derived[0].start).toBe("March 2025");
    expect(derived[1].end).toBe("Present");
    expect(derived[0].bullets[0].fact_ids).toEqual(["F-002"]);
  });

  it("refuses to file a bullet under an employer it does not name", () => {
    // The bug this replaced: unmatched bullets were dealt out to whichever
    // base entry was still empty, which filed the City of Calgary's GHG
    // pipeline under Mercor. Wrong employer is a false statement about the
    // candidate's history, so one unplaceable bullet forfeits the derivation
    // and the loose section stays exactly as it was.
    const derived = deriveExperienceFromSections(
      tailor({
        sections: [
          {
            heading: "Experience",
            bullets: [
              { text: "At Northwind Labs, evaluated LLM output.", fact_ids: ["F-001"] },
              { text: "Built an automated data pipeline.", fact_ids: ["F-002"] },
            ],
          },
        ],
      }),
      base,
    );
    expect(derived).toEqual([]);
  });

  it("keeps every bullet when it does derive", () => {
    const bullets = [
      { text: "At Contoso Retail, analysed 100K+ rows.", fact_ids: ["F-002"] },
      { text: "At Northwind Labs, evaluated LLM output.", fact_ids: ["F-001"] },
    ];
    const derived = deriveExperienceFromSections(
      tailor({ sections: [{ heading: "Experience", bullets }] }),
      base,
    );
    expect(derived.flatMap((e) => e.bullets)).toHaveLength(bullets.length);
    expect(derived.every((e) => e.bullets.length > 0)).toBe(true);
  });

  it("returns nothing when there is no Experience section to work from", () => {
    expect(deriveExperienceFromSections(tailor(), base)).toEqual([]);
    expect(
      deriveExperienceFromSections(
        tailor({
          sections: [{ heading: "Experience", bullets: [{ text: "x", fact_ids: ["F-1"] }] }],
        }),
        [],
      ),
    ).toEqual([]);
  });
});

describe("enrichTailorFromBase", () => {
  it("is a no-op without a base resume", () => {
    const input = tailor({
      experience: [
        { organization: "Northwind Labs", role: "", location: "", start: "", end: "", bullets: [] },
      ],
    });
    expect(enrichTailorFromBase(input, null)).toBe(input);
    expect(enrichTailorFromBase(input, "   ")).toBe(input);
  });

  it("dates a current generation's employment history", () => {
    const out = enrichTailorFromBase(
      tailor({
        experience: [
          {
            organization: "Northwind Labs",
            role: "AI Training Engineer",
            location: "Remote",
            start: "",
            end: "",
            bullets: [{ text: "Trained frontier models.", fact_ids: ["F-001"] }],
          },
        ],
      }),
      BASE,
    );
    expect(out.experience?.[0].start).toBe("November 2025");
    expect(out.experience?.[0].end).toBe("Present");
    expect(out.experience?.[0].role).toBe("AI Training Engineer");
  });

  it("rebuilds a pre-1.2.0 generation's Experience and Projects blocks", () => {
    const out = enrichTailorFromBase(
      tailor({
        sections: [
          {
            heading: "Experience",
            // Names its employer, so it can be filed under one.
            bullets: [{ text: "At Northwind Labs, evaluated LLMs.", fact_ids: ["F-001"] }],
          },
          {
            heading: "Projects",
            bullets: [
              { text: "Built a Kanban board with role-based access.", fact_ids: ["F-020"] },
            ],
          },
        ],
      }),
      BASE,
    );

    expect(out.experience?.[0].organization).toBe("Northwind Labs");
    expect(out.experience?.[0].start).toBe("November 2025");
    expect(out.projects?.length).toBeGreaterThan(0);
    expect(out.projects?.[0].name).not.toBe("");
    // Citations survive the round trip, so nothing the hallucination gate let
    // through is silently laundered into an uncited bullet.
    expect(out.projects?.[0].bullets[0].fact_ids).toEqual(["F-020"]);
  });

  it("leaves the loose sections in place when nothing can be derived", () => {
    const input = tailor({
      sections: [{ heading: "Leadership", bullets: [{ text: "Ran a club.", fact_ids: ["F-1"] }] }],
    });
    const out = enrichTailorFromBase(input, BASE);
    expect(out.experience).toBeUndefined();
    expect(out.sections).toEqual(input.sections);
  });
});

describe("scoreEntryMatch", () => {
  const genlabs: BaseExperienceEntry = {
    organization: "Co-Founder",
    role: "GenLabs Inc. (genlabs.ca)",
    location: "Calgary, AB",
    start: "June 2025",
    end: "September 2025",
  };

  it("never matches on the job title alone", () => {
    // QA regression: "Launch Loom / Founder & Full-Stack Engineer" matched
    // "Co-Founder / GenLabs Inc." on the single word *founder*, and the resume
    // then claimed Launch Loom ran June–September 2025 — GenLabs' dates, on a
    // company the candidate never worked those dates for.
    expect(
      scoreEntryMatch(
        { organization: "Launch Loom", role: "Founder & Full-Stack Engineer" },
        genlabs,
      ),
    ).toBe(0);
  });

  it("still matches an employer the base filed under its title slot", () => {
    expect(
      scoreEntryMatch({ organization: "GenLabs", role: "Co-Founder" }, genlabs),
    ).toBeGreaterThan(0);
  });

  it("ignores an entry with no organization at all", () => {
    expect(scoreEntryMatch({ organization: "", role: "Co-Founder" }, genlabs)).toBe(0);
  });
});
