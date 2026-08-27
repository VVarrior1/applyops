import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/src/db/client";
import { applications, approvals, companies, jobs } from "@/src/db/schema";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

/**
 * The dashboard half of the apply agent's approval gate (spec §10).
 *
 * When `applyops apply` reaches a submit button it screenshots the filled
 * form, writes an `approvals` row with `decision = 'pending'`, and blocks on a
 * `y/N` in the terminal. This panel is the same event seen from the web app:
 * if the operator walked away from the terminal, or the run was killed, the
 * pending row is still here with the job it belongs to and the path to the
 * screenshot that was captured.
 *
 * Deliberately read-only. The decision has to be made where the browser is
 * still open — a button here could not resume a Playwright session that lives
 * in another process on the operator's laptop, and an "Approve" control that
 * silently does nothing to the actual form is worse than no control at all.
 *
 * Screenshots live at `~/.applyops/screenshots/…` on the machine that ran the
 * agent, never in Supabase Storage: they are pictures of a form pre-filled
 * with the user's own contact details, and there is no reason for them to
 * leave that machine.
 */
export async function PendingApprovals({ userId }: { userId: string }) {
  const db = getDb();

  const rows = await db
    .select({
      id: approvals.id,
      summary: approvals.summary,
      screenshotPath: approvals.screenshotPath,
      applicationId: approvals.applicationId,
      jobTitle: jobs.title,
      jobUrl: jobs.url,
      companyName: companies.name,
    })
    .from(approvals)
    .innerJoin(applications, eq(applications.id, approvals.applicationId))
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    // Scoped to the signed-in user, like every other query in app/ (spec §4).
    .where(and(eq(applications.userId, userId), eq(approvals.decision, "pending")))
    // `approvals` has no chronological column (only `decided_at`, which is
    // null while a row is pending), and adding one is out of scope here, so
    // newest-first is not available. Ordering by the primary key would sort by
    // a random UUIDv4 and change on every render; company/title is stable and
    // means something to the reader.
    .orderBy(asc(companies.name), asc(jobs.title));

  if (rows.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Waiting for your approval
          <Badge variant="destructive">{rows.length}</Badge>
        </CardTitle>
        <CardDescription>
          The apply agent filled these forms and stopped before submitting. Answer{" "}
          <code className="font-mono">y/N</code> in the terminal running{" "}
          <code className="font-mono">applyops apply</code> to submit or skip.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {rows.map((row) => (
          <div key={row.id} className="rounded-lg border p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium">
                {row.jobTitle} · {row.companyName}
              </span>
              <a
                href={row.jobUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="text-xs text-muted-foreground underline underline-offset-2"
              >
                open posting
              </a>
            </div>
            {row.summary && (
              <p className="mt-2 text-sm text-muted-foreground">{row.summary}</p>
            )}
            {row.screenshotPath && (
              <p className="mt-2 font-mono text-xs break-all text-muted-foreground">
                {row.screenshotPath}
              </p>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
