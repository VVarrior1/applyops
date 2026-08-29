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
import { ENTRY_LEVEL_UNKNOWN_REASON, type Verdict } from "@/src/rank/verdict";

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
  /**
   * `jobs.is_entry_level IS NULL` — the posting body was never fetched and
   * the title gave nothing away, so nobody (not the finder, not the ranker)
   * has actually read this posting's experience requirement. Rendered as an
   * "Unverified" badge so the row is never mistaken for a confirmed
   * entry-level match; the matching verdict caveat is
   * ENTRY_LEVEL_UNKNOWN_REASON (src/rank/verdict.ts).
   */
  entryLevelUnknown: boolean;
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
const RANK_MORE_BATCH_SIZE = 10;

async function parseErrorBody(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `Request failed (${res.status}).`;
  } catch {
    return `Request failed (${res.status}).`;
  }
}

/** A row is "New" at 3 days old or younger — mirrors the Jobs page build spec's badge threshold. */
const NEW_WITHIN_DAYS = 3;

/**
 * `job.postedAt` (ISO) → the "Posted" column's relative age ("Today",
 * "3d ago", "27d ago"), its absolute date for the cell's `title` tooltip,
 * and whether it's fresh enough for the "New" badge. `null` when the
 * posting never carried a date (the SQL posted-date filter still lets such
 * rows through via `scraped_at`, per the Jobs page build spec item 1 — this
 * column just has nothing dated to show for them).
 */
function formatPostedAge(postedAtIso: string | null): { relative: string; absolute: string; isNew: boolean } | null {
  if (!postedAtIso) return null;
  const date = new Date(postedAtIso);
  const days = Math.max(0, Math.floor((Date.now() - date.getTime()) / 86_400_000));
  return {
    relative: days === 0 ? "Today" : `${days}d ago`,
    absolute: format(date, "MMM d, yyyy"),
    isNew: days <= NEW_WITHIN_DAYS,
  };
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
  total,
  totalIsApprox,
  page,
  pageSize,
}: {
  jobs: JobListItem[];
  /** Count of skip-verdict rows in the fetched page, whether or not they're currently shown. */
  skippedCount: number;
  verdictFilter: "worth" | "all";
  /** True COUNT(*) over the same SQL conditions as `jobs` — not the page size, see build spec item 2. */
  total: number;
  /**
   * True when `total` may still include rows that get hidden client-side
   * by `assessJob` (i.e. `verdictFilter === "worth"`) — those blockers
   * aren't all cheap to express in SQL, so `total` is an upper bound in
   * that case, not an exact count. Rendered as "~total" rather than a
   * falsely precise number.
   */
  totalIsApprox: boolean;
  /** 1-indexed current page — already clamped server-side to the last real page. */
  page: number;
  pageSize: number;
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

  // Prev/next: same "preserve every other param" approach as
  // toggleVerdictHref — page 1 (the default) has no `page` param at all.
  function pageHref(targetPage: number): string {
    const params = new URLSearchParams(searchParams.toString());
    if (targetPage <= 1) params.delete("page");
    else params.set("page", String(targetPage));
    const qs = params.toString();
    return qs ? `/jobs?${qs}` : "/jobs";
  }

  // `from` is this page's position in the *fetched* (LIMIT/OFFSET) result
  // set; `to` is derived from `jobs.length` — the rows actually rendered
  // after assessJob's per-row filtering — rather than assumed to equal a
  // full `pageSize`, since a page can render fewer rows than it fetched
  // (QA: "Showing 1–50 of 101" while only 35 rows render). When nothing on
  // this page renders (e.g. every fetched row got hidden), both collapse
  // to 0 rather than producing a reversed/negative range.
  const from = total === 0 || jobs.length === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = jobs.length === 0 ? 0 : from + jobs.length - 1;
  const hasPrev = page > 1;
  const hasNext = page * pageSize < total;

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
          {total === 0
            ? "Showing 0 of 0"
            : `Showing ${from}–${to} of ${totalIsApprox ? "~" : ""}${total}`}
          {skippedCount > 0 && (
            <>
              {" "}
              ·{" "}
              {verdictFilter === "worth"
                ? `${skippedCount} more hidden on this page`
                : `${skippedCount} skipped (shown)`}{" "}
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
          {ranking ? "Scoring…" : "Score 10 newest (≈$0.02)"}
        </Button>
      </div>
      {status && <p className="text-sm text-muted-foreground">{status}</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="overflow-x-auto rounded-lg border">
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
                  {job.entryLevelUnknown && (
                    <Badge
                      variant="outline"
                      className="ml-1.5 border-amber-500/30 bg-amber-500/10 align-middle text-[10px] font-normal text-amber-700 dark:text-amber-400"
                      title={ENTRY_LEVEL_UNKNOWN_REASON}
                    >
                      Unverified
                    </Badge>
                  )}
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
                  {(() => {
                    const age = formatPostedAge(job.postedAt);
                    if (!age) return "—";
                    return (
                      <span title={age.absolute} className="inline-flex items-center gap-1.5">
                        {age.relative}
                        {age.isNew && (
                          <Badge className="border-emerald-500/20 bg-emerald-500/15 text-[10px] text-emerald-700 dark:text-emerald-400">
                            New
                          </Badge>
                        )}
                      </span>
                    );
                  })()}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between gap-2">
        <Link
          href={pageHref(page - 1)}
          aria-disabled={!hasPrev}
          className={`text-sm underline-offset-2 hover:text-foreground ${
            hasPrev ? "text-muted-foreground hover:underline" : "pointer-events-none text-muted-foreground/40"
          }`}
        >
          ← Prev
        </Link>
        <span className="text-xs text-muted-foreground">Page {page}</span>
        <Link
          href={pageHref(page + 1)}
          aria-disabled={!hasNext}
          className={`text-sm underline-offset-2 hover:text-foreground ${
            hasNext ? "text-muted-foreground hover:underline" : "pointer-events-none text-muted-foreground/40"
          }`}
        >
          Next →
        </Link>
      </div>
    </div>
  );
}
