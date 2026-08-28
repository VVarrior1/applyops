import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveExperienceFromSections,
  enrichExperience,
  enrichTailorFromBase,
  experienceRegion,
  MIN_MATCH_SCORE,
  extractBaseExperience,
  scoreEntryMatch,
  splitDateRange,
  type BaseExperienceEntry,
} from "@/src/pdf/base-entries";
import { extraSections } from "@/src/pdf/ResumeDocument";
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

  it("reads a base whose section is headed Work/Professional Experience", () => {
    // QA regression: only a literal `\section{Experience}` was recognised, so a
    // resume headed `\section{Work Experience}` produced no base entries and
    // the whole enrichment no-opped silently — no dates on the PDF, no
    // diagnostic anywhere.
    for (const heading of ["Work Experience", "Professional Experience", "Employment Experience"]) {
      const renamed = BASE.replace("\\section{Experience}", `\\section{${heading}}`);
      expect(renamed).not.toBe(BASE);
      expect(extractBaseExperience(renamed).map((e) => e.organization)).toEqual([
        "Northwind Labs",
        "City Utilities Board",
        "Contoso Retail",
      ]);
    }
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

  it("does not date a different employer that merely shares a city word", () => {
    // QA blocker, reproduced against the owner's real base resume: it holds a
    // `City of Calgary` row, and `Calgary Co-op` / `University of Calgary`
    // scored on the single token `calgary`. The PDF then printed a different
    // company with the City of Calgary's dates and office — every string on
    // the page real, the employment history false, and nothing downstream
    // catches it.
    const city: BaseExperienceEntry[] = [
      {
        organization: "City of Springfield",
        role: "Software Engineer (Capstone Project)",
        location: "Springfield, ST",
        start: "September 2025",
        end: "Present",
      },
    ];
    for (const organization of ["Springfield Co-op", "University of Springfield"]) {
      expect(scoreEntryMatch({ organization }, city[0])).toBeLessThan(MIN_MATCH_SCORE);
      const [entry] = enrichExperience(
        [{ organization, role: "", location: "", start: "", end: "", bullets }],
        city,
      );
      expect(entry).toMatchObject({ role: "", location: "", start: "", end: "" });
    }
  });

  it("requires containment to land on whole words", () => {
    // `"canada post".includes("ada")` is true and means nothing.
    const canada: BaseExperienceEntry = {
      organization: "Canada Post",
      role: "Developer",
      location: "Ottawa, ON",
      start: "May 2024",
      end: "August 2024",
    };
    expect(scoreEntryMatch({ organization: "Ada" }, canada)).toBeLessThan(MIN_MATCH_SCORE);
    const [entry] = enrichExperience(
      [{ organization: "Ada", role: "", location: "", start: "", end: "", bullets }],
      [canada],
    );
    expect(entry.start).toBe("");
  });

  it("still pairs the matches that carry real organization evidence", () => {
    const google: BaseExperienceEntry = {
      organization: "Google Innovate Program, Customer Maps",
      role: "AI/ML Intern",
      location: "Calgary, AB",
      start: "March 2025",
      end: "June 2025",
    };
    expect(
      scoreEntryMatch({ organization: "Google" }, google),
    ).toBeGreaterThanOrEqual(MIN_MATCH_SCORE);
    expect(
      scoreEntryMatch({ organization: "Northwind Labs" }, base[0]),
    ).toBeGreaterThanOrEqual(MIN_MATCH_SCORE);
    expect(
      scoreEntryMatch({ organization: "Contoso Retail Inc." }, base[1]),
    ).toBeGreaterThanOrEqual(MIN_MATCH_SCORE);
    const [entry] = enrichExperience(
      [{ organization: "Google", role: "", location: "", start: "", end: "", bullets }],
      [google],
    );
    expect(entry.start).toBe("March 2025");
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

  it("keeps the loose Projects section when a bullet would be dropped", () => {
    // `deriveProjectsFromSections()` deals leftover bullets only to base
    // projects that are still empty, so more loose bullets than the base has
    // projects means some are placed nowhere. Populating `tailor.projects`
    // anyway made `extraSections()` drop the loose section that still held the
    // strays — six bullets in, four on the page. All or nothing instead.
    const bullets = [
      "Alpha work item one.",
      "Beta work item two.",
      "Gamma work item three.",
      "Delta work item four.",
      "Epsilon work item five.",
      "Zeta work item six.",
    ].map((text, i) => ({ text, fact_ids: [`F-1${i}`] }));
    const input = tailor({ sections: [{ heading: "Projects", bullets }] });

    const out = enrichTailorFromBase(input, BASE);
    expect(out.projects).toBeUndefined();
    expect(out.sections).toEqual(input.sections);
  });

  it("consumes a 'Relevant Projects' heading rather than printing it twice", () => {
    // The derivation matched `/project/i` while `extraSections()` compared for
    // equality against "projects", so a section headed "Relevant Projects" was
    // consumed *and* kept — the same bullet printed under a project name and
    // again as a loose section.
    const bullet = { text: "Developed a Kanban board with role-based access.", fact_ids: ["F-020"] };
    const out = enrichTailorFromBase(
      tailor({ sections: [{ heading: "Relevant Projects", bullets: [bullet] }] }),
      BASE,
    );

    expect(out.projects?.flatMap((p) => p.bullets.map((b) => b.text))).toEqual([bullet.text]);
    expect(extraSections(out)).toEqual([]);
  });

  it("refuses to derive when two sections both claim the projects heading", () => {
    // `extraSections()` would suppress both once `projects` is populated,
    // while the derivation only ever reads one — the other's bullets would
    // simply disappear.
    const input = tailor({
      sections: [
        { heading: "Projects", bullets: [{ text: "Built a Kanban board.", fact_ids: ["F-020"] }] },
        {
          heading: "Selected Projects",
          bullets: [{ text: "Built a recommendation engine.", fact_ids: ["F-021"] }],
        },
      ],
    });
    const out = enrichTailorFromBase(input, BASE);
    expect(out.projects).toBeUndefined();
    expect(extraSections(out).map((s) => s.heading)).toEqual(["Projects", "Selected Projects"]);
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
