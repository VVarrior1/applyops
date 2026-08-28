import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SKILLS_REGEX,
  flattenSkillGroups,
  isLegacySkillsShape,
  mergeSkillGroups,
  parseSkillGroups,
  parseSkillGroupsFromBlock,
  renderSkillGroups,
  splitSkillItems,
  unescapeLatexSpecials,
} from "@/src/pdf/skills-groups";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

/**
 * The owner's real Technical Skills block, spliced into the PII-free base
 * fixture — four hand-chosen categories, an escaped `\&` in two labels, a
 * parenthesised "GCP (Vertex AI, BigQuery)", and a semicolon-separated tail on
 * the AI/ML line. Everything this module has to survive, in one document.
 */
const GROUPED = readFileSync(path.join(FIXTURES, "resume-base-grouped.tex"), "utf-8");
/** The v1-shaped base: `Proficient` / `Familiar`, nothing else. */
const LEGACY = readFileSync(path.join(FIXTURES, "resume-base.tex"), "utf-8");

/** The raw body of a document's Technical Skills itemize (capture group 2). */
function skillsBody(tex: string): string {
  const match = tex.match(SKILLS_REGEX);
  if (!match) throw new Error("fixture has no Technical Skills block");
  return match[2];
}

describe("parseSkillGroups", () => {
  const groups = parseSkillGroups(GROUPED);

  it("finds every category, in the order the base writes them", () => {
    expect(groups.map((g) => g.label)).toEqual([
      "Languages",
      "Frameworks & Data",
      "Cloud & Infrastructure",
      "AI/ML",
    ]);
  });

  it("unescapes `\\&` in a label so the model is shown plain text", () => {
    expect(groups[1].label).toBe("Frameworks & Data");
    expect(groups[1].label).not.toContain("\\");
  });

  it("splits items on top-level commas", () => {
    expect(groups[0].items).toEqual([
      "Python",
      "TypeScript/JavaScript",
      "SQL",
      "Java",
    ]);
  });

  it("keeps a parenthesised group intact rather than splitting inside it", () => {
    expect(groups[2].items).toEqual([
      "GCP (Vertex AI, BigQuery)",
      "Azure",
      "Vercel",
      "Docker",
      "Git",
      "CI/CD",
      "Power BI",
    ]);
  });

  it("makes a semicolon-separated tail its own items, keeping the separator", () => {
    expect(groups[3].items).toEqual([
      "LLM \\& RAG application design",
      "RLHF evaluation",
      "prompt engineering",
      // The `;` rides on the item it follows: that is the only place it can
      // live in a `{label, items}` pair, and losing it would rewrite the
      // punctuation of the owner's own resume.
      "computer vision (YOLOv8/v11, OpenCV, PyTorch);",
      "Claude Code",
      "Cursor",
      "MCP",
    ]);
  });

  it("leaves item text as the LaTeX the author wrote it in", () => {
    // `\&` is unescaped for labels and deliberately NOT for items — an item
    // may be a macro, and unescape/re-escape would mangle it.
    expect(groups[3].items[0]).toBe("LLM \\& RAG application design");
  });

  it("reads a v1 Proficient/Familiar block as two groups", () => {
    const legacy = parseSkillGroups(LEGACY);
    expect(legacy.map((g) => g.label)).toEqual(["Proficient", "Familiar"]);
    expect(legacy[1].items).toContain("C\\#");
    expect(isLegacySkillsShape(legacy)).toBe(true);
    expect(isLegacySkillsShape(groups)).toBe(false);
  });

  it("returns [] for a document with no Technical Skills block", () => {
    expect(parseSkillGroups("\\documentclass{article}\\begin{document}hi\\end{document}")).toEqual(
      [],
    );
  });

  it("returns [] for a skills block written some other way", () => {
    const freeform = GROUPED.replace(
      skillsBody(GROUPED),
      "Python, SQL, Java, TypeScript, Next.js\n  ",
    );
    expect(parseSkillGroups(freeform)).toEqual([]);
  });

  it("does not split inside a braced macro in an item", () => {
    const parsed = parseSkillGroupsFromBlock(
      "\\textbf{Tooling}{: \\href{https://x.test}{Git, Docker}, Vercel}",
    );
    expect(parsed).toEqual([
      { label: "Tooling", items: ["\\href{https://x.test}{Git, Docker}", "Vercel"] },
    ]);
  });

  it("ignores a bold word that is not a category line", () => {
    const parsed = parseSkillGroupsFromBlock(
      "\\textbf{Note} see below \\\\\n\\textbf{Languages}{: Python, Go}",
    );
    expect(parsed).toEqual([{ label: "Languages", items: ["Python", "Go"] }]);
  });
});

