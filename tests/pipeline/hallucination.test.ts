import { describe, it, expect } from "vitest";
import {
  checkCitations,
  blockedPaths,
  stripUnsupportedBullets,
  type HallucinationReport,
} from "../../src/pipeline/hallucination";
import type { SuggestOutput, TailorOutput } from "../../src/pipeline/schemas";

/** The three-bullet fixture the build plan specifies for this checker. */
function tailorFixture(): TailorOutput {
  return {
    summary: "Backend-leaning new grad.",
    skills: ["TypeScript", "Postgres"],
    sections: [
      {
        heading: "Projects",
        bullets: [
          { text: "a", fact_ids: ["F-001"] },
          { text: "b", fact_ids: [] },
          { text: "c", fact_ids: ["F-009"] },
        ],
      },
    ],
  };
}

const validLabels = new Set(["F-001", "F-002"]);

describe("checkCitations — tailor output", () => {
  const report: HallucinationReport = checkCitations(
    tailorFixture(),
    validLabels,
  );

  it("counts every bullet as a claim", () => {
    expect(report.totalClaims).toBe(3);
  });

  it("flags the uncited bullet and the invented-id bullet", () => {
    expect(report.unsupported).toHaveLength(2);
    expect(report.unsupported.map((u) => u.path)).toEqual([
      "sections[0].bullets[1]",
      "sections[0].bullets[2]",
    ]);
  });

  it("reports the offending text and which ids were bad", () => {
    expect(report.unsupported[0]).toEqual({
      path: "sections[0].bullets[1]",
      text: "b",
      badIds: [],
    });
    expect(report.unsupported[1]).toEqual({
      path: "sections[0].bullets[2]",
      text: "c",
      badIds: ["F-009"],
    });
  });

  it("computes the unsupported rate", () => {
    expect(report.rate).toBeCloseTo(2 / 3, 3);
  });

  it("returns a clean report when every bullet cites a known fact", () => {
    const clean = checkCitations(
      {
        ...tailorFixture(),
        sections: [
          {
            heading: "Projects",
            bullets: [
              { text: "a", fact_ids: ["F-001"] },
              { text: "b", fact_ids: ["F-002", "F-001"] },
            ],
          },
        ],
      },
      validLabels,
    );
    expect(clean.totalClaims).toBe(2);
    expect(clean.unsupported).toEqual([]);
    expect(clean.rate).toBe(0);
  });

  it("treats a claim with no claims at all as rate 0, not NaN", () => {
    const empty = checkCitations(
      { summary: "", skills: [], sections: [] },
      validLabels,
    );
    expect(empty.totalClaims).toBe(0);
    expect(empty.rate).toBe(0);
  });

  it("keeps section indexes distinct across sections", () => {
    const report2 = checkCitations(
      {
        summary: "",
        skills: [],
        sections: [
          { heading: "A", bullets: [{ text: "ok", fact_ids: ["F-001"] }] },
          { heading: "B", bullets: [{ text: "bad", fact_ids: ["F-777"] }] },
        ],
      },
      validLabels,
    );
    expect(report2.unsupported.map((u) => u.path)).toEqual([
      "sections[1].bullets[0]",
    ]);
  });

  it("matches labels case-insensitively and ignores surrounding whitespace", () => {
    const report3 = checkCitations(
      {
        summary: "",
        skills: [],
        sections: [
          { heading: "A", bullets: [{ text: "ok", fact_ids: [" f-001 "] }] },
        ],
      },
      validLabels,
    );
    expect(report3.unsupported).toEqual([]);
  });
});

describe("checkCitations — suggest output", () => {
  const suggest: SuggestOutput = {
    gaps: [
      { requirement: "3 years Go", severity: "high", how_to_close: "Build one." },
    ],
    lead_with: [
      { fact_ids: ["F-002"], why: "Closest match to the stack." },
      { fact_ids: [], why: "Unsourced advice." },
    ],
    weekend_build: {
      idea: "Ship a small Go service.",
      why: "Covers the gap.",
      fact_ids: ["F-123"],
    },
    likely_questions: ["Tell me about a hard bug."],
    keywords_to_include: ["Go", "gRPC"],
  };

  const report = checkCitations(suggest, validLabels);

  it("counts lead_with entries plus the weekend build as claims", () => {
    expect(report.totalClaims).toBe(3);
  });

  it("flags the uncited lead_with entry and the invented weekend_build id", () => {
    expect(report.unsupported.map((u) => u.path)).toEqual([
      "lead_with[1]",
      "weekend_build",
    ]);
    expect(report.unsupported[1].badIds).toEqual(["F-123"]);
  });

  it("computes the unsupported rate", () => {
    expect(report.rate).toBeCloseTo(2 / 3, 3);
  });
});

