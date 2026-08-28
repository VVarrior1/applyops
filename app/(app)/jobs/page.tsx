import { and, eq, gte, ilike, notInArray, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { requireUser } from "@/src/auth/require";
import { getDb } from "@/src/db/client";
import { applications, atsVendorEnum, companies, jobs, jobScores, workAuthSignalEnum } from "@/src/db/schema";
import type { AtsVendor, WorkAuthSignal } from "@/src/finders/types";
import { COUNTRY_OPTIONS } from "@/src/finders/country";
import { DEFAULT_MODEL_BY_STEP } from "@/src/llm/defaults";
import type { SearchPrefsRow } from "@/src/profile/facts";
import { getPrefs } from "@/src/profile/facts";
import { countryOverlapCondition, countryUnknownCondition, countsAsApplied, lacksUsAuth } from "@/src/rank/candidates";
import { fitRankerVersion, KEYWORD_RANKER_VERSION } from "@/src/rank/rank";
import { roleTitlePatternSource } from "@/src/rank/role-titles";
import { assessJob, type VerdictInput } from "@/src/rank/verdict";
import { JobFilters, type JobFiltersValue, type PostedFilter, type RolesFilter } from "@/components/jobs/JobFilters";
import { JobList, type JobListItem } from "@/components/jobs/JobList";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Jobs",
};

/** Rows per page (build spec item 2 — replaces the old flat `LIMIT 200` browsing cap now that a true COUNT + `page` param make an unbounded page unnecessary). */
const PAGE_SIZE = 50;

/** The finite `posted` windows — "any" means no posted-date condition at all. */
const POSTED_WINDOWS = ["3", "7", "14", "30"] as const;

type RemoteFilter = "any" | "remote" | "onsite";
type VerdictPrefs = NonNullable<VerdictInput["prefs"]>;

function parseRemote(value: string | undefined): RemoteFilter {
  return value === "remote" || value === "onsite" ? value : "any";
}

function parseWorkAuth(value: string | undefined): string {
  const allowed = new Set<string>(workAuthSignalEnum.enumValues);
  return value && allowed.has(value) ? value : "any";
}

function parseVendor(value: string | undefined): string {
  const allowed = new Set<string>(atsVendorEnum.enumValues);
  return value && allowed.has(value) ? value : "any";
}

