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
import { renderResumePdf } from "@/src/pdf/render";

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

  const pdf = await renderResumePdf({
    profile: {
      name: contact.name?.trim() || user.email,
      email: contact.email?.trim() || user.email,
      phone: contact.phone?.trim() ?? "",
      links: contact.links ?? [],
    },
    tailor: sanitized,
    education,
  });

  const filename = `${slugify(job.title)}-resume.pdf`;

  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(pdf.length),
    },
  });
}
