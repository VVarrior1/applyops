import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "@/src/auth/require";
import { getDb } from "@/src/db/client";
import { applications, generations, jobs, outcomeEvents } from "@/src/db/schema";

const bodySchema = z.object({
  jobId: z.string().uuid(),
  tailorGenerationId: z.string().uuid().optional(),
});

/**
 * `POST /api/applications` — plan Task 9 Interfaces Produces: "creates
 * `applications` (status `applied`) + `outcome_events` `applied` now;
 * returns id." This is the Tailor tab's "Mark as applied" button — the
 * client has already downloaded the PDF by the time this is called, so this
 * route only records that the application happened, in one transaction so
 * an application never exists without its founding `applied` event.
 */
export async function POST(request: Request) {
  const user = await requireUser();

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "jobId is required." }, { status: 400 });
  }
  const { jobId, tailorGenerationId } = parsed.data;
  const db = getDb();

  const [job] = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, jobId)).limit(1);
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

  const application = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(applications)
      .values({
        userId: user.id,
        jobId,
        tailorGenerationId: tailorGenerationId ?? null,
        status: "applied",
      })
      .returning({ id: applications.id });

    await tx.insert(outcomeEvents).values({ applicationId: row.id, type: "applied" });

    return row;
  });

  return NextResponse.json({ id: application.id }, { status: 201 });
}
