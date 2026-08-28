import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FAMILIAR_SKILLS,
  PROJECTS_END_REGEX,
  PROJECTS_START_REGEX,
  SKILLS_REGEX,
  deriveProjectsFromSections,
  escapeLatex,
  extractBaseProjects,
  LatexUnavailableError,
  compileLatexToPdf,
  isLatexAvailable,
  latexToPlain,
  renderLatexResume,
  replaceProjectsSection,
  replaceSkillsSection,
  resetLatexAvailabilityCache,
  spliceTailoredResume,
} from "@/src/pdf/latex";
import type { TailorOutput } from "@/src/pipeline/schemas";

/**
 * The fixture is a structural copy of the owner's real `resume.tex` — same
 * preamble, same `%-----------…-----------` banners, same custom commands,
 * same nesting depth in the project headings — with every piece of personal
 * data replaced by an invented one. It has to be structurally exact because
 * these tests exist to protect v1's splice regexes, and it has to be
 * PII-free because it lives in the repository.
 */
const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "resume-base.tex",
);
const BASE = readFileSync(FIXTURE_PATH, "utf-8");

const SKILLS_BANNER = "%-----------TECHNICAL SKILLS-----------";
const PROJECTS_BANNER = "%-----------PROJECTS-----------";

/** Everything above the Technical Skills block: preamble + heading. */
function head(tex: string): string {
  return tex.slice(0, tex.indexOf(SKILLS_BANNER));
}

/** Everything between the skills block and the projects block: Education + Experience. */
function middle(tex: string): string {
  const from = tex.indexOf("\\end{itemize}", tex.indexOf(SKILLS_BANNER));
  return tex.slice(from, tex.indexOf(PROJECTS_BANNER));
}

/** Everything from `\resumeSubHeadingListEnd` to EOF: the document close. */
function tail(tex: string): string {
  return tex.slice(tex.search(PROJECTS_END_REGEX));
}

const TAILOR: TailorOutput = {
  summary: "Backend-leaning new grad.",
  skills: ["Go", "PostgreSQL", "Kubernetes", "TypeScript", "AWS"],
  sections: [
    {
      heading: "Experience",
      bullets: [{ text: "Shipped a data pipeline.", fact_ids: ["F-001"] }],
    },
    {
      heading: "Projects",
      bullets: [
        { text: "Built a Kanban app with role-based access control.", fact_ids: ["F-002"] },
        { text: "Architected a booking platform on Next.js and Supabase.", fact_ids: ["F-003"] },
        { text: "Engineered a fashion recommender with FAISS and RAG.", fact_ids: ["F-004"] },
        { text: "Launched a gamified learning platform.", fact_ids: ["F-005"] },
      ],
    },
  ],
};

describe("escapeLatex", () => {
  it("escapes every character v1 escaped", () => {
    expect(escapeLatex("100% & $5 #1 a_b c^d e~f {g} h")).toBe(
      "100\\% \\& \\$5 \\#1 a\\_b c\\textasciicircum{}d e\\textasciitilde{}f \\{g\\} h",
    );
  });

  it("reproduces v1's backslash quirk exactly", () => {
    // v1 replaced `\` first, then `{`/`}` — which re-escapes the braces its
    // own \textbackslash{} just introduced. The result is valid, safe LaTeX
    // that renders as `\{}` rather than `\`. Pinned here rather than fixed:
    // this is a faithful port, resume bullets do not contain backslashes, and
    // the day someone does fix it this test says what changes.
    expect(escapeLatex("a\\b")).toBe("a\\textbackslash\\{\\}b");
  });

  it("leaves plain text alone", () => {
    expect(escapeLatex("Built a booking platform")).toBe("Built a booking platform");
  });
});

describe("latexToPlain", () => {
  it("drops the URL and colour arguments but keeps the label", () => {
    expect(
      latexToPlain(
        "\\textbf{\\href{https://booking.example.com}{\\textcolor{myblue}{Pitch Booking (Live at booking.example.com)}}}",
      ),
    ).toBe("Pitch Booking (Live at booking.example.com)");
  });
});