function parseMinScore(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** "my" (default), "any", "unknown", or one of the user's own `prefs.countries` codes — anything else falls back to "my". */
function parseCountry(value: string | undefined, userCountryCodes: string[]): string {
  if (!value || value === "my") return "my";
  if (value === "any" || value === "unknown") return value;
  return userCountryCodes.includes(value) ? value : "my";
}

function parseVerdict(value: string | undefined): "worth" | "all" {
  return value === "all" ? "all" : "worth";
}

/** Default 7 (build spec item 1) — anything not in {@link POSTED_WINDOWS} or "any" falls back to it. */
function parsePosted(value: string | undefined): PostedFilter {
  if (value === "any") return "any";
  return (POSTED_WINDOWS as readonly string[]).includes(value ?? "") ? (value as PostedFilter) : "7";
}

/** "mine" is the default only when the user actually has a `roles` preference set — otherwise there'd be nothing to filter on, so it behaves like "any" regardless. */
function parseRoles(value: string | undefined, userHasRoles: boolean): RolesFilter {
  if (value === "any") return "any";
  if (value === "mine") return "mine";
  return userHasRoles ? "mine" : "any";
}

function parseQ(value: string | undefined): string {
  return (value ?? "").trim();
}

function parsePage(value: string | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/**
 * `posted_at >= now() - interval '<days> days'`, falling back to
 * `scraped_at` for postings whose board never published a date (build spec
 * item 1: "rows with NULL posted_at are included only when posted=any,
 * otherwise fall back to scraped_at within the same window"). `days` only
 * ever comes from {@link POSTED_WINDOWS} — a fixed, checked enum, never raw
 * user text — so splicing it into the interval literal via `sql.raw` is
 * exactly as safe as `candidateConditions`' own `CANDIDATE_STALE_AFTER_DAYS`
 * interval (src/rank/candidates.ts).
 */
function postedWindowCondition(days: (typeof POSTED_WINDOWS)[number]): SQL {
  const interval = sql.raw(`interval '${days} days'`);
  return sql`(
    (${jobs.postedAt} is not null and ${jobs.postedAt} >= now() - ${interval})
    or (${jobs.postedAt} is null and ${jobs.scrapedAt} >= now() - ${interval})
  )`;
}

/** `search_prefs` (untyped `text` columns) → `assessJob`'s narrow prefs union. The API route (`app/api/profile/prefs/route.ts`) is what actually constrains these values on write. */
function toVerdictPrefs(prefs: SearchPrefsRow | null): VerdictPrefs | null {
  if (!prefs) return null;
  return {
    countries: prefs.countries ?? null,
    workAuth: prefs.workAuth as VerdictPrefs["workAuth"],
    remote: prefs.remote as VerdictPrefs["remote"],
    locations: prefs.locations ?? null,
  };
}

/**
 * `/jobs` — plan Task 8 Step 3: table sorted by fit score (fallback keyword
 * score), filters (min score, remote, work-auth, vendor, country, verdict),
 * plus later additions: a posted-date window, a true COUNT + `page`-based
 * pagination, a title/company search box, and a role-family filter.
 *
 * Restricted to `active ∧ is_entry_level ∧ is_relevant_role`, same as
 * `rankForUser`'s candidate pool (`src/rank/rank.ts`) — this page is "your
 * matches", not a firehose of all ~42k scraped postings (Task 7's notes).
 * Score shown is `COALESCE(fit-v1 score, keyword-v1 score)`, but the two
 * scales differ (0–100 vs 0–10) and this build's live data has fit scores
 * as low as 0 and keyword scores as high as 9, so a naive
 * `ORDER BY COALESCE(...)` can sort a keyword-only row above a fit-scored
 * one. The `ORDER BY` below sorts every fit-scored row ahead of every
 * keyword-only row as a block first, *then* by the (now same-block, so
 * comparable) coalesced score — that's what makes "fit score, fallback
 * keyword score" true. `minScore` filters the fit score alone (see below),
 * not this mixed value.
 *
 * Each row's "is this worth applying to?" verdict (`src/rank/verdict.ts`) is
 * computed server-side from the row's *raw* fit-v1 score (never the
 * coalesced display score — the two scales aren't comparable, see above),
 * `jobs.analysis`, the signed-in user's prefs, and whether they already
 * have an application against that job.
 *
 * `verdict=worth` (the default) drops skip-verdict rows from what's
 * rendered — and, so a COUNT(*) and the rendered page actually agree, the
 * cheap subset of `assessJob`'s hard blockers that ARE expressible as SQL
 * (real country overlap, real work-auth mismatch, already-applied) are also
 * pushed into the WHERE clause when verdict=worth, using the user's actual
 * `search_prefs` — independent of whatever the "country"/"workAuth" URL
 * filters below happen to be set to, exactly mirroring how `assessJob`
 * itself always evaluates against the real prefs, not the URL filters.
 * `assessJob` still runs per fetched row for the caveats that aren't cheaply
 * SQL-expressible (title regex, `analysis.years_min`, fit score, staleness
 * past 45 days, onsite-location mismatch) — any of ITS skip verdicts that
 * slip through the SQL conditions are still hidden client-side, surfaced as
 * "N more hidden on this page" rather than silently shrinking the count.
 */
export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<{
    minScore?: string;
    remote?: string;
    workAuth?: string;
    vendor?: string;
    country?: string;
    verdict?: string;
    posted?: string;
    q?: string;
    roles?: string;
    page?: string;
  }>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const db = getDb();

  const [prefs, appliedRows] = await Promise.all([
    getPrefs(db, user.id),
    db
      .select({ jobId: applications.jobId, status: applications.status })
      .from(applications)
      .where(eq(applications.userId, user.id)),
  ]);
  // Withdrawn (and still-draft) applications must not permanently hide the
  // job or trip assessJob's "already applied" blocker — see
  // countsAsApplied's doc comment (src/rank/candidates.ts).
  const appliedJobIds = new Set(
    appliedRows.filter((r) => countsAsApplied(r.status)).map((r) => r.jobId),
  );

  const userCountryCodes = prefs?.countries ?? [];
  const userCountryOptions = userCountryCodes
    .map((code) => COUNTRY_OPTIONS.find((o) => o.code === code))
    .filter((o): o is { code: string; name: string } => Boolean(o));
  const userRoles = prefs?.roles ?? [];

  const filters: JobFiltersValue = {
    minScore: parseMinScore(sp.minScore),
    remote: parseRemote(sp.remote),
    workAuth: parseWorkAuth(sp.workAuth),
    vendor: parseVendor(sp.vendor),
    country: parseCountry(sp.country, userCountryCodes),
    verdict: parseVerdict(sp.verdict),
    posted: parsePosted(sp.posted),
    q: parseQ(sp.q),
    roles: parseRoles(sp.roles, userRoles.length > 0),
  };
  const page = parsePage(sp.page);

  const fitVersion = fitRankerVersion(DEFAULT_MODEL_BY_STEP.fit);
  const fitScores = alias(jobScores, "fit_scores");
  const kwScores = alias(jobScores, "kw_scores");

  const conditions: SQL[] = [
    eq(jobs.active, true),
    eq(jobs.isEntryLevel, true),
    eq(jobs.isRelevantRole, true),
  ];
  if (filters.remote === "remote") conditions.push(eq(jobs.remote, true));
  if (filters.remote === "onsite") conditions.push(eq(jobs.remote, false));
  if (filters.workAuth !== "any") {
    conditions.push(eq(jobs.workAuthSignal, filters.workAuth as WorkAuthSignal));
  }
  if (filters.vendor !== "any") {
    conditions.push(eq(companies.atsVendor, filters.vendor as AtsVendor));
  }
  if (filters.minScore !== null) {
    // Fit score alone (0–100 scale, matching the input's 0–100 range) —
    // never the keyword score (0–10). A job with no fit score yet is
    // excluded rather than compared on the wrong scale; it still shows up
    // once minScore is cleared or the job gets fit-scored.
    conditions.push(gte(fitScores.score, filters.minScore));
  }
  if (filters.country === "unknown") {
    conditions.push(countryUnknownCondition());
  } else if (filters.country === "my") {
    if (userCountryCodes.length > 0) conditions.push(countryOverlapCondition(userCountryCodes));
  } else if (filters.country !== "any") {
    // A single code drawn from the user's own countries (parseCountry
    // rejects anything else back to "my").
    // An explicit single country is STRICT: no "unknown/anywhere" postings.
    conditions.push(countryOverlapCondition([filters.country], { strict: true }));
  }
  if (filters.posted !== "any") {
    conditions.push(postedWindowCondition(filters.posted));
  }
  if (filters.q) {
    const needle = `%${filters.q}%`;
    conditions.push(sql`(${ilike(jobs.title, needle)} or ${ilike(companies.name, needle)})`);
  }
  if (filters.roles === "mine") {
    const rolePattern = roleTitlePatternSource(userRoles);
    if (rolePattern) conditions.push(sql`${jobs.title} ~* ${rolePattern}`);
  }
  if (filters.verdict === "worth") {
    // The SQL-expressible subset of assessJob's hard blockers, driven by
    // the user's *real* prefs (never the URL filters above) — see the file
    // header.
    if (userCountryCodes.length > 0) conditions.push(countryOverlapCondition(userCountryCodes));
    if (lacksUsAuth(prefs?.workAuth)) {
      conditions.push(sql`(${jobs.workAuthSignal} is null or ${jobs.workAuthSignal} <> 'needs_us_auth')`);
    }
    conditions.push(notInArray(jobs.id, [...appliedJobIds]));
  }

  // Count first, then clamp the page to what actually exists before running
  // the offset query — a stale/typed-in `?page=` past the last page must
  // render the last page (not an empty table with an arithmetically
  // impossible "Showing 4901–101 of 101" header, QA finding "/jobs result
  // count is arithmetically wrong").
  const countRows = await db
    .select({ total: sql<number>`count(*)` })
    .from(jobs)
    .leftJoin(companies, eq(jobs.companyId, companies.id))
    .leftJoin(
      fitScores,
      and(
        eq(fitScores.jobId, jobs.id),
        eq(fitScores.userId, user.id),
        eq(fitScores.rankerVersion, fitVersion),
      ),
    )
    .where(and(...conditions));

  const total = Number(countRows[0]?.total ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const effectivePage = Math.min(page, totalPages);

  const rows = await db
    .select({
      id: jobs.id,
      title: jobs.title,
      companyName: companies.name,
      location: jobs.location,
      remote: jobs.remote,
      workAuthSignal: jobs.workAuthSignal,
      postedAt: jobs.postedAt,
      lastSeenAt: jobs.lastSeenAt,
      active: jobs.active,
      isEntryLevel: jobs.isEntryLevel,
      isRelevantRole: jobs.isRelevantRole,
      countries: jobs.countries,
      analysis: jobs.analysis,
      fitScore: fitScores.score,
      keywordScore: kwScores.score,
    })
    .from(jobs)
    .leftJoin(companies, eq(jobs.companyId, companies.id))
    .leftJoin(
      fitScores,
      and(
        eq(fitScores.jobId, jobs.id),
        eq(fitScores.userId, user.id),
        eq(fitScores.rankerVersion, fitVersion),
      ),
    )
    .leftJoin(
      kwScores,
      and(
        eq(kwScores.jobId, jobs.id),
        eq(kwScores.userId, user.id),
        eq(kwScores.rankerVersion, KEYWORD_RANKER_VERSION),
      ),
    )
    .where(and(...conditions))
    .orderBy(
      // Every fit-scored row (any fit score, including 0) ahead of every
      // keyword-only row, as a block — the two scales are not comparable
      // directly (see the file header).
      sql`(${fitScores.score} IS NOT NULL) DESC`,
      sql`coalesce(${fitScores.score}, ${kwScores.score}) DESC NULLS LAST`,
      sql`${jobs.postedAt} DESC NULLS LAST`,
    )
    .limit(PAGE_SIZE)
    .offset((effectivePage - 1) * PAGE_SIZE);

  const verdictPrefs = toVerdictPrefs(prefs);

  const allItems: JobListItem[] = rows.map((row) => {
    const { verdict, reasons } = assessJob({
      job: {
        title: row.title,
        remote: row.remote,
        countries: row.countries,
        postedAt: row.postedAt,
        lastSeenAt: row.lastSeenAt,
        active: row.active,
        isEntryLevel: row.isEntryLevel,
        isRelevantRole: row.isRelevantRole,
        workAuthSignal: row.workAuthSignal,
        location: row.location,
      },
      analysis: row.analysis,
      fitScore: row.fitScore,
      prefs: verdictPrefs,
      alreadyApplied: appliedJobIds.has(row.id),
    });
    return {
      id: row.id,
      title: row.title,
      companyName: row.companyName,
      location: row.location,
      remote: row.remote,
      workAuthSignal: row.workAuthSignal,
      postedAt: row.postedAt ? row.postedAt.toISOString() : null,
      score: row.fitScore ?? row.keywordScore ?? null,
      scoreKind: row.fitScore != null ? "fit" : row.keywordScore != null ? "keyword" : null,
      countries: row.countries ?? [],
      verdict,
      reasons,
    };
  });

  const skippedCount = allItems.filter((item) => item.verdict === "skip").length;
  const items = filters.verdict === "worth" ? allItems.filter((item) => item.verdict !== "skip") : allItems;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Jobs</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Active, entry-level, relevant postings — sorted by your fit score, falling back to the
          free keyword baseline for anything not yet scored.
        </p>
      </div>

      <JobFilters value={filters} userCountries={userCountryOptions} userRoles={userRoles} />
      <JobList
        jobs={items}
        skippedCount={skippedCount}
        verdictFilter={filters.verdict}
        total={total}
        // `total` is a COUNT(*) over the SQL-expressible conditions only —
        // it still includes rows assessJob would skip for reasons that
        // aren't cheap SQL (senior title, years_min, staleness past 45
        // days, low fit score; see the file header). When verdict=worth
        // those rows are hidden per-page ("N more hidden on this page"),
        // so the total itself is an upper bound, not an exact count of
        // "worth applying" rows — flagged here so JobList can render it as
        // "~101" instead of a falsely precise "101" (QA: /jobs result
        // count self-contradicts the rendered row count).
        totalIsApprox={filters.verdict === "worth"}
        page={effectivePage}
        pageSize={PAGE_SIZE}
      />
    </div>
  );
}
