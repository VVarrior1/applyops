import Link from "next/link";
import { requireUser } from "@/src/auth/require";
import { getDb } from "@/src/db/client";
import { deriveFunnel, type FunnelGroupBy } from "@/src/funnel/derive";
import { loadFunnelApplications } from "@/src/funnel/query";
import { FunnelChart } from "@/components/funnel/FunnelChart";
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
  title: "Funnel",
};

const GROUP_BY_OPTIONS: { value: FunnelGroupBy; label: string }[] = [
  { value: "week", label: "Week" },
  { value: "prompt_version", label: "Prompt version" },
  { value: "all", label: "All time" },
];

function isFunnelGroupBy(value: string | undefined): value is FunnelGroupBy {
  return value === "week" || value === "prompt_version" || value === "all";
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/**
 * `/funnel` — plan Task 10 Step 2: group-by toggle, table + CSS bar chart,
 * CI shown as text. Funnel metrics are derived here from `applications` +
 * `outcome_events` on every request (spec §4: "never stored").
 */
export default async function FunnelPage({
  searchParams,
}: {
  searchParams: Promise<{ groupBy?: string }>;
}) {
  const user = await requireUser();
  const { groupBy: rawGroupBy } = await searchParams;
  const groupBy: FunnelGroupBy = isFunnelGroupBy(rawGroupBy) ? rawGroupBy : "week";

  const db = getDb();

  // Non-placeholder applications only — see src/funnel/query.ts on why a
  // v1-migration orphan application must never inflate this page's counts.
  const funnelApplications = await loadFunnelApplications(db, user.id);

  const rows = deriveFunnel(funnelApplications, { groupBy });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Funnel</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Derived from logged outcome events — never stored directly.
        </p>
      </div>

      <div className="flex gap-1 self-start rounded-lg border p-1">
        {GROUP_BY_OPTIONS.map((option) => (
          <Link
            key={option.value}
            href={`/funnel?groupBy=${option.value}`}
            className={
              "rounded-md px-3 py-1.5 text-sm transition-colors " +
              (groupBy === option.value
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground")
            }
          >
            {option.label}
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No applications yet — outcomes you log on the{" "}
          <Link href="/applications" className="underline underline-offset-2">
            Applications
          </Link>{" "}
          page will show up here.
        </p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{groupBy === "week" ? "Week" : groupBy === "prompt_version" ? "Prompt version" : "Group"}</TableHead>
                  <TableHead className="text-right">Applied</TableHead>
                  <TableHead className="text-right">Responded</TableHead>
                  <TableHead className="text-right">Interviewing</TableHead>
                  <TableHead className="text-right">Offers</TableHead>
                  <TableHead className="text-right">Rejected</TableHead>
                  <TableHead className="text-right">Ghosted</TableHead>
                  <TableHead className="text-right">Response rate</TableHead>
                  <TableHead className="text-right">Interview rate</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const [ciLower, ciUpper] = row.responseRateCi95;
                  return (
                    <TableRow key={row.key}>
                      <TableCell className="font-medium">{row.key}</TableCell>
                      <TableCell className="text-right">{row.applied}</TableCell>
                      <TableCell className="text-right">{row.responded}</TableCell>
                      <TableCell className="text-right">{row.interviewing}</TableCell>
                      <TableCell className="text-right">{row.offers}</TableCell>
                      <TableCell className="text-right">{row.rejected}</TableCell>
                      <TableCell className="text-right">{row.ghosted}</TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {pct(row.responseRate)}{" "}
                        <span className="text-xs">
                          (CI {Math.round(ciLower * 100)}–{Math.round(ciUpper * 100)}%)
                        </span>
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {pct(row.interviewRate)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          <FunnelChart rows={rows} />
        </>
      )}
    </div>
  );
}