describe("v1's splice regexes still match a Jake's-template resume", () => {
  it("matches the Technical Skills block", () => {
    expect(SKILLS_REGEX.test(BASE)).toBe(true);
  });

  it("matches both ends of the Projects block", () => {
    expect(PROJECTS_START_REGEX.test(BASE)).toBe(true);
    expect(PROJECTS_END_REGEX.test(BASE)).toBe(true);
  });
});

describe("replaceSkillsSection", () => {
  const out = replaceSkillsSection(BASE, ["Go", "PostgreSQL", "Kubernetes"]);

  it("writes the tailored skills into the Proficient line", () => {
    expect(out).toContain("\\textbf{Proficient}{: Go, PostgreSQL, Kubernetes}");
    expect(out).not.toContain("Pandas");
  });

  it("keeps the base resume's own Familiar line rather than a hardcoded list", () => {
    expect(out).toContain("\\textbf{Familiar}{: C, C++, C\\#, AWS, CI/CD,  Agile Methodologies, UX/UI Principles}");
  });

  it("drops a tailored skill the base already lists as Familiar (v1's rule)", () => {
    const withFamiliar = replaceSkillsSection(BASE, ["Go", "AWS", "PostgreSQL"]);
    expect(withFamiliar).toContain("\\textbf{Proficient}{: Go, PostgreSQL}");
  });

  it("changes nothing outside the skills block", () => {
    expect(head(out)).toBe(head(BASE));
    expect(middle(out)).toBe(middle(BASE));
    expect(tail(out)).toBe(tail(BASE));
  });

  it("leaves a resume with no matching block completely alone", () => {
    const alien = "\\documentclass{article}\\begin{document}hi\\end{document}";
    expect(replaceSkillsSection(alien, ["Go"])).toBe(alien);
  });

  it("falls back to v1's Familiar list when the base has none", () => {
    const noFamiliar = BASE.replace(
      / \\\\\n    \\textbf\{Familiar\}\{: [^\n]*\n/,
      "\n",
    );
    const out2 = replaceSkillsSection(noFamiliar, ["Go"]);
    expect(out2).toContain(`\\textbf{Familiar}{: ${DEFAULT_FAMILIAR_SKILLS.map(escapeLatex).join(", ")}}`);
  });
});

describe("extractBaseProjects", () => {
  const projects = extractBaseProjects(BASE);

  it("finds every \\resumeProjectHeading in the Projects block", () => {
    expect(projects.map((p) => p.name)).toEqual([
      "Pitch Booking (Live at booking.example.com)",
      "Questly (Live at questly.example.com)",
      "TaskBoard – Full-Stack KanBan App",
      "Fashion Recommendation Engine",
    ]);
  });

  it("reads the technologies after the $|$ separator", () => {
    expect(projects[2].technologies).toBe("Next.js, Prisma, SQL, Docker, Tailwind CSS");
  });

  it("keeps the raw heading, hyperlink and all, so it can be reused verbatim", () => {
    expect(projects[0].headingRaw).toContain("\\href{https://booking.example.com}");
    expect(projects[0].headingRaw).toContain("\\textcolor{myblue}");
  });
});

describe("replaceProjectsSection", () => {
  const out = replaceProjectsSection(BASE, [
    { headingRaw: "\\textbf{One} $|$ \\emph{Go}", bullets: ["Did a thing.", "Did another."] },
    { headingRaw: "\\textbf{Two} $|$ \\emph{Rust}", bullets: ["Did a third."] },
  ]);

  it("emits v1's block shape, one \\resumeItem per bullet", () => {
    expect(out).toContain("\\item \\resumeProjectHeading\n    {\\textbf{One} $|$ \\emph{Go}}{}");
    expect(out).toContain("      \\resumeItem{Did a thing.}\n      \\resumeItem{Did another.}");
  });

  it("drops the base's own projects", () => {
    expect(out).not.toContain("Questly");
    expect(out).not.toContain("Fashion Recommendation Engine");
  });

  it("caps a project at 3 bullets", () => {
    const capped = replaceProjectsSection(BASE, [
      { headingRaw: "\\textbf{One}", bullets: ["a", "b", "c", "d"] },
    ]);
    expect(capped).toContain("\\resumeItem{c}");
    expect(capped).not.toContain("\\resumeItem{d}");
  });

  it("keeps the base's own closing note", () => {
    expect(out).toContain("10+ additional projects");
  });

  it("changes nothing outside the projects block", () => {
    expect(head(out)).toBe(head(BASE));
    expect(middle(out)).toBe(middle(BASE));
    expect(tail(out)).toBe(tail(BASE));
  });
});

describe("deriveProjectsFromSections (legacy tailor output, no `projects`)", () => {
  const derived = deriveProjectsFromSections(TAILOR, extractBaseProjects(BASE));

  it("matches a bullet to the base project it names", () => {
    // "Kanban" -> "TaskBoard – Full-Stack KanBan App"
    expect(derived[0].headingRaw).toContain("TaskBoard");
    expect(derived[0].bullets).toEqual(["Built a Kanban app with role-based access control."]);
  });

  it("deals unnamed bullets out to the still-empty base projects, in order", () => {
    expect(derived.map((p) => p.headingRaw.includes("Pitch Booking"))).toContain(true);
    const booking = derived.find((p) => p.headingRaw.includes("Pitch Booking"));
    expect(booking?.bullets[0]).toBe("Architected a booking platform on Next.js and Supabase.");
    const questly = derived.find((p) => p.headingRaw.includes("Questly"));
    expect(questly?.bullets[0]).toBe("Launched a gamified learning platform.");
  });

  it("orders projects by the tailored bullet order, not the base's order", () => {
    expect(derived.map((p) => p.bullets[0])).toEqual(
      TAILOR.sections[1].bullets.map((b) => b.text),
    );
  });

  it("returns nothing when there is no Projects section to work from", () => {
    expect(
      deriveProjectsFromSections(
        { ...TAILOR, sections: [TAILOR.sections[0]] },
        extractBaseProjects(BASE),
      ),
    ).toEqual([]);
  });
});

describe("spliceTailoredResume", () => {
  it("reuses the base's raw heading — hyperlink intact — for a named project", () => {
    const { tex, projectsSource } = spliceTailoredResume(BASE, {
      ...TAILOR,
      projects: [
        {
          name: "TaskBoard – Full-Stack KanBan App",
          technologies: "Next.js, Prisma",
          bullets: [{ text: "Built a Kanban app.", fact_ids: ["F-002"] }],
        },
      ],
    });
    expect(projectsSource).toBe("tailor");
    expect(tex).toContain("{\\textbf{TaskBoard – Full-Stack KanBan App} $|$ \\emph{Next.js, Prisma, SQL, Docker, Tailwind CSS}}{}");
    expect(tex).toContain("\\resumeItem{Built a Kanban app.}");
  });

  it("synthesises v1's heading for a project the base does not have", () => {
    const { tex } = spliceTailoredResume(BASE, {
      ...TAILOR,
      projects: [
        {
          name: "Weather CLI",
          technologies: "Rust & Tokio",
          bullets: [{ text: "Wrote a CLI.", fact_ids: ["F-009"] }],
        },
      ],
    });
    expect(tex).toContain("{\\textbf{Weather CLI} $|$ \\emph{Rust \\& Tokio}}{}");
  });

  it("reports the legacy path when `projects` is absent", () => {
    expect(spliceTailoredResume(BASE, TAILOR).projectsSource).toBe("derived");
  });

  it("leaves the base's projects in place when nothing can be resolved", () => {
    const { tex, projectsSource } = spliceTailoredResume(BASE, {
      ...TAILOR,
      sections: [TAILOR.sections[0]],
    });
    expect(projectsSource).toBe("base");
    expect(tex).toContain("Fashion Recommendation Engine");
  });

  it("replaces skills and projects and NOTHING else — byte for byte", () => {
    const { tex } = spliceTailoredResume(BASE, TAILOR, {
      name: "Someone Else",
      email: "someone@example.org",
      phone: "555-0000",
      links: ["example.org"],
    });
    // Preamble + heading (a contact that is not a placeholder must never
    // overwrite the heading the user wrote):
    expect(head(tex)).toBe(head(BASE));
    // Education + Experience:
    expect(middle(tex)).toBe(middle(BASE));
    expect(middle(tex)).toContain("{State University}{Springfield, ST}");
    expect(middle(tex)).toContain("{City Utilities Board}{September 2025 -- Present}");
    // Document close:
    expect(tail(tex)).toBe(tail(BASE));
    // And the two blocks that SHOULD change, did:
    expect(tex).not.toBe(BASE);
    expect(tex).toContain("\\textbf{Proficient}{: Go, PostgreSQL, Kubernetes, TypeScript}");
    expect(tex).toContain("\\resumeItem{Built a Kanban app with role-based access control.}");
  });

  it("fills {{NAME}}-style placeholders when a template base has them", () => {
    const templated = BASE.replace("Jane Q. Doe", "{{NAME}}");
    const { tex } = spliceTailoredResume(templated, TAILOR, { name: "Ada Lovelace" });
    expect(tex).toContain("Ada Lovelace");
    expect(tex).not.toContain("{{NAME}}");
  });
});

describe("isLatexAvailable", () => {
  /**
   * The one input to the PDF route's renderer choice. A host with no TeX must
   * report `false` — not throw, not hang — because the route's fallback to
   * react-pdf hangs off exactly this answer.
   */
  it("reports false for an absolute PDFLATEX_BIN that does not exist", async () => {
    const previous = process.env.PDFLATEX_BIN;
    process.env.PDFLATEX_BIN = "/nonexistent/bin/pdflatex";
    resetLatexAvailabilityCache();
    try {
      expect(await isLatexAvailable()).toBe(false);
      await expect(compileLatexToPdf("\\documentclass{article}")).rejects.toBeInstanceOf(
        LatexUnavailableError,
      );
    } finally {
      if (previous === undefined) delete process.env.PDFLATEX_BIN;
      else process.env.PDFLATEX_BIN = previous;
      resetLatexAvailabilityCache();
    }
  });
});

/**
 * The real thing. Skipped — not failed — on a host without a TeX
 * distribution, because that host is a legitimate deployment target: the PDF
 * route falls back to react-pdf there. `npm test` on the owner's Mac (MacTeX
 * at /Library/TeX/texbin) does run it.
 */
describe("renderLatexResume (real pdflatex)", () => {
  it("compiles the spliced resume to a real PDF", async ({ skip }) => {
    if (!(await isLatexAvailable())) {
      skip();
      return;
    }

    const result = await renderLatexResume({
      base: { latex: BASE },
      tailor: TAILOR,
    });

    expect(result.pdf.subarray(0, 4).toString("latin1")).toBe("%PDF");
    expect(result.pdf.length).toBeGreaterThan(10_000);
    expect(result.tex).toContain("\\textbf{Proficient}{: Go, PostgreSQL");
    expect(result.transcriptMerged).toBe(false);

    // The point of the whole exercise: the base resume's own sections come
    // out of the PDF verbatim, not redrawn. Checked through pdftotext when
    // it is installed.
    let text: string;
    try {
      text = execFileSync("pdftotext", ["-", "-"], {
        input: result.pdf,
        encoding: "utf-8",
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch {
      return; // no poppler on this host; the bytes above are still checked
    }
    expect(text).toContain("State University");
    expect(text).toContain("City Utilities Board");
    expect(text).toContain("Jane Q. Doe");
    expect(text).toContain("Built a Kanban app with role-based access control.");
    expect(text).not.toContain("Pandas");
  }, 180_000);
});
