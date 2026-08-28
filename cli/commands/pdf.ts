/**
 * `applyops pdf <applicationId|jobId>` — render one tailored resume to
 * `./out/` without a browser.
 *
 * The operator-side twin of `POST /api/jobs/[id]/pdf`: same tailor generation,
 * same hallucination gate, same renderer choice (LaTeX when the user has a
 * `.tex` base and `pdflatex` is on the host, react-pdf otherwise). It writes
 * the `.tex` next to the `.pdf` too, because when a LaTeX render comes out
 * wrong the `.tex` is the only thing that explains why.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { and, desc, eq } from "drizzle-orm";
import { closeDb, getDirectDb } from "../../src/db/client";
import { applications, generations, jobs, profiles } from "../../src/db/schema";
import { isLatexAvailable, renderLatexResume } from "../../src/pdf/latex";
import { downloadTranscript, getLatexBase } from "../../src/pdf/resume-base";
import { checkCitations, stripUnsupportedBullets } from "../../src/pipeline/hallucination";
import { TailorOutput } from "../../src/pipeline/schemas";
import { applyTailorEdits } from "../../src/pipeline/tailor-edits";
import { factLabels } from "../../src/pipeline/steps";
import { getConfirmedFacts } from "../../src/profile/facts";
import { checkContact } from "../../src/profile/contact";
import { resolveUserId } from "../user-lookup";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PdfCliOptions {
  user?: string;
  out?: string;
  transcript?: boolean;
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "resume"
  );
}

export function register(program: Command): void {
  program
    .command("pdf")
    .description(
      "Render a tailored resume PDF (LaTeX base when available, react-pdf otherwise) into ./out/.",
    )
    .argument("<id>", "applications.id or jobs.id (uuid)")
    .option("-u, --user <email>", "whose resume to render (default: OWNER_EMAIL)")
    .option("-o, --out <dir>", "output directory", "out")
    .option("--transcript", "append the stored transcript PDF (Ghostscript merge)")
    .action(async (id: string, options: PdfCliOptions) => {
      if (!UUID.test(id)) throw new Error(`"${id}" is not a uuid.`);

      const { userId, email } = await resolveUserId(options.user);
      const db = getDirectDb();

      try {
        // The argument is an application id or a job id. Applications are
        // checked first: an application pins the exact tailor generation its
        // PDF was built from, which is a stronger answer than "the newest
        // tailoring for this job".
        const [application] = await db
          .select({
            id: applications.id,
            jobId: applications.jobId,
            userId: applications.userId,
            tailorGenerationId: applications.tailorGenerationId,
          })
          .from(applications)
          .where(eq(applications.id, id))
          .limit(1);

        if (application && application.userId !== userId) {
          throw new Error(`Application ${id} does not belong to ${email}.`);
        }

        const jobId = application?.jobId ?? id;
        const [job] = await db
          .select({ id: jobs.id, title: jobs.title })
          .from(jobs)
          .where(eq(jobs.id, jobId))
          .limit(1);
        if (!job) {
          throw new Error(`No application and no job found with id ${id}.`);
        }

        let generationId = application?.tailorGenerationId ?? null;
        if (!generationId) {
          const [latest] = await db
            .select({ id: generations.id })
            .from(generations)
            .where(
              and(
                eq(generations.jobId, jobId),
                eq(generations.userId, userId),
                eq(generations.step, "tailor"),
              ),
            )
            .orderBy(desc(generations.createdAt))
            .limit(1);
          generationId = latest?.id ?? null;
        }
        if (!generationId) {
          throw new Error(
            `No tailor generation for job ${jobId} and ${email}. Run the Tailor step for that job first.`,
          );
        }

        const [generation] = await db
          .select({ id: generations.id, output: generations.output, userEdits: generations.userEdits })
          .from(generations)
          .where(eq(generations.id, generationId))
          .limit(1);
        const parsed = TailorOutput.safeParse(generation?.output);
        if (!parsed.success) {
          throw new Error(
            `Tailor generation ${generationId} does not match TailorOutput: ${parsed.error.message}`,
          );
        }

        // Apply the persisted `tailor_edit` overlay (retyped bullet text,
        // unchecked bullets — `generations.user_edits`) before rendering, the
        // same way the web PDF route renders whatever edited output the
        // Tailor tab posts. Without this a CLI-rendered PDF would silently
        // ignore every edit the user made in the UI.
        const edited = applyTailorEdits(parsed.data, generation?.userEdits ?? null);

        const facts = await getConfirmedFacts(db, userId);
        const report = checkCitations(edited, factLabels(facts));
        const tailor = stripUnsupportedBullets(edited, report);

        const [profileRow] = await db
          .select({ contact: profiles.contact })
          .from(profiles)
          .where(eq(profiles.userId, userId))
          .limit(1);
        const contact = profileRow?.contact ?? {};

        // The web download (`POST /api/jobs/[id]/pdf`) refuses outright when
        // the contact block is seed/placeholder data. This command writes to
        // the operator's own `out/` rather than handing a file to a user, so
        // it warns instead of failing — but it must not stay silent: QA found
        // a resume rendered with "candidate@example.com" and nothing said so.
        const contactProblems = checkContact(contact);
        if (contactProblems.length > 0) {
          process.stderr.write(
            "\nWARNING: this resume's contact block is not application-ready:\n" +
              contactProblems.map((problem) => `  - ${problem.message}\n`).join("") +
              "  Fix it in Settings → Resume contact info before sending this PDF anywhere.\n",
          );
        }

        const outDir = path.resolve(options.out ?? "out");
        await mkdir(outDir, { recursive: true });
        const stem = `${slugify(job.title)}-${jobId.slice(0, 8)}`;
        const pdfPath = path.join(outDir, `${stem}.pdf`);
        const texPath = path.join(outDir, `${stem}.tex`);

        const base = await getLatexBase(db, userId);
        const latexUsable = !!base && (await isLatexAvailable());

        let renderer: "latex" | "react-pdf";
        let extra = "";

        if (base && latexUsable) {
          const transcriptPdf =
            options.transcript && base.transcriptPdfPath
              ? await downloadTranscript(base.transcriptPdfPath)
              : null;

          const result = await renderLatexResume({
            base: { latex: base.latex, transcriptPdf },
            tailor,
            contact,
            includeTranscript: Boolean(options.transcript),
          });
          await writeFile(pdfPath, result.pdf);
          await writeFile(texPath, result.tex, "utf-8");
          renderer = "latex";
          extra =
            `\nbase resume   ${base.id}` +
            `\nprojects from ${result.projectsSource}` +
            `\nskills from   ${result.skillsSource}` +
            `\ntranscript    ${result.transcriptMerged ? "merged" : "not merged"}` +
            `\ntex           ${texPath}`;
        } else {
          // Imported lazily, and only on this branch: `@react-pdf/renderer`
          // pulls in `@react-pdf/hyphenate/en-us`, a subpath its package
          // `exports` map does not declare, which `tsx`'s CommonJS resolver
          // refuses to load. A static import would therefore break *every*
          // `applyops` command at startup, LaTeX renders included. Next.js's
          // bundler resolves it fine, so the web route is unaffected.
          const { renderResumePdf } = await import("../../src/pdf/render").catch(() => {
            throw new Error(
              "The react-pdf fallback cannot be loaded under tsx. Install a TeX " +
                "distribution (macOS: MacTeX) and import a .tex base with " +
                "`applyops resume import-latex`, or download the PDF from the web app.",
            );
          });
          const pdf = await renderResumePdf({
            profile: {
              name: contact.name?.trim() || email,
              email: contact.email?.trim() || email,
              phone: contact.phone?.trim() ?? "",
              links: contact.links ?? [],
            },
            tailor,
            education: facts.filter((f) => f.category === "education"),
          });
          await writeFile(pdfPath, pdf);
          renderer = "react-pdf";
          extra = base
            ? "\nnote          pdflatex not found on this host; used the react-pdf fallback"
            : `\nnote          ${email} has no LaTeX base resume; run \`applyops resume import-latex <path>\``;
        }

        process.stdout.write(
          "\n" +
            [
              `job           ${job.title.trim()} (${jobId})`,
              `generation    ${generationId}`,
              `renderer      ${renderer}`,
              `blocked       ${report.unsupported.length}/${report.totalClaims} uncited bullet(s) dropped`,
              `pdf           ${pdfPath}`,
            ].join("\n") +
            extra +
            "\n\n",
        );
      } finally {
        await closeDb();
      }
    });
}
