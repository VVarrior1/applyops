import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "@/src/auth/require";
import { getDb } from "@/src/db/client";
import { generations, jobs, profiles } from "@/src/db/schema";
import { checkCitations, stripUnsupportedBullets } from "@/src/pipeline/hallucination";
import { TailorOutput } from "@/src/pipeline/schemas";
import { factLabels } from "@/src/pipeline/steps";
import { getConfirmedFacts } from "@/src/profile/facts";
import { checkContact, contactProblemSummary } from "@/src/profile/contact";
import { renderResumePdf } from "@/src/pdf/render";
import { isLatexAvailable, renderLatexResume } from "@/src/pdf/latex";
import { enrichTailorFromBase } from "@/src/pdf/base-entries";
import { downloadTranscript, getLatexBase } from "@/src/pdf/resume-base";

// @react-pdf/renderer needs Node APIs (Buffer, fontkit) — pin this route to
// the Node runtime rather than relying on the App Router's default.
export const runtime = "nodejs";

const bodySchema = z.object({
  // The client's edited/filtered tailor output (plan Task 9 Step 2: "user
  // can edit bullet text inline (edited bullets keep their fact ids)"). Not
  // trusted as-is: re-verified against the user's confirmed facts below, so
  // no client can put an unsupported claim into a downloaded PDF.
  tailor: TailorOutput,
  tailorGenerationId: z.string().uuid().optional(),
});

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "resume";
}

/**
 * `POST /api/jobs/[id]/pdf` — the Tailor tab's "Download PDF" button (plan
 * Task 9 Step 2). Re-runs `checkCitations`/`stripUnsupportedBullets` on the
 * submitted tailor output server-side — the hallucination block is enforced
 * here, not just in the UI — then renders it with the caller's `profiles
 * .contact` and confirmed education facts and streams the PDF back.
 *
 * ## Two renderers
 *
 * LaTeX wins when both halves are true: the user has imported a `.tex` base
 * resume (`resume_bases`, via `applyops resume import-latex`) **and** this
 * host has `pdflatex`. That is v1's pipeline — the user's own document with
 * the Technical Skills and Projects blocks swapped — and it is what the owner
 * actually applies with. Otherwise the react-pdf template renders the page
 * from scratch, which works everywhere (Vercel has no TeX) but cannot
 * reproduce a document the user hand-tuned.
 *
 * A LaTeX *failure* also falls back rather than failing the download: losing
 * the nicer PDF is bad, losing the PDF is worse. `x-applyops-renderer` on the
 * response says which one actually ran, so the UI and a curl can both tell.
 *
 * `?transcript=1` appends the stored transcript (Ghostscript), for the
 * postings that ask for one. Off by default — an ATS "resume" field wants a
 * resume.
 *
 * ## The contact gate
 *
 * Before either renderer runs, `profiles.contact` has to look like a real
 * person (`checkContact`, `src/profile/contact.ts`). QA caught this route
 * happily producing a download headed "ApplyOps Test Resume /
 * candidate@example.com | 555-0100" from a seed row. Every other guard in
 * this file protects the *body* of the resume (`checkCitations`,
 * `stripUnsupportedBullets`); nothing protected the header, which is the one
 * part an employer reads first. A `422` with the specific problems is the
 * right answer rather than rendering with a warning header: the failure mode
 * is a file already attached to an application, at which point no banner in
 * the app can help.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  const { id: jobId } = await params;
  const db = getDb();

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid tailored resume payload." }, { status: 400 });
  }
  const { tailor, tailorGenerationId } = parsed.data;

  const [job] = await db
    .select({ id: jobs.id, title: jobs.title })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);
  if (!job) {
    return NextResponse.json({ error: "That job doesn't exist." }, { status: 404 });
  }

  if (tailorGenerationId) {
    const [gen] = await db
      .select({
        id: generations.id,
        userId: generations.userId,
        step: generations.step,
        jobId: generations.jobId,
      })
      .from(generations)
      .where(eq(generations.id, tailorGenerationId))
      .limit(1);
    if (!gen || gen.userId !== user.id || gen.step !== "tailor" || gen.jobId !== jobId) {
      return NextResponse.json(
        { error: "That tailoring run doesn't belong to this job." },
        { status: 400 },
      );
    }
  }

  const facts = await getConfirmedFacts(db, user.id);
  const report = checkCitations(tailor, factLabels(facts));
  const sanitized = stripUnsupportedBullets(tailor, report);
  const education = facts.filter((fact) => fact.category === "education");

  const [profileRow] = await db
    .select({ contact: profiles.contact })
    .from(profiles)
    .where(eq(profiles.userId, user.id))
    .limit(1);
  const contact = profileRow?.contact ?? {};

  const contactProblems = checkContact(contact);
  if (contactProblems.length > 0) {
    return NextResponse.json(
      {
        error: contactProblemSummary(contactProblems),
        contactProblems,
      },
      { status: 422 },
    );
  }

  const wantsTranscript = new URL(request.url).searchParams.get("transcript") === "1";

  let pdf: Buffer | null = null;
  let renderer: "latex" | "react-pdf" = "react-pdf";

  const base = await getLatexBase(db, user.id);
  if (base && (await isLatexAvailable())) {
    try {
      const transcriptPdf =
        wantsTranscript && base.transcriptPdfPath
          ? await downloadTranscript(base.transcriptPdfPath)
          : null;
      const result = await renderLatexResume({
        base: { latex: base.latex, transcriptPdf },
        tailor: sanitized,
        contact,
        includeTranscript: wantsTranscript,
      });
      pdf = result.pdf;
      renderer = "latex";
    } catch (error) {
      // Deliberately not rethrown: see the "Two renderers" note above. Logged
      // because a base resume that stops compiling is a real problem the
      // owner needs to hear about, even though the download still works.
      console.error("[pdf] LaTeX render failed; falling back to react-pdf", error);
    }
  }

  if (!pdf) {
    // The react-pdf template has no base document, so an entry header is only
    // as complete as the tailored output — and the tailored output is only as
    // complete as the confirmed facts, which for this user carry employer,
    // title and location but no date ranges. QA's blocker: an EXPERIENCE block
    // no ATS could date. The dates are in the user's own `resume_bases.latex`;
    // `enrichTailorFromBase` copies them (and, for a pre-1.2.0 generation with
    // only loose `sections`, reconstructs the entries themselves) without a
    // model call and without overwriting anything the model did cite. A no-op
    // when the user has no base resume.
    pdf = await renderResumePdf({
      profile: {
        name: contact.name?.trim() || user.email,
        email: contact.email?.trim() || user.email,
        phone: contact.phone?.trim() ?? "",
        links: contact.links ?? [],
      },
      tailor: enrichTailorFromBase(sanitized, base?.latex),
      education,
    });
  }

  const filename = `${slugify(job.title)}-resume.pdf`;

  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(pdf.length),
      "x-applyops-renderer": renderer,
    },
  });
}
