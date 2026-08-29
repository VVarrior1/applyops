import { and, desc, eq, inArray } from "drizzle-orm";
import { format } from "date-fns";
import { requireUser } from "@/src/auth/require";
import { getDb } from "@/src/db/client";
import { applications, companies, jobs, outcomeEvents } from "@/src/db/schema";
import { OutcomeButtons } from "@/components/applications/OutcomeButtons";
import { PendingApprovals } from "@/components/applications/PendingApprovals";
import { AddApplicationDialog } from "@/components/applications/AddApplicationDialog";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Applications",
};

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  applied: "Applied",
  responded: "Responded",
  interviewing: "Interviewing",
  offer: "Offer",
  rejected: "Rejected",
  ghosted: "Ghosted",
  withdrawn: "Withdrawn",
};

const EVENT_LABEL: Record<string, string> = {
  ...STATUS_LABEL,
  viewed: "Viewed",
  response: "Response",
  oa: "OA",
  phone_screen: "Phone screen",
  interview: "Interview",
};

/**
 * `/applications` — plan Task 10 Step 2: a table (company, title, status,
 * applied date, last event) with outcome-logging buttons per row.
 *
 * Also renders Task 15's `<PendingApprovals />` panel above the list — the
 * apply agent's approval gate seen from the web app (spec §10).
 */
export default async function ApplicationsPage() {
  const user = await requireUser();
  const db = getDb();

  const rows = await db
    .select({
      id: applications.id,
      status: applications.status,
      createdAt: applications.createdAt,
      jobTitle: jobs.title,
      jobSource: jobs.source,
      companyName: companies.name,
    })
    .from(applications)
    .innerJoin(jobs, eq(applications.jobId, jobs.id))
    .leftJoin(companies, eq(jobs.companyId, companies.id))
    // `isPlaceholder` excludes v1-migration-orphan rows (no real posting
    // behind them — see src/db/schema.ts) from the owner's own table too,
    // not just the public /results page.
    .where(and(eq(applications.userId, user.id), eq(jobs.isPlaceholder, false)))
    .orderBy(desc(applications.createdAt));

  const events =
    rows.length === 0
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
              rows.map((row) => row.id),
            ),
          );

  const lastEventByApplication = new Map<string, { type: string; occurredAt: Date }>();
  for (const event of events) {
    const existing = lastEventByApplication.get(event.applicationId);
    if (!existing || event.occurredAt > existing.occurredAt) {
      lastEventByApplication.set(event.applicationId, {
        type: event.type,
        occurredAt: event.occurredAt,
      });
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Applications</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Everything you have applied to, and anything the apply agent is waiting on. The
            funnel derived from these events is on the{" "}
            <a href="/funnel" className="underline underline-offset-2">
              Funnel
            </a>{" "}
            page.
          </p>
        </div>
        <AddApplicationDialog />
      </div>

      <PendingApprovals userId={user.id} />

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Company</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Applied</TableHead>
              <TableHead>Last event</TableHead>
              <TableHead>Log outcome</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground">
                  <div className="flex flex-col items-center gap-3 py-4">
                    <p>
                      No applications yet — mark a tailored resume as applied from a job&apos;s
                      Tailor tab, or add one you applied to elsewhere.
                    </p>
                    <AddApplicationDialog variant="outline" />
                  </div>
                </TableCell>
              </TableRow>
            )}
            {rows.map((row) => {
              const lastEvent = lastEventByApplication.get(row.id);
              return (
                <TableRow key={row.id}>
                  <TableCell className="font-medium">
                    <span className="flex items-center gap-1.5">
                      {row.companyName ?? "—"}
                      {row.jobSource === "manual" && (
                        <Badge variant="secondary" className="text-[10px]">
                          manual
                        </Badge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="max-w-60 truncate whitespace-normal">
                    {row.jobTitle}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{STATUS_LABEL[row.status] ?? row.status}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {format(row.createdAt, "MMM d, yyyy")}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {lastEvent
                      ? `${EVENT_LABEL[lastEvent.type] ?? lastEvent.type} · ${format(lastEvent.occurredAt, "MMM d")}`
                      : "—"}
                  </TableCell>
                  <TableCell>
                    <OutcomeButtons applicationId={row.id} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
