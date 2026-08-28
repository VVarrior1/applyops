import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { renderResumePdf } from "@/src/pdf/render";
import { documentTitle } from "@/src/pdf/ResumeDocument";
import type { TailorOutput, Fact } from "@/src/pipeline/schemas";

const MINIMAL_TAILOR: TailorOutput = {
  summary: "Entry-level software engineer focused on backend systems.",
  skills: ["TypeScript", "PostgreSQL", "React"],
  sections: [
    {
      heading: "Experience",
      bullets: [
        { text: "Built a job-tracking pipeline used daily.", fact_ids: ["F-001"] },
      ],
    },
  ],
};

const MINIMAL_EDUCATION: Fact[] = [
  { label: "F-010", category: "education", text: "B.Sc. Computer Science, University of Alberta" },
];

describe("renderResumePdf", () => {
  it("returns a Buffer starting with %PDF for a minimal input", async () => {
    const buffer = await renderResumePdf({
      profile: { name: "Jane Doe", email: "jane@example.com", phone: "", links: [] },
      tailor: MINIMAL_TAILOR,
      education: MINIMAL_EDUCATION,
    });

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.subarray(0, 4).toString("latin1")).toBe("%PDF");
    expect(buffer.length).toBeGreaterThan(100);
  });

  it("renders with no education and no links without throwing", async () => {
    const buffer = await renderResumePdf({
      profile: { name: "No Contact", email: "no-contact@example.com", phone: "555-0100", links: ["github.com/nobody"] },
      tailor: { ...MINIMAL_TAILOR, sections: [] },
      education: [],
    });

    expect(buffer.subarray(0, 4).toString("latin1")).toBe("%PDF");
  });

  it("prints the base resume's skill categories as labelled lines", async () => {
    // The react-pdf fallback has to agree with the LaTeX renderer about the
    // *shape* of the skills block: a user whose base resume groups skills
    // under their own headings must not get one flat bullet-separated row
    // just because this host has no pdflatex.
    const buffer = await renderResumePdf({
      profile: { name: "Jane Doe", email: "jane@example.com", phone: "", links: [] },
      tailor: {
        ...MINIMAL_TAILOR,
        skill_groups: [
          { label: "Languages", items: ["Python", "TypeScript/JavaScript"] },
          // Escaped LaTeX in, plain text out — this is a PDF, not a .tex.
          { label: "Frameworks & Data", items: ["Next.js", "LLM \\& RAG design;"] },
        ],
      },
      education: MINIMAL_EDUCATION,
    });
    expect(buffer.subarray(0, 4).toString("latin1")).toBe("%PDF");

    let text: string;
    try {
      text = execFileSync("pdftotext", ["-", "-"], {
        input: buffer,
        encoding: "utf-8",
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch {
      return; // no poppler on this host
    }
    expect(text).toContain("Languages:");
    expect(text).toContain("Frameworks & Data:");
    expect(text).toContain("LLM & RAG design");
    expect(text).not.toContain("LLM \\& RAG design");
    // The flat one-line fallback must not also be drawn.
    expect(text).not.toContain("TypeScript  •  PostgreSQL");
  });
});

describe("documentTitle", () => {
  it("appends '— Resume' to a real name", () => {
    expect(documentTitle("Dana Okonkwo")).toBe("Dana Okonkwo — Resume");
  });

  it("never produces a title that starts with the dash", () => {
    // QA saw the metadata title " — Resume" / "ApplyOps Test Resume — Resume";
    // an empty or already-'Resume' name must not be interpolated blindly.
    expect(documentTitle("")).toBe("Resume");
    expect(documentTitle("   ")).toBe("Resume");
    expect(documentTitle("Dana Okonkwo Resume")).toBe("Dana Okonkwo Resume");
    expect(documentTitle("Dana Okonkwo Résumé")).toBe("Dana Okonkwo Résumé");
  });
});
