"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { VerdictBadge } from "@/components/jobs/VerdictBadge";
import type { Verdict } from "@/src/rank/verdict";

export interface JobListItem {
  id: string;
  title: string;
  companyName: string | null;
  location: string | null;
  remote: boolean | null;
  workAuthSignal: string | null;
  /** ISO string, or null when the board never published a date. */
  postedAt: string | null;
  /** The score actually shown — `fit-v1` when it exists, else `keyword-v1`, else null. */
  score: number | null;
  scoreKind: "fit" | "keyword" | null;
  /** ISO-3166 alpha-2 codes detected from the location; [] = unknown/anywhere. */
  countries: string[];
  verdict: Verdict;
  /** Hard blockers first, then soft caveats — see src/rank/verdict.ts. */
  reasons: string[];
}

const WORK_AUTH_LABEL: Record<string, string> = {
  hires_canadians: "Hires Canadians",
  tn_friendly: "TN friendly",
  needs_us_auth: "Needs US auth",
};

/**
 * Batch size for one "Rank more" click. Small on purpose: each job costs a
 * sequential `analyze` + `fit` LLM round trip inside the `/api/rank` route
 * handler, and this button can be clicked repeatedly rather than needing to
 * request everything in one request. Bulk ranking has no such constraint —
 * that's `applyops rank --max`, run outside a request/response cycle.
 */
const RANK_MORE_BATCH_SIZE = 5;

async function parseErrorBody(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `Request failed (${res.status}).`;
  } catch {
    return `Request failed (${res.status}).`;
  }
}

/**
 * `/jobs`'s ranked table plus the "Rank more" action (plan Task 8 Step 3).
 * Score is shown on whichever scale actually produced it — `fit-v1` (0–100)
 * when it exists, `keyword-v1` (0–10, tagged "kw") as a fallback — a job
 * with neither shows a dash and sorts last (the page does the sorting;
 * this component only renders the order it's given).
 */
export function JobList({
  jobs,
  skippedCount,
  verdictFilter,
}: {
  jobs: JobListItem[];
  /** Count of skip-verdict rows in the fetched page, whether or not they're currently shown. */
  skippedCount: number;
  verdictFilter: "worth" | "all";
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [ranking, setRanking] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Preserves every other filter while flipping just `verdict` — "hide
  // skips" (the default) has no `verdict` param at all, so toggling back to
  // it means deleting the key rather than writing "worth" explicitly.
  const toggleVerdictHref = (() => {
    const params = new URLSearchParams(searchParams.toString());
    if (verdictFilter === "worth") params.set("verdict", "all");
    else params.delete("verdict");
    const qs = params.toString();
    return qs ? `/jobs?${qs}` : "/jobs";
  })();

  async function handleRankMore() {
    setRanking(true);
    setError(null);
    setStatus(null);
    try {
      const res = await fetch("/api/rank", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxJobs: RANK_MORE_BATCH_SIZE }),
      });
      if (!res.ok) {
        setError(await parseErrorBody(res));
        return;
      }
      const body = (await res.json()) as { scored: number; skipped: number; costUsd: number };
      setStatus(
        `Scored ${body.scored} · skipped ${body.skipped} · $${body.costUsd.toFixed(4)}`,
      );
      router.refresh();
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setRanking(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {jobs.length} job{jobs.length === 1 ? "" : "s"}
          {skippedCount > 0 && (
            <>
              {" "}
              · {skippedCount} {verdictFilter === "worth" ? "hidden as skip" : "skipped (shown)"}{" "}
              <Link
                href={toggleVerdictHref}
                className="underline underline-offset-2 hover:text-foreground"
              >
                {verdictFilter === "worth" ? "show skipped" : "hide skipped"}
              </Link>
            </>
          )}
        </p>
        <Button onClick={handleRankMore} disabled={ranking} size="sm">
          {ranking ? "Ranking…" : "Rank more"}
        </Button>
      </div>
      {status && <p className="text-sm text-muted-foreground">{status}</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Verdict</TableHead>
            <TableHead>Score</TableHead>
            <TableHead>Title</TableHead>
            <TableHead>Company</TableHead>
            <TableHead>Location</TableHead>
            <TableHead>Work auth</TableHead>
            <TableHead>Posted</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {jobs.length === 0 && (
            <TableRow>
              <TableCell colSpan={7} className="text-center text-muted-foreground">
                No jobs match these filters yet. Try “Rank more” or widen the filters.
              </TableCell>
            </TableRow>
          )}
          {jobs.map((job) => (
            <TableRow key={job.id}>
              <TableCell title={job.reasons.join("\n")}>
                <div className="flex flex-col gap-0.5">
                  <VerdictBadge verdict={job.verdict} reasons={job.reasons} />
                  {job.reasons[0] && (
                    <span className="max-w-40 truncate text-[11px] text-muted-foreground">
                      {job.reasons[0]}
                    </span>
                  )}
                </div>
              </TableCell>
              <TableCell>
                {job.score === null ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <span className="font-medium">
                    {job.score}
                    {job.scoreKind === "keyword" && (
                      <span className="ml-1 text-xs font-normal text-muted-foreground">kw</span>
                    )}
                  </span>
                )}
              </TableCell>
              <TableCell className="max-w-72 truncate whitespace-normal">
                <Link href={`/jobs/${job.id}`} className="font-medium hover:underline">
                  {job.title}
                </Link>
              </TableCell>
              <TableCell>{job.companyName ?? "—"}</TableCell>
              <TableCell className="max-w-48 truncate text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  {job.location ?? (job.remote ? "Remote" : "—")}
                  {job.countries.length > 0 && (
                    <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
                      {job.countries.join(", ")}
                    </Badge>
                  )}
                </span>
              </TableCell>
              <TableCell>
                {job.workAuthSignal && WORK_AUTH_LABEL[job.workAuthSignal] ? (
                  <Badge variant="outline">{WORK_AUTH_LABEL[job.workAuthSignal]}</Badge>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {job.postedAt ? format(new Date(job.postedAt), "MMM d") : "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
