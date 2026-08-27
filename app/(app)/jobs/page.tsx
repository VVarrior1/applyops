import { and, eq, gte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { requireUser } from "@/src/auth/require";
import { getDb } from "@/src/db/client";
import { applications, atsVendorEnum, companies, jobs, jobScores, workAuthSignalEnum } from "@/src/db/schema";
import type { AtsVendor, WorkAuthSignal } from "@/src/finders/types";
import { COUNTRY_OPTIONS } from "@/src/finders/country";
import { DEFAULT_MODEL_BY_STEP } from "@/src/llm/defaults";
import type { SearchPrefsRow } from "@/src/profile/facts";
import { getPrefs } from "@/src/profile/facts";
import { countryOverlapCondition, countryUnknownCondition } from "@/src/rank/candidates";
import { fitRankerVersion, KEYWORD_RANKER_VERSION } from "@/src/rank/rank";
import { assessJob, type VerdictInput } from "@/src/rank/verdict";
import { JobFilters, type JobFiltersValue } from "@/components/jobs/JobFilters";
import { JobList, type JobListItem } from "@/components/jobs/JobList";

/** Rows fetched per load. The live table has ~2k active+entry+relevant jobs total (Task 7's notes); this is a browsing cap, not a hard ceiling on ranking. */
const JOBS_PAGE_LIMIT = 200;

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
 * score), filters (min score, remote, work-auth, vendor, country, verdict).
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
 * have an application against that job. `verdict=worth` (the default) then
 * drops skip-verdict rows from what's rendered — after computing verdicts
 * for the whole fetched page, not via a SQL filter, since several of
 * `assessJob`'s hard blockers (title regex, `analysis.years_min`, fit score)
 * aren't cheaply expressible as SQL.
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
  }>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const db = getDb();

  const prefs = await getPrefs(db, user.id);
  const userCountryCodes = prefs?.countries ?? [];
  const userCountryOptions = userCountryCodes
    .map((code) => COUNTRY_OPTIONS.find((o) => o.code === code))
    .filter((o): o is { code: string; name: string } => Boolean(o));

  const filters: JobFiltersValue = {
    minScore: parseMinScore(sp.minScore),
    remote: parseRemote(sp.remote),
    workAuth: parseWorkAuth(sp.workAuth),
    vendor: parseVendor(sp.vendor),
    country: parseCountry(sp.country, userCountryCodes),
    verdict: parseVerdict(sp.verdict),
  };

  const fitVersion = fitRankerVersion(DEFAULT_MODEL_BY_STEP.fit);
  const fitScores = alias(jobScores, "fit_scores");
  const kwScores = alias(jobScores, "kw_scores");

  const conditions = [
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
    conditions.push(countryOverlapCondition([filters.country]));
  }

  const [rows, appliedRows] = await Promise.all([
    db
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
      .limit(JOBS_PAGE_LIMIT),
    db.select({ jobId: applications.jobId }).from(applications).where(eq(applications.userId, user.id)),
  ]);

  const appliedJobIds = new Set(appliedRows.map((r) => r.jobId));
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

      <JobFilters value={filters} userCountries={userCountryOptions} />
      <JobList jobs={items} skippedCount={skippedCount} verdictFilter={filters.verdict} />
    </div>
  );
}