describe("blockedPaths", () => {
  it("lists the paths a PDF renderer must drop", () => {
    const report = checkCitations(tailorFixture(), validLabels);
    expect(blockedPaths(report)).toEqual([
      "sections[0].bullets[1]",
      "sections[0].bullets[2]",
    ]);
  });
});

/**
 * `TailorOutput.projects` (v1 parity — the LaTeX renderer builds the Projects
 * block from it) has to go through the same gate as `sections`, or a
 * fabricated project bullet would reach a PDF uncited.
 */
describe("checkCitations — tailor `projects` bullets", () => {
  function withProjects(): TailorOutput {
    return {
      ...tailorFixture(),
      sections: [],
      projects: [
        {
          name: "KanDoIt",
          technologies: "Next.js",
          bullets: [
            { text: "real", fact_ids: ["F-001"] },
            { text: "invented", fact_ids: ["F-404"] },
          ],
        },
        {
          name: "Ghost Project",
          technologies: "",
          bullets: [{ text: "uncited", fact_ids: [] }],
        },
      ],
    };
  }

  const report = checkCitations(withProjects(), validLabels);

  it("counts a project bullet as a claim", () => {
    expect(report.totalClaims).toBe(3);
  });

  it("flags project bullets by a projects[]-rooted path", () => {
    expect(blockedPaths(report)).toEqual([
      "projects[0].bullets[1]",
      "projects[1].bullets[0]",
    ]);
  });

  it("strips the blocked bullets and drops a project left with none", () => {
    const stripped = stripUnsupportedBullets(withProjects(), report);
    expect(stripped.projects).toHaveLength(1);
    expect(stripped.projects?.[0].name).toBe("KanDoIt");
    expect(stripped.projects?.[0].bullets.map((b) => b.text)).toEqual(["real"]);
  });

  it("leaves an output with no `projects` field untouched", () => {
    const original = tailorFixture();
    const stripped = stripUnsupportedBullets(
      original,
      checkCitations(original, validLabels),
    );
    expect(stripped.projects).toBeUndefined();
  });
});

/**
 * `TailorOutput.experience` (the employer/role entries the PDF's EXPERIENCE
 * block is built from) has to go through the same gate as `sections` and
 * `projects`, or a fabricated bullet under a real employer would reach a PDF
 * uncited — the worst version of this failure, since it reads as employment
 * history rather than as a claim.
 */
describe("checkCitations — tailor `experience` bullets", () => {
  function withExperience(): TailorOutput {
    return {
      ...tailorFixture(),
      sections: [],
      experience: [
        {
          organization: "City of Calgary",
          role: "Software Engineer",
          location: "Calgary, AB",
          start: "September 2025",
          end: "Present",
          bullets: [
            { text: "real", fact_ids: ["F-001"] },
            { text: "invented", fact_ids: ["F-404"] },
          ],
        },
        {
          organization: "Ghost Employer",
          role: "",
          location: "",
          start: "",
          end: "",
          bullets: [{ text: "uncited", fact_ids: [] }],
        },
      ],
    };
  }

  const report = checkCitations(withExperience(), validLabels);

  it("counts an experience bullet as a claim", () => {
    expect(report.totalClaims).toBe(3);
  });

  it("flags experience bullets by an experience[]-rooted path", () => {
    expect(blockedPaths(report)).toEqual([
      "experience[0].bullets[1]",
      "experience[1].bullets[0]",
    ]);
  });

  it("strips the blocked bullets and drops an employer left with none", () => {
    const stripped = stripUnsupportedBullets(withExperience(), report);
    expect(stripped.experience).toHaveLength(1);
    expect(stripped.experience?.[0].organization).toBe("City of Calgary");
    expect(stripped.experience?.[0].bullets.map((b) => b.text)).toEqual(["real"]);
    // The header fields survive the strip — only bullets are filtered.
    expect(stripped.experience?.[0].start).toBe("September 2025");
  });

  it("leaves an output with no `experience` field untouched", () => {
    const original = tailorFixture();
    const stripped = stripUnsupportedBullets(
      original,
      checkCitations(original, validLabels),
    );
    expect(stripped.experience).toBeUndefined();
  });
});
