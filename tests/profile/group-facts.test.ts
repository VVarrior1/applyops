import { describe, it, expect } from "vitest";
import { groupFacts } from "../../src/profile/group-facts";

interface TestFact {
  category: string;
  text: string;
}

function fact(category: string, text: string): TestFact {
  return { category, text };
}

describe("groupFacts", () => {
  it("orders categories experience -> project -> education -> other -> skill regardless of input order", () => {
    const facts = [
      fact("skill", "TypeScript"),
      fact("other", "Volunteers weekly"),
      fact("education", "BSc Computer Science"),
      fact("project", "Built a scraper"),
      fact("experience", "Software engineer at Acme"),
    ];

    const groups = groupFacts(facts);

    expect(groups.map((g) => g.category)).toEqual([
      "experience",
      "project",
      "education",
      "other",
      "skill",
    ]);
  });

  it("matches the owner's resume distribution: 32 skill, 11 experience, 4 project, 2 education", () => {
    const facts = [
      ...Array.from({ length: 32 }, (_, i) => fact("skill", `Skill ${i}`)),
      ...Array.from({ length: 11 }, (_, i) => fact("experience", `Experience ${i}`)),
      ...Array.from({ length: 4 }, (_, i) => fact("project", `Project ${i}`)),
      ...Array.from({ length: 2 }, (_, i) => fact("education", `Education ${i}`)),
    ];

    const groups = groupFacts(facts);

    expect(groups.map((g) => ({ category: g.category, count: g.count }))).toEqual([
      { category: "experience", count: 11 },
      { category: "project", count: 4 },
      { category: "education", count: 2 },
      { category: "skill", count: 32 },
    ]);
  });

  it("counts each group's facts correctly and preserves within-category order", () => {
    const facts = [fact("experience", "A"), fact("experience", "B"), fact("skill", "C")];
    const groups = groupFacts(facts);

    const experience = groups.find((g) => g.category === "experience");
    expect(experience?.count).toBe(2);
    expect(experience?.facts.map((f) => f.text)).toEqual(["A", "B"]);

    const skill = groups.find((g) => g.category === "skill");
    expect(skill?.count).toBe(1);
  });

  it("omits categories with zero facts entirely", () => {
    const groups = groupFacts([fact("skill", "Only one category present")]);
    expect(groups).toHaveLength(1);
    expect(groups[0].category).toBe("skill");
  });

  it("returns an empty array for an empty input", () => {
    expect(groupFacts([])).toEqual([]);
  });

  it("gives each group a human-readable label", () => {
    const groups = groupFacts([
      fact("experience", "x"),
      fact("project", "x"),
      fact("education", "x"),
      fact("other", "x"),
      fact("skill", "x"),
    ]);

    expect(groups.map((g) => g.label)).toEqual([
      "Experience",
      "Projects",
      "Education",
      "Other",
      "Skills",
    ]);
  });

  it("appends unrecognized categories after the known ones instead of dropping them", () => {
    const groups = groupFacts([fact("skill", "x"), fact("mystery", "y"), fact("experience", "z")]);
    expect(groups.map((g) => g.category)).toEqual(["experience", "skill", "mystery"]);
    expect(groups.find((g) => g.category === "mystery")?.label).toBe("mystery");
  });

  it("is generic over any fact-like shape carrying extra fields (e.g. a persisted row with a label/source)", () => {
    interface Row {
      category: string;
      label: string;
      text: string;
      source: string;
    }
    const rows: Row[] = [
      { category: "skill", label: "F-001", text: "TypeScript", source: "resume_upload" },
      { category: "experience", label: "F-002", text: "Worked at Acme", source: "manual" },
    ];

    const groups = groupFacts(rows);
    expect(groups.map((g) => g.category)).toEqual(["experience", "skill"]);
    expect(groups[0].facts[0].label).toBe("F-002");
  });
});
