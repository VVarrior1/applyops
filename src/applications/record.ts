/**
 * The write side of `POST /api/applications` (`app/api/applications/route.ts`
 * — the Tailor tab's "Mark as applied" button), pulled into its own module
 * so the apply → withdraw → re-apply reactivation path can be covered by a
 * fake-`Db` unit test the way `logOutcome` (src/funnel/outcomes.ts) is,
 * instead of only by a manual repro against the running app.
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { applications, outcomeEvents } from "../db/schema";
import { countsAsApplied } from "../rank/candidates";

export interface RecordApplicationInput {
  userId: string;
  jobId: string;
  tailorGenerationId?: string | null;
}

export interface RecordApplicationResult {
  id: string;
  /**
   * True when this call inserted a brand-new row OR reactivated an
   * existing withdrawn/draft one (either way, a fresh founding `applied`
   * event was just logged and `status` is now `applied`). False only when
   * the row already counted as applied (`countsAsApplied`) and nothing
   * changed — the idempotent double-click/retry case.
   */
  created: boolean;
}

/**
 * Inserts an `applications` row (status `applied`) + its founding
 * `outcome_events` `applied` row in one transaction — or, if a row for this
 * user+job already exists (`applications_user_job_uq`, drizzle/0015),
 * reuses it:
 *
 * - Already counts as applied (`countsAsApplied`) → idempotent no-op,
 *   returns the existing row (`created: false`). Covers a double-click or a
 *   retried request.
 * - Does NOT count as applied (`withdrawn`, or a stray `draft`) → the user
 *   is re-applying after taking it back. Logs a fresh `applied` event and
 *   resets `status` to `applied` (and `tailorGenerationId`) on the same
 *   row, rather than leaving it stuck reading as withdrawn with no way for
 *   `/jobs` or the detail page to ever show it as applied again.
 *
 * Deliberately `set`s `status: "applied"` directly instead of going through
 * `logOutcome` (src/funnel/outcomes.ts): `logOutcome`'s `currentStage`
 * treats `applied` as one of `NON_ADVANCING_TYPES`, so a fresh `applied`
 * event would never override the prior terminal `withdrawn`/`rejected`
 * event still in the history — exactly backwards for a deliberate re-apply.
 */
export async function recordApplication(
  db: Db,
  input: RecordApplicationInput,
): Promise<RecordApplicationResult> {
  const { userId, jobId, tailorGenerationId = null } = input;

  return db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(applications)
      .values({ userId, jobId, tailorGenerationId, status: "applied" })
      .onConflictDoNothing({ target: [applications.userId, applications.jobId] })
      .returning({ id: applications.id });

    if (inserted) {
      await tx.insert(outcomeEvents).values({ applicationId: inserted.id, type: "applied" });
      return { id: inserted.id, created: true as const };
    }

    const [existing] = await tx
      .select({ id: applications.id, status: applications.status })
      .from(applications)
      .where(and(eq(applications.userId, userId), eq(applications.jobId, jobId)))
      .limit(1);

    if (!countsAsApplied(existing.status)) {
      await tx.insert(outcomeEvents).values({ applicationId: existing.id, type: "applied" });
      await tx
        .update(applications)
        .set({ status: "applied", tailorGenerationId })
        .where(eq(applications.id, existing.id));
      return { id: existing.id, created: true as const };
    }

    return { id: existing.id, created: false as const };
  });
}