describe("renderSkillGroups", () => {
  it("reproduces the owner's block character for character", () => {
    const body = skillsBody(GROUPED);
    // `trimEnd` only: the newline + two spaces before the closing `}}` is
    // whitespace the splice re-supplies, and v1's renderer never emitted it
    // either.
    expect(renderSkillGroups(parseSkillGroups(GROUPED))).toBe(body.trimEnd());
  });

  it("round-trips: parse(render(parse(base))) === parse(base)", () => {
    const once = parseSkillGroups(GROUPED);
    const twice = parseSkillGroupsFromBlock(renderSkillGroups(once));
    expect(twice).toEqual(once);
  });

  it("round-trips a v1 Proficient/Familiar block too", () => {
    const once = parseSkillGroups(LEGACY);
    expect(parseSkillGroupsFromBlock(renderSkillGroups(once))).toEqual(once);
  });

  it("re-escapes `&` in a label", () => {
    expect(renderSkillGroups([{ label: "Frameworks & Data", items: ["React"] }])).toBe(
      "\\textbf{Frameworks \\& Data}{: React}",
    );
  });

  it("escapes a plain-text item a model returned, and leaves LaTeX alone", () => {
    expect(
      renderSkillGroups([{ label: "Languages", items: ["C#", "C\\#", "A & B"] }]),
    ).toBe("\\textbf{Languages}{: C\\#, C\\#, A \\& B}");
  });

  it("joins lines with ` \\\\` and indents every line but the first", () => {
    const rendered = renderSkillGroups([
      { label: "A", items: ["one"] },
      { label: "B", items: ["two"] },
    ]);
    expect(rendered).toBe("\\textbf{A}{: one} \\\\\n    \\textbf{B}{: two}");
    expect(
      renderSkillGroups(
        [
          { label: "A", items: ["one"] },
          { label: "B", items: ["two"] },
        ],
        { indent: "  " },
      ),
    ).toBe("\\textbf{A}{: one} \\\\\n  \\textbf{B}{: two}");
  });

  it("drops a group with no items rather than printing a stray colon", () => {
    expect(
      renderSkillGroups([
        { label: "Languages", items: ["Python"] },
        { label: "Empty", items: [] },
      ]),
    ).toBe("\\textbf{Languages}{: Python}");
  });
});

describe("splitSkillItems", () => {
  it("balances parentheses, braces and brackets", () => {
    expect(splitSkillItems(" A (x, y), B {p, q}, C [m, n], D ")).toEqual([
      "A (x, y)",
      "B {p, q}",
      "C [m, n]",
      "D",
    ]);
  });

  it("treats an escaped brace as a literal, not a group", () => {
    expect(splitSkillItems("A \\{ B, C")).toEqual(["A \\{ B", "C"]);
  });

  it("drops empty items from a trailing or doubled comma", () => {
    expect(splitSkillItems("A,, B,")).toEqual(["A", "B"]);
  });
});

describe("unescapeLatexSpecials", () => {
  it("resolves the escapes a label can plausibly carry", () => {
    expect(unescapeLatexSpecials("Data \\& AI\\_ML \\#1 \\%")).toBe("Data & AI_ML #1 %");
  });
});

describe("mergeSkillGroups", () => {
  const base = parseSkillGroups(GROUPED);

  it("keeps the base's labels, order and spelling", () => {
    const { groups } = mergeSkillGroups(base, [
      { label: "languages", items: ["Java", "Python"] },
    ]);
    expect(groups.map((g) => g.label)).toEqual(base.map((g) => g.label));
    expect(groups[0].items).toEqual(["Java", "Python"]);
  });

  it("leaves a group the model said nothing about untouched", () => {
    const { groups } = mergeSkillGroups(base, [
      { label: "Languages", items: ["Java"] },
    ]);
    expect(groups[1]).toEqual(base[1]);
    expect(groups[3]).toEqual(base[3]);
  });

  it("ignores a label the base does not define, and names it", () => {
    const { groups, ignored } = mergeSkillGroups(base, [
      { label: "Leadership", items: ["Mentoring"] },
      { label: "Languages", items: ["Go"] },
    ]);
    expect(ignored).toEqual(["Leadership"]);
    expect(groups).toHaveLength(4);
    expect(groups.map((g) => g.label)).not.toContain("Leadership");
    expect(groups[0].items).toEqual(["Go"]);
  });

  it("keeps the base's items when the model empties a group", () => {
    const { groups } = mergeSkillGroups(base, [{ label: "Languages", items: [] }]);
    expect(groups[0]).toEqual(base[0]);
  });
});

describe("flattenSkillGroups", () => {
  it("flattens in order, dedupes, and strips the separator semicolon", () => {
    expect(
      flattenSkillGroups([
        { label: "A", items: ["Python", "SQL;"] },
        { label: "B", items: ["python", "Go"] },
      ]),
    ).toEqual(["Python", "SQL", "Go"]);
  });
});
