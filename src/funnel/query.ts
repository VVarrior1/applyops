/**
 * Shared DB queries behind every "this user's applications, for the funnel"
 * consumer: the owner's `/funnel` page, the public `/results` page (+
 * `/api/public/results`), and the guide's grounding funnel
 * (`src/guide/store.ts`'s `loadUserFunnel`, fed to `/api/guide` and
 * `/api/guide/chat`).
 *
 * All four must apply the exact same `jobs.isPlaceholder` filter — a
 * v1-migration orphan application (`drizzle/0012_generations_user_edits.sql`
 * / the `seed-v1` importer) has no real posting behind it and must never
 * inflate any of these counts or surface as an "Unknown" company (QA
 * finding, Aug 2026: `/funnel` and the guide funnel kept counting it after
 * `/results` was fixed to exclude it). The query lives here once instead of
 * as four hand-maintained copies that can silently drift back apart.
 */

import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { applications, generations, jobs, outcomeEvents, promptVersions } from "../db/schema";
import type { FunnelApplication } from "./derive";

export interface OwnerApplicationRow {
  id: string;
  createdAt: Date;
  jobId: string;
  promptVersion: string | null;
}

/**
 * Builds (without executing) the query {@link ownerApplicationRows} awaits.
 * Split out so `tests/funnel/query.test.ts` can call `.toSQL()` on the real
 * query object — a disconnected `postgres-js` `drizzle()` instance builds
 * SQL text fine without ever opening a socket — and assert the inner join
 * to `jobs` and the `is_placeholder = false` condition are actually present
 * in the generated SQL, instead of a fake `Db` that would just hard-code
 * the same filter the code under test is supposed to apply (and so could
 * never catch it going missing — the exact shape of the bug this query was
 * written to fix; see file header).
 */
export function buildOwnerApplicationRowsQuery(db: Db, userId: string) {
  return db
    .select({
      id: applications.id,
      createdAt: applications.createdAt,
      jobId: applications.jobId,
      promptVersion: promptVersions.version,
    })
    .from(applications)
    .innerJoin(jobs, eq(applications.jobId, jobs.id))
    .leftJoin(generations, eq(applications.tailorGenerationId, generations.id))
    .leftJoin(promptVersions, eq(generations.promptVersionId, promptVersions.id))
    .where(and(eq(applications.userId, userId), eq(jobs.isPlaceholder, false)));
}

/**
 * This user's non-placeholder applications, joined out to their tailoring
 * generation's prompt version. Inner-joined to `jobs` (not left) so a
 * placeholder — or otherwise dangling — job row drops the application from
 * the result entirely, rather than surviving with a null job.
 */
export async function ownerApplicationRows(db: Db, userId: string): Promise<OwnerApplicationRow[]> {
  return buildOwnerApplicationRowsQuery(db, userId);
}

/**
 * Attaches each row's `outcome_events`, producing the shape `deriveFunnel`
 * consumes. Split out from {@link ownerApplicationRows} so callers that also
 * need the raw rows (`/results`' recent-applications list wants `jobId`,
 * which `FunnelApplication` doesn't carry) can fetch rows once and reuse
 * them for both purposes instead of querying `applications` twice.
 */
export async function attachFunnelEvents(
  db: Db,
  appRows: readonly OwnerApplicationRow[],
): Promise<FunnelApplication[]> {
  const events =
    appRows.length === 0
      ? []
      : await db
          .select({
            applicationId: outcomeEvents.applicationId,
            type: outcomeEvents.type,
            occurredAt: outcomeEvents.occurredAt,
          })
          .from(outcomeEvents)
          .where(
            inArray(
              outcomeEvents.applicationId,
              appRows.map((row) => row.id),
            ),
          );

  const eventsByApplication = new Map<string, FunnelApplication["events"]>();
  for (const event of events) {
    const bucket = eventsByApplication.get(event.applicationId);
    const entry = { type: event.type, occurredAt: event.occurredAt };
    if (bucket) bucket.push(entry);
    else eventsByApplication.set(event.applicationId, [entry]);
  }

  return appRows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt,
    promptVersion: row.promptVersion,
    events: eventsByApplication.get(row.id) ?? [],
  }));
}

/**
 * Convenience wrapper for callers that only need `deriveFunnel` input, not
 * the raw rows — `/funnel` and the guide's `loadUserFunnel`.
 */
export async function loadFunnelApplications(db: Db, userId: string): Promise<FunnelApplication[]> {
  const appRows = await ownerApplicationRows(db, userId);
  return attachFunnelEvents(db, appRows);
}
