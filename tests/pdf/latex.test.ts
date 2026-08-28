import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FAMILIAR_SKILLS,
  MAX_BASE_LATEX_CHARS,
  assertSafeBaseLatex,
  fillContactPlaceholders,
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
  projectsBlockWarning,
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

/**
 * The fixture's four banner-delimited sections, so a test can rebuild the
 * same resume in a different order.
 *
 * The owner's own resume puts Projects last, and so did the only fixture —
 * which is exactly the layout that hid the splice-boundary bug the
 * `Projects is not the last section` describe below covers. Reordering the
 * real fixture (rather than hand-writing a second one) keeps every section's
 * bytes identical to the base they came from, which is what the
 * byte-identity assertions are actually about.
 */
const BANNERS = {
  skills: "%-----------TECHNICAL SKILLS-----------",
  education: "%-----------EDUCATION-----------",
  experience: "%-----------EXPERIENCE-----------",
  projects: "%-----------PROJECTS-----------",
} as const;

type SectionName = keyof typeof BANNERS;

/** The fixture's sections, in the order they appear in it. */
const FIXTURE_ORDER: SectionName[] = ["skills", "education", "experience", "projects"];

function splitSections(tex: string): {
  header: string;
  sections: Record<SectionName, string>;
  close: string;
} {
  const at = {} as Record<SectionName, number>;
  for (const name of FIXTURE_ORDER) {
    at[name] = tex.indexOf(BANNERS[name]);
    if (at[name] === -1) throw new Error(`fixture has no ${name} banner`);
  }
  const closeAt = tex.lastIndexOf("\\end{document}");
  const bounds = [...FIXTURE_ORDER.map((n) => at[n]), closeAt];
  const sections = {} as Record<SectionName, string>;
  FIXTURE_ORDER.forEach((name, i) => {
    sections[name] = tex.slice(bounds[i], bounds[i + 1]);
  });
  return { header: tex.slice(0, at.skills), sections, close: tex.slice(closeAt) };
}

/** The fixture rebuilt with its sections in `order`, bytes otherwise unchanged. */
function reordered(order: SectionName[]): string {
  const { header, sections, close } = splitSections(BASE);
  return header + order.map((name) => sections[name]).join("") + close;
}

/** The slice of `tex` from one banner up to the next one (or `\end{document}`). */
function sectionSlice(tex: string, name: SectionName, until: SectionName | "close"): string {
  const from = tex.indexOf(BANNERS[name]);
  const to = until === "close" ? tex.lastIndexOf("\\end{document}") : tex.indexOf(BANNERS[until]);
  return tex.slice(from, to);
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

/**
 * Regression: `String.prototype.replace` with a *string* second argument
 * treats `$1`, `$&`, `` $` `` and `$'` as substitution patterns. `escapeLatex`
 * turns a perfectly ordinary resume line — "Raised $1M in seed funding" — into
 * `Raised \$1M …`, so a replacement string would splice capture group 1 (the
 * whole `%---TECHNICAL SKILLS---…\small{\item{` prefix) into the middle of the
 * skills line. It still *compiles*, so nothing downstream notices and the user
 * downloads a resume with two Technical Skills headings in it.
 */
describe("a `$` in tailored content is never a replacement pattern", () => {
  it("keeps a dollar figure in a skill verbatim, as `\\$1`", () => {
    const out = replaceSkillsSection(BASE, ["Raised $1M in seed funding", "TypeScript"]);
    expect(out).toContain(
      "\\textbf{Proficient}{: Raised \\$1M in seed funding, TypeScript}",
    );
    // The tell-tale of the bug: the banner comment duplicated into the body.
    expect(out.match(/\\section\{Technical Skills\}/g)).toHaveLength(1);
    expect(out.match(/%-----------TECHNICAL SKILLS-----------/g)).toHaveLength(1);
    // The prefix `$1` would have expanded to starts with the banner comment;
    // the Proficient line must contain no LaTeX-source spill at all.
    const proficient = out.match(/\\textbf\{Proficient\}\{:([^}]*)\}/)?.[1] ?? "";
    expect(proficient).not.toContain("TECHNICAL SKILLS");
    expect(proficient).not.toContain("\\begin{itemize}");
  });

  it("survives every replacement-pattern token a skill could contain", () => {
    const out = replaceSkillsSection(BASE, ["A $& B $` C $' D $2 E"]);
    // `&` is escaped by escapeLatex too, hence `\$\&`.
    expect(out).toContain("\\textbf{Proficient}{: A \\$\\& B \\$` C \\$' D \\$2 E}");
    expect(out.match(/\\section\{Technical Skills\}/g)).toHaveLength(1);
  });

  it("keeps a `$` in a contact placeholder value verbatim", () => {
    const templated = "\\documentclass{article}\n{{NAME}} / {{EMAIL}} / {{LINKS}}\n";
    const out = fillContactPlaceholders(templated, {
      name: "A$1B",
      email: "x$&y@example.org",
      links: ["ex$`ample.org"],
    });
    expect(out).toContain("A\\$1B / x\\$\\&y@example.org / ex\\$`ample.org");
    expect(out).not.toContain("{{");
  });
});

