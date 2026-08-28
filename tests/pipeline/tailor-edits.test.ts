import { describe, it, expect } from "vitest";
import { applyTailorEdits, tailorBulletPath } from "../../src/pipeline/tailor-edits";
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
