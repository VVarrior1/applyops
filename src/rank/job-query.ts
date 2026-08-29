/**
 * `/jobs`' two newest URL parameters — `level` and `sort` — as pure,
 * unit-testable helpers.
 *
 * They live here rather than inline in `app/(app)/jobs/page.tsx` for the same
 * reason `candidates.ts` exists: the page module can't be imported from a test
 * (it pulls in `requireUser`, the DB client and Next's request context), so
 * anything inline there is only ever verified by loading the page in a
 * browser. The parsing and the ORDER BY / WHERE fragments are the parts most
 * likely to be got subtly wrong — a missing `NULLS LAST` silently sorts the
 * least useful rows to the top — so they get tests
 * (`tests/rank/job-query.test.ts`).
 */
import { asc, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { jobs } from "../db/schema";

// ---------------------------------------------------------------------------
// level
// ---------------------------------------------------------------------------

/**
 * Which `jobs.is_entry_level` values `/jobs` shows.
 *
 * The column is three-valued (`classifyEntryLevel`, src/finders/filters.ts):
 * `true` / `false` / `NULL` = "no posting body was ever fetched and the title
 * gave nothing away".
 *
 *   entry   → `= true` only. The default, and the whole point of the Aug 2026
 *             fix: before it, unknown rows were stored as `true` and a new
 *             grad was looking at "5+ years" postings.
 *   unknown → `true` OR `NULL`. For deliberately going through the
 *             not-yet-verified pile; each such row carries the
 *             `ENTRY_LEVEL_UNKNOWN_REASON` caveat in its verdict.
 *   any     → no condition at all, including confirmed non-entry-level rows.
 */
export type LevelFilter = "entry" | "unknown" | "any";

export const LEVEL_VALUES = ["entry", "unknown", "any"] as const;

/** Anything not in {@link LEVEL_VALUES} falls back to the `entry` default. */
export function parseLevel(value: string | undefined): LevelFilter {
  return (LEVEL_VALUES as readonly string[]).includes(value ?? "")
    ? (value as LevelFilter)
    : "entry";
}

/** The WHERE fragment for a {@link LevelFilter} — `null` when it filters nothing. */
export function levelCondition(level: LevelFilter): SQL | null {
  if (level === "any") return null;
  if (level === "unknown") {
    return sql`(${jobs.isEntryLevel} = true or ${jobs.isEntryLevel} is null)`;
  }
  return sql`${jobs.isEntryLevel} = true`;
}

// ---------------------------------------------------------------------------
// sort
// ---------------------------------------------------------------------------

/**
 *   fit     → best match first (the default): every fit-scored row ahead of
 *             every keyword-only row as a block, then by score, then newest.
 *             The block split is load-bearing — fit is 0–100 and keyword is
 *             0–10, so a naive `coalesce(...) DESC` sorts a keyword 9 above a
 *             fit 62. See `app/(app)/jobs/page.tsx`'s header.
 *   newest  → most recently posted first.
 *   oldest  → least recently posted first (for working the backlog before it
 *             ages out of the 30-day ranking window).
 *   company → company name A→Z, newest posting first within a company.
 */
export type SortOption = "fit" | "newest" | "oldest" | "company";

export const SORT_VALUES = ["fit", "newest", "oldest", "company"] as const;

export const SORT_LABELS: Record<SortOption, string> = {
  fit: "Best fit",
  newest: "Newest first",
  oldest: "Oldest first",
  company: "Company A–Z",
};

/** Anything not in {@link SORT_VALUES} falls back to the `fit` default. */
export function parseSort(value: string | undefined): SortOption {
  return (SORT_VALUES as readonly string[]).includes(value ?? "")
    ? (value as SortOption)
    : "fit";
}

/**
 * The ORDER BY terms for a {@link SortOption}.
 *
 * Every ordering ends up deterministic and puts unknowns last: `posted_at`
 * is NULL for a real chunk of the corpus and Postgres sorts NULLs FIRST in a
 * DESC order, which would otherwise hand the top of every "newest" page to
 * the postings whose date we never learned.
 *
 * The score columns are passed in rather than imported because the page joins
 * `job_scores` twice under aliases (`fit_scores`, `kw_scores`) — there is no
 * single module-level column object to reference.
 */
export function sortOrder(
  sort: SortOption,
  cols: { fitScore: SQLWrapper; keywordScore: SQLWrapper; companyName: SQLWrapper },
): SQL[] {
  const newest = sql`${jobs.postedAt} DESC NULLS LAST`;
  switch (sort) {
    case "newest":
      return [newest];
    case "oldest":
      return [sql`${jobs.postedAt} ASC NULLS LAST`];
    case "company":
      return [sql`${asc(cols.companyName)} NULLS LAST`, newest];
    case "fit":
    default:
      return [
        sql`(${cols.fitScore} IS NOT NULL) DESC`,
        sql`coalesce(${cols.fitScore}, ${cols.keywordScore}) DESC NULLS LAST`,
        newest,
      ];
  }
}