describe("headingFor never reuses one base project for two tailored ones", () => {
  /**
   * `headingFor` falls through exact → substring → token match, so two
   * differently-worded tailor projects can land on the same base project.
   * Before the `used` set, both got the base's `headingRaw` and the resume
   * listed one project twice under two different bullet sets.
   */
  it("gives the second fuzzy match a synthesised heading instead of a duplicate", () => {
    const { tex } = spliceTailoredResume(BASE, {
      ...TAILOR,
      projects: [
        {
          name: "TaskBoard",
          technologies: "Next.js, Prisma",
          bullets: [{ text: "Built the board.", fact_ids: ["F-002"] }],
        },
        {
          name: "TaskBoard – Full-Stack KanBan App",
          technologies: "Docker",
          bullets: [{ text: "Added drag and drop.", fact_ids: ["F-007"] }],
        },
      ],
    });

    // Two projects emitted (`\item \resumeProjectHeading`; the bare
    // `\resumeProjectHeading` in the preamble is its \newcommand definition)…
    expect(tex.match(/\\item \\resumeProjectHeading/g)).toHaveLength(2);
    // …and the base's own heading is used by exactly one of them.
    expect(
      tex.match(/\{\\textbf\{TaskBoard – Full-Stack KanBan App\} \$\|\$ \\emph\{Next\.js, Prisma, SQL/g),
    ).toHaveLength(1);
    // The loser falls back to v1's synthesised form — it names itself
    // honestly rather than repeating the first project's heading.
    expect(tex).toContain("{\\textbf{TaskBoard – Full-Stack KanBan App} $|$ \\emph{Docker}}{}");
    expect(tex).toContain("\\resumeItem{Built the board.}");
    expect(tex).toContain("\\resumeItem{Added drag and drop.}");
  });
});

describe("assertSafeBaseLatex", () => {
  it("accepts the fixture — a real Jake's-template resume, `\\input{glyphtounicode}` and all", () => {
    expect(() => assertSafeBaseLatex(BASE, "fixture.tex")).not.toThrow();
    expect(BASE).toContain("\\input{glyphtounicode}");
  });

  it("rejects \\write18", () => {
    expect(() =>
      assertSafeBaseLatex(`${BASE}\n\\immediate\\write18{touch /tmp/pwned}`, "x.tex"),
    ).toThrow(/write18/);
  });

  it("rejects \\input of an absolute or parent-directory path", () => {
    expect(() => assertSafeBaseLatex("\\input{/etc/passwd}", "x.tex")).toThrow(/input/);
    expect(() => assertSafeBaseLatex("\\include{../../.env.local}", "x.tex")).toThrow(/input/);
    expect(() => assertSafeBaseLatex("\\input {~/.ssh/id_rsa}", "x.tex")).toThrow(/input/);
  });

  it("rejects \\openin / \\read", () => {
    expect(() => assertSafeBaseLatex("\\openin1=/etc/passwd", "x.tex")).toThrow(/openin/);
    expect(() => assertSafeBaseLatex("\\read 0 to \\line", "x.tex")).toThrow(/openin/);
  });

  it("rejects a base past the size cap", () => {
    expect(() => assertSafeBaseLatex("x".repeat(MAX_BASE_LATEX_CHARS + 1), "x.tex")).toThrow(
      /over the/,
    );
    expect(() => assertSafeBaseLatex("x".repeat(MAX_BASE_LATEX_CHARS), "x.tex")).not.toThrow();
  });
});

/**
 * The other half of the file-read defence: even if a base with `\input{/abs}`
 * somehow reaches the compiler (an older row, a future upload path that
 * forgets {@link assertSafeBaseLatex}), kpathsea's paranoid `openin_any`
 * must refuse the read so the secret never lands in the PDF.
 */
describe("compileLatexToPdf sandbox (real pdflatex)", () => {
  it("does not leak a file \\input from an absolute path", async ({ skip }) => {
    if (!(await isLatexAvailable())) {
      skip();
      return;
    }

    const dir = mkdtempSync(path.join(os.tmpdir(), "applyops-leak-test-"));
    const secretPath = path.join(dir, "fakesecret.txt");
    const secret = "SECRETVALUE-ABC123-LEAKED";
    writeFileSync(secretPath, `${secret}\n`, "utf-8");

    try {
      const hostile = BASE.replace(
        "\\begin{document}",
        `\\begin{document}\n\\input{${secretPath}}`,
      );

      let pdf: Buffer | null = null;
      try {
        pdf = (await renderLatexResume({ base: { latex: hostile }, tailor: TAILOR })).pdf;
      } catch {
        return; // refusing to compile at all is also a pass
      }

      let text: string;
      try {
        text = execFileSync("pdftotext", ["-", "-"], {
          input: pdf,
          encoding: "utf-8",
          maxBuffer: 8 * 1024 * 1024,
        });
      } catch {
        // No poppler: fall back to scanning the raw bytes, which catches an
        // uncompressed leak and is better than asserting nothing.
        expect(pdf.toString("latin1")).not.toContain(secret);
        return;
      }
      expect(text).not.toContain(secret);
      expect(text).not.toContain("ABC123");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});

/**
 * The splice boundary, for a base that is not laid out like the owner's.
 *
 * `projectsRegion` used to take the end of the Projects block from
 * `PROJECTS_END_REGEX` (`\resumeSubHeadingListEnd\s*\end{document}`) matched
 * over the whole document — the *last* list-end in the file, not the Projects
 * section's own. Every fixture put Projects last, where those two are the same
 * byte, so nothing caught it. Give it a base ordered Education → Projects →
 * Experience and the whole Experience section was deleted; the result still
 * compiled, so `compileLatexToPdf` never threw, the PDF route's catch never
 * fired, and the download said `x-applyops-renderer: latex` over a resume
 * with no work history.
 */
describe("a base whose Projects section is not the last one", () => {
  const PROJECTS_MID = reordered(["skills", "education", "projects", "experience"]);

  it("is a fixture the old end-anchor would have mis-parsed", () => {
    // Both markers still "match" the document; that was the whole problem.
    expect(PROJECTS_START_REGEX.test(PROJECTS_MID)).toBe(true);
    expect(PROJECTS_END_REGEX.test(PROJECTS_MID)).toBe(true);
    expect(projectsBlockWarning(PROJECTS_MID)).toBeNull();
  });

  it("keeps the Experience section — byte for byte — after the Projects splice", () => {
    const { tex } = spliceTailoredResume(PROJECTS_MID, TAILOR);
    expect(sectionSlice(tex, "experience", "close")).toBe(
      sectionSlice(PROJECTS_MID, "experience", "close"),
    );
    expect(tex).toContain("\\section{Experience}");
    expect(tex).toContain("{Northwind Labs}{November 2025 -- Present}");
    expect(tex).toContain("{City Utilities Board}{September 2025 -- Present}");
    expect(tex).toContain("{Contoso Retail}{March 2025 -- June 2025}");
  });

  it("keeps Education byte-identical too, and every section heading exactly once", () => {
    const { tex } = spliceTailoredResume(PROJECTS_MID, TAILOR);
    expect(sectionSlice(tex, "education", "projects")).toBe(
      sectionSlice(PROJECTS_MID, "education", "projects"),
    );
    for (const heading of ["Technical Skills", "Education", "Experience", "Projects"]) {
      expect(tex.match(new RegExp(`\\\\section\\{${heading}\\}`, "g"))).toHaveLength(1);
    }
  });

  it("still does the two replacements it is supposed to do", () => {
    const { tex, projectsSource } = spliceTailoredResume(PROJECTS_MID, TAILOR);
    expect(projectsSource).toBe("derived");
    expect(tex).toContain("\\textbf{Proficient}{: Go, PostgreSQL, Kubernetes, TypeScript}");
    expect(tex).toContain("\\resumeItem{Built a Kanban app with role-based access control.}");
    // The base's own project bullets are gone, replaced by the tailored ones
    // (the base's project *headings* are reused on purpose — that is the
    // point of splicing into the user's own document).
    expect(tex).not.toContain("Engineered a recommender using Faiss vector databases");
    expect(tex).not.toContain("Architected a gamified productivity platform");
    // And the document did not shrink by a whole section: the old bug turned
    // a 6.2 KB base into a 3.9 KB one.
    expect(tex.length).toBeGreaterThan(PROJECTS_MID.length - 2_000);
  });

  it("finds the base's projects from the block, not from the rest of the file", () => {
    expect(extractBaseProjects(PROJECTS_MID).map((p) => p.name)).toEqual(
      extractBaseProjects(BASE).map((p) => p.name),
    );
  });
});

/**
 * Canonical Jake's-template order: Education, Experience, Projects, Technical
 * Skills. Here the document's last `\resumeSubHeadingListEnd` belongs to no
 * list at all (Technical Skills closes with `\end{itemize}`), so
 * `PROJECTS_END_REGEX` does not match and the old code skipped the projects
 * splice entirely — a silent no-op rather than a corruption, but still wrong.
 */
describe("a base in canonical Jake's-template order", () => {
  const JAKE = reordered(["education", "experience", "projects", "skills"]);

  it("has no `\\resumeSubHeadingListEnd\\end{document}` for the old anchor to find", () => {
    expect(PROJECTS_END_REGEX.test(JAKE)).toBe(false);
    expect(projectsBlockWarning(JAKE)).toBeNull();
  });

  it("splices both blocks and leaves Education and Experience byte-identical", () => {
    const { tex, projectsSource } = spliceTailoredResume(JAKE, TAILOR);
    expect(projectsSource).toBe("derived");
    expect(tex).toContain("\\textbf{Proficient}{: Go, PostgreSQL, Kubernetes, TypeScript}");
    expect(tex).toContain("\\resumeItem{Built a Kanban app with role-based access control.}");
    expect(sectionSlice(tex, "education", "experience")).toBe(
      sectionSlice(JAKE, "education", "experience"),
    );
    expect(sectionSlice(tex, "experience", "projects")).toBe(
      sectionSlice(JAKE, "experience", "projects"),
    );
    expect(tex).toContain("{Northwind Labs}{November 2025 -- Present}");
    expect(tex.trimEnd().endsWith("\\end{document}")).toBe(true);
  });
});

/**
 * The refusal. If the forward search for `\resumeSubHeadingListEnd` runs past
 * the end of the Projects block (an unclosed list) it will land inside a later
 * section, and splicing there would delete it. Refusing leaves the user's own
 * Projects block in the PDF, which is wrong-but-honest rather than silently
 * destructive.
 */
describe("a base whose Projects list is never closed", () => {
  const PROJECTS_MID = reordered(["skills", "education", "projects", "experience"]);
  const LIST_END = "\\resumeSubHeadingListEnd";
  const UNCLOSED = (() => {
    const at = PROJECTS_MID.indexOf(BANNERS.projects);
    const end = PROJECTS_MID.indexOf(LIST_END, at);
    return PROJECTS_MID.slice(0, end) + PROJECTS_MID.slice(end + LIST_END.length);
  })();

  it("refuses the projects splice rather than eating the next section", () => {
    const { tex, projectsSource } = spliceTailoredResume(UNCLOSED, TAILOR);
    expect(projectsSource).toBe("base");
    // Everything from Education onward — the base's own Projects block
    // included — comes out exactly as it went in.
    expect(tex.slice(tex.indexOf(BANNERS.education))).toBe(
      UNCLOSED.slice(UNCLOSED.indexOf(BANNERS.education)),
    );
    expect(tex).toContain("Fashion Recommendation Engine");
    expect(tex).toContain("{Northwind Labs}{November 2025 -- Present}");
    // The skills splice is independent and still runs.
    expect(tex).toContain("\\textbf{Proficient}{: Go, PostgreSQL, Kubernetes, TypeScript}");
  });

  it("is what `applyops resume import-latex` warns about", () => {
    expect(projectsBlockWarning(UNCLOSED)).toContain("\\section{...}");
    expect(projectsBlockWarning(BASE)).toBeNull();
    expect(projectsBlockWarning("\\documentclass{article}\\begin{document}hi\\end{document}")).toContain(
      "PROJECTS",
    );
  });
});

/**
 * The Familiar line is user LaTeX, and `[^}]*` stopped at the first `}` of any
 * macro inside it — then `replaceSkillsSection` wrote that truncation back
 * over the real line, deleting the rest of the user's Familiar skills.
 */
describe("a Familiar line containing braced macros", () => {
  const FAMILIAR_WITH_MACROS =
    "\\textbf{Familiar}{: C, \\textbf{AWS}, \\href{https://k8s.example}{Kubernetes}, CI/CD}";
  const WITH_MACROS = BASE.replace(
    "\\textbf{Familiar}{: C, C++, C\\#, AWS, CI/CD,  Agile Methodologies, UX/UI Principles}",
    FAMILIAR_WITH_MACROS,
  );

  it("was actually substituted into the fixture", () => {
    expect(WITH_MACROS).toContain(FAMILIAR_WITH_MACROS);
    expect(WITH_MACROS).not.toBe(BASE);
  });

  it("survives the splice whole, macros and all", () => {
    const out = replaceSkillsSection(WITH_MACROS, ["Go", "TypeScript"]);
    expect(out).toContain(FAMILIAR_WITH_MACROS);
    // The tell-tale of the old truncation: the list cut off at `\textbf{AWS`.
    expect(out).not.toContain("\\textbf{Familiar}{: C, \\textbf{AWS}\n");
    expect(out).toContain("\\textbf{Proficient}{: Go, TypeScript}");
  });

  it("still filters a tailored skill the base lists as Familiar inside a macro", () => {
    const out = replaceSkillsSection(WITH_MACROS, ["Go", "AWS", "Kubernetes"]);
    expect(out).toContain("\\textbf{Proficient}{: Go}");
    expect(out).toContain(FAMILIAR_WITH_MACROS);
  });
});

/**
 * The end of the same story, through a real compiler: the reordered base must
 * come out of `pdflatex` with its Experience section in the PDF. This is the
 * check that would have caught the original bug — the mangled `.tex` compiled
 * cleanly to a 75 KB PDF with no work history in it.
 */
describe("renderLatexResume keeps every section of a Projects-in-the-middle base (real pdflatex)", () => {
  it("puts the Experience section in the PDF", async ({ skip }) => {
    if (!(await isLatexAvailable())) {
      skip();
      return;
    }
    const PROJECTS_MID = reordered(["skills", "education", "projects", "experience"]);
    const result = await renderLatexResume({ base: { latex: PROJECTS_MID }, tailor: TAILOR });
    expect(result.pdf.subarray(0, 4).toString("latin1")).toBe("%PDF");
    expect(result.tex).toContain("{Northwind Labs}{November 2025 -- Present}");

    let text: string;
    try {
      text = execFileSync("pdftotext", ["-", "-"], {
        input: result.pdf,
        encoding: "utf-8",
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch {
      return; // no poppler on this host
    }
    expect(text).toContain("Northwind Labs");
    expect(text).toContain("City Utilities Board");
    expect(text).toContain("State University");
    expect(text).toContain("Built a Kanban app with role-based access control.");
  }, 180_000);
});
