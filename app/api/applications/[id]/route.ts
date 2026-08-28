import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { requireUser } from "@/src/auth/require";
import { getDb } from "@/src/db/client";
import { applications, approvals, outcomeEvents } from "@/src/db/schema";

/**
 * `DELETE /api/applications/:id` — the `/applications` "Delete application"
 * control (`components/applications/OutcomeButtons.tsx`). Marking a job
 * Withdrawn keeps the application row (it's a real funnel outcome), but a
 * row created by mistake — the wrong job, a test click — has no way back
 * otherwise: `/jobs` and `assessJob` already treat `withdrawn` as
 * not-applied (`countsAsApplied`, src/rank/candidates.ts), so withdrawing
 * alone is enough to unhide the job again. This route is only for actually
 * removing the row.
 *
 * `outcome_events` and `approvals` both FK-reference `applications.id` with
 * no `ON DELETE CASCADE`, so their rows are deleted first, in one
 * transaction, before the `applications` row itself — otherwise Postgres
 * would reject the delete with a foreign-key violation (every application
 * has at least one `outcome_events` row: the founding `applied` event).
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const db = getDb();

  const [owned] = await db
    .select({ id: applications.id })
    .from(applications)
    .where(and(eq(applications.id, id), eq(applications.userId, user.id)))
    .limit(1);
  if (!owned) {
    return NextResponse.json({ error: "Application not found." }, { status: 404 });
  }

  await db.transaction(async (tx) => {
    await tx.delete(outcomeEvents).where(eq(outcomeEvents.applicationId, id));
    await tx.delete(approvals).where(eq(approvals.applicationId, id));
    await tx.delete(applications).where(and(eq(applications.id, id), eq(applications.userId, user.id)));
  });

  return new NextResponse(null, { status: 204 });
}
