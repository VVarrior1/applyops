/**
 * `applyops resume import-latex <path> [--transcript <pdf>]`
 *
 * Loads the user's real `.tex` resume into `resume_bases` so tailored PDFs are
 * *their document with two blocks swapped*, not a page ApplyOps drew from
 * scratch — the v1 model (see `src/pdf/latex.ts`). The transcript, if given,
 * goes into the private `resumes` Storage bucket and is Ghostscript-appended
 * on request.
 *
 * The user defaults to `OWNER_EMAIL`; `--user <email>` overrides it. Rows are
 * append-only, so re-running this is how you update the base resume.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { closeDb, getDirectDb } from "../../src/db/client";
import {
  PROJECTS_END_REGEX,
  PROJECTS_START_REGEX,
  SKILLS_REGEX,
  assertSafeBaseLatex,
  extractBaseProjects,
} from "../../src/pdf/latex";
import { insertLatexBase, uploadTranscript } from "../../src/pdf/resume-base";
import { resolveUserId } from "../user-lookup";

interface ImportLatexOptions {
  transcript?: string;
  user?: string;
}

const PDF_MAGIC = "%PDF";

export function register(program: Command): void {
  const resume = program
    .command("resume")
    .description("Manage the base resume tailored PDFs are spliced into.");

  resume
    .command("import-latex")
    .description(
      "Import a .tex resume as the user's base resume (and optionally their transcript PDF).",
    )
    .argument("<path>", "path to the .tex file")
    .option("-t, --transcript <pdf>", "path to a transcript PDF to store alongside it")
    .option("-u, --user <email>", "whose base resume this is (default: OWNER_EMAIL)")
    .action(async (texPath: string, options: ImportLatexOptions) => {
      const absoluteTex = path.resolve(texPath);
      const latex = await readFile(absoluteTex, "utf-8").catch(() => {
        throw new Error(`Could not read ${absoluteTex}`);
      });

      if (!latex.includes("\\documentclass")) {
        throw new Error(
          `${absoluteTex} has no \\documentclass — that is not a compilable LaTeX document.`,
        );
      }

      assertSafeBaseLatex(latex, absoluteTex);

      // Warn rather than refuse: a base with no matching blocks still renders
      // (the splice leaves the document alone), it just will not be tailored.
      // Saying so at import time beats discovering it in a downloaded PDF.
      const warnings: string[] = [];
      if (!SKILLS_REGEX.test(latex)) {
        warnings.push(
          "no '%-----------TECHNICAL SKILLS-----------' block matched — tailored skills will NOT be spliced in",
        );
      }
      if (!PROJECTS_START_REGEX.test(latex) || !PROJECTS_END_REGEX.test(latex)) {
        warnings.push(
          "no '%-----------PROJECTS-----------' … '\\resumeSubHeadingListEnd\\end{document}' block matched — tailored projects will NOT be spliced in",
        );
      }

      let transcriptPdfPath: string | null = null;
      let transcriptBytes = 0;

      const { userId, email } = await resolveUserId(options.user);

      if (options.transcript) {
        const absoluteTranscript = path.resolve(options.transcript);
        const bytes = await readFile(absoluteTranscript).catch(() => {
          throw new Error(`Could not read ${absoluteTranscript}`);
        });
        if (bytes.subarray(0, 4).toString("latin1") !== PDF_MAGIC) {
          throw new Error(`${absoluteTranscript} is not a PDF (no %PDF header).`);
        }
        transcriptBytes = bytes.length;
        transcriptPdfPath = await uploadTranscript(userId, bytes);
      }

      const db = getDirectDb();
      try {
        const id = await insertLatexBase(db, { userId, latex, transcriptPdfPath });
        const projects = extractBaseProjects(latex);

        process.stdout.write(
          [
            "",
            `imported      ${absoluteTex}`,
            `user          ${email} (${userId})`,
            `resume_base   ${id}`,
            `latex         ${latex.length} chars`,
            `projects      ${projects.length} found: ${
              projects.map((p) => p.name).join(" | ") || "(none)"
            }`,
            `transcript    ${
              transcriptPdfPath
                ? `${transcriptPdfPath} (${transcriptBytes} bytes)`
                : "(none)"
            }`,
            ...warnings.map((w) => `warning       ${w}`),
            "",
          ].join("\n"),
        );
      } finally {
        await closeDb();
      }
    });
}
