import { describe, it, expect } from "vitest";
import {
  applyTailorEdits,
  countTailorBullets,
  experienceBulletPath,
  projectBulletPath,
  tailorBulletPath,
  tailorBulletPaths,
} from "../../src/pipeline/tailor-edits";
import type { TailorOutput } from "../../src/pipeline/schemas";

function fixture(): TailorOutput {
  return {
    summary: "Backend-leaning new grad.",
    skills: ["TypeScript", "Postgres"],
    sections: [
      {
        heading: "Experience",
        bullets: [
          { text: "Built a thing", fact_ids: ["F-001"] },
          { text: "Shipped another thing", fact_ids: ["F-002"] },
        ],
      },
      {
        heading: "Projects",
        bullets: [{ text: "Side project", fact_ids: ["F-003"] }],
      },
    ],
  };
}

describe("tailorBulletPath", () => {
  it("matches hallucination.ts's path convention", () => {
    expect(tailorBulletPath(0, 1)).toBe("sections[0].bullets[1]");
  });
});

describe("applyTailorEdits", () => {
  it("returns the original output unchanged (same reference) when there are no edits", () => {
    const output = fixture();
    expect(applyTailorEdits(output, null)).toBe(output);
    expect(applyTailorEdits(output, undefined)).toBe(output);
    expect(applyTailorEdits(output, {})).toBe(output);
    expect(applyTailorEdits(output, { editedText: {}, excludedPaths: [] })).toBe(output);
  });

  it("substitutes edited bullet text without touching fact_ids or other bullets", () => {
    const output = fixture();
    const result = applyTailorEdits(output, {
      editedText: { "sections[0].bullets[0]": "Rewrote this bullet" },
    });

    expect(result.sections[0].bullets[0]).toEqual({
      text: "Rewrote this bullet",
      fact_ids: ["F-001"],
    });
    // untouched bullets are unaffected
    expect(result.sections[0].bullets[1]).toEqual(output.sections[0].bullets[1]);
    expect(result.sections[1].bullets[0]).toEqual(output.sections[1].bullets[0]);
  });

  it("drops explicitly excluded bullets", () => {
    const output = fixture();
    const result = applyTailorEdits(output, {
      excludedPaths: ["sections[0].bullets[1]"],
    });

    expect(result.sections[0].bullets).toHaveLength(1);
    expect(result.sections[0].bullets[0].text).toBe("Built a thing");
  });

  it("drops a section entirely once every one of its bullets is excluded", () => {
    const output = fixture();
    const result = applyTailorEdits(output, {
      excludedPaths: ["sections[1].bullets[0]"],
    });

    expect(result.sections).toHaveLength(1);
    expect(result.sections.map((s) => s.heading)).toEqual(["Experience"]);
  });

  it("applies text edits and exclusions together", () => {
    const output = fixture();
    const result = applyTailorEdits(output, {
      editedText: { "sections[0].bullets[0]": "Edited" },
      excludedPaths: ["sections[0].bullets[1]"],
    });

    expect(result.sections[0].bullets).toEqual([{ text: "Edited", fact_ids: ["F-001"] }]);
  });

  it("leaves summary and skills untouched", () => {
    const output = fixture();
    const result = applyTailorEdits(output, { excludedPaths: ["sections[0].bullets[0]"] });
    expect(result.summary).toBe(output.summary);
    expect(result.skills).toEqual(output.skills);
  });
});

/**
 * Since prompt 1.2.0 a tailor output's bullets live in three containers, and
 * all three are editable on the Tailor tab. An overlay that could only name
 * `sections[…]` would silently lose every edit to an employer or project
 * bullet — and the edits route's "leave at least one bullet" floor, if it
 * counted `sections` alone, would reject the very first edit of a generation
 * whose bullets are all under `experience`.
 */
function entriesFixture(): TailorOutput {
  return {
    summary: "Backend-leaning new grad.",
    skills: ["TypeScript"],
    sections: [],
    experience: [
      {
        organization: "City of Calgary",
        role: "Software Engineer",
        location: "Calgary, AB",
        start: "September 2025",
        end: "Present",
        bullets: [
          { text: "Built a pipeline", fact_ids: ["F-001"] },
          { text: "Shipped a dashboard", fact_ids: ["F-002"] },
        ],
      },
    ],
    projects: [
      {
        name: "KanDoIt",
        technologies: "Next.js",
        bullets: [{ text: "Side project", fact_ids: ["F-003"] }],
      },
    ],
  };
}

describe("bullet paths across containers", () => {
  it("names each container the way hallucination.ts does", () => {
    expect(tailorBulletPath(0, 1)).toBe("sections[0].bullets[1]");
    expect(experienceBulletPath(2, 0)).toBe("experience[2].bullets[0]");
    expect(projectBulletPath(1, 2)).toBe("projects[1].bullets[2]");
  });

  it("enumerates every bullet of an output in render order", () => {
    expect(tailorBulletPaths(entriesFixture())).toEqual([
      "experience[0].bullets[0]",
      "experience[0].bullets[1]",
      "projects[0].bullets[0]",
    ]);
    expect(countTailorBullets(entriesFixture())).toBe(3);
  });

  it("counts a legacy output's section bullets", () => {
    expect(countTailorBullets(fixture())).toBe(3);
  });
});

describe("applyTailorEdits — experience and projects", () => {
  it("substitutes edited text under an employer without touching its header", () => {
    const output = entriesFixture();
    const result = applyTailorEdits(output, {
      editedText: { "experience[0].bullets[0]": "Rewrote this bullet" },
    });

    expect(result.experience?.[0].bullets[0]).toEqual({
      text: "Rewrote this bullet",
      fact_ids: ["F-001"],
    });
    expect(result.experience?.[0].organization).toBe("City of Calgary");
    expect(result.experience?.[0].start).toBe("September 2025");
    expect(result.experience?.[0].bullets[1]).toEqual(output.experience![0].bullets[1]);
  });

  it("drops an excluded project bullet and the project left with none", () => {
    const result = applyTailorEdits(entriesFixture(), {
      excludedPaths: ["projects[0].bullets[0]"],
    });
    expect(result.projects).toEqual([]);
    expect(result.experience?.[0].bullets).toHaveLength(2);
  });

  it("can empty the whole output, which is what the route's floor checks", () => {
    const result = applyTailorEdits(entriesFixture(), {
      excludedPaths: [
        "experience[0].bullets[0]",
        "experience[0].bullets[1]",
        "projects[0].bullets[0]",
      ],
    });
    expect(countTailorBullets(result)).toBe(0);
  });

  it("never grows fields a legacy generation did not have", () => {
    const result = applyTailorEdits(fixture(), {
      editedText: { "sections[0].bullets[0]": "Edited" },
    });
    expect(result.experience).toBeUndefined();
    expect(result.projects).toBeUndefined();
  });
});
