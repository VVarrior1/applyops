/**
 * The SQL conditions that narrow "every active/entry-level/relevant job" down
 * to "jobs actually worth spending this user's ranking budget/attention on"
 * — country, work authorization, and freshness. Pulled out of
 * `selectCandidateJobs` (src/rank/rank.ts) into its own pure-ish helper so
 * the Jobs page (`app/(app)/jobs/page.tsx`) can apply the exact same rules
 * a user's "My countries" filter and the ranker's candidate pool agree on,
 * rather than two hand-maintained copies drifting apart.
 *
 * Each condition is independently optional — a user with no countries
 * preference (`null`/`[]`, meaning "anywhere") gets no country condition at
 * all rather than one that (incorrectly) matches nothing.
 */
import { sql, type SQL } from "drizzle-orm";
import { jobs } from "../db/schema";
import type { CountryCode } from "../finders/country";
import type { SearchPrefsRow } from "../profile/facts";

/** Postings older than this are excluded from ranking candidates (spec: item 3c). */
export const CANDIDATE_STALE_AFTER_DAYS = 45;

/** Only the two prefs fields this module reads — callers can pass a full `SearchPrefsRow` or a partial fake in tests. */
export type CandidatePrefs = Pick<SearchPrefsRow, "countries" | "workAuth"> | null;

/**
 * `jobs.countries` overlaps `wanted`, treating `null`/`[]` on either side as
 * "unknown/anywhere" (mirrors `countriesAllow` in src/finders/country.ts,
 * expressed as SQL instead of a JS predicate since this runs inside a
 * database query). `wanted` is bound as a single parameterized `text[]`
 * value via `sql.param` — not spliced into the query text — so it is never
 * inlined SQL and works for any array length.
 */
export function countryOverlapCondition(wanted: CountryCode[]): SQL {
  return sql`(${jobs.countries} is null or cardinality(${jobs.countries}) = 0 or ${jobs.countries} && ${sql.param(wanted)}::text[])`;
}

/** `jobs.countries` is unset or empty — "unknown / anywhere" postings only. */
export function countryUnknownCondition(): SQL {
  return sql`(${jobs.countries} is null or cardinality(${jobs.countries}) = 0)`;
}

function lacksUsAuth(workAuth: string | null | undefined): boolean {
  return workAuth === "canada" || workAuth === "needs_sponsorship" || workAuth == null;
}

/**
 * The three candidate-narrowing conditions (spec items 3a–3c), included only
 * when they'd actually narrow anything:
 *
 *   (a) country overlap — omitted entirely when the user has no countries
 *       preference (nothing to filter on).
 *   (b) exclude `work_auth_signal = 'needs_us_auth'` postings, unless the
 *       user has confirmed US work authorization (`us_citizen_pr` or
 *       `tn_eligible`); a `null`/missing `workAuth` counts as "doesn't have
 *       it" — always included in that case.
 *   (c) exclude postings older than {@link CANDIDATE_STALE_AFTER_DAYS} days;
 *       a `null` `posted_at` is kept (an unknown date is not evidence of
 *       staleness) — always included, independent of prefs.
 */
export function candidateConditions(prefs: CandidatePrefs): SQL[] {
  const conditions: SQL[] = [];

  const wanted = (prefs?.countries ?? []) as CountryCode[];
  if (wanted.length > 0) {
    conditions.push(countryOverlapCondition(wanted));
  }

  if (lacksUsAuth(prefs?.workAuth)) {
    conditions.push(sql`(${jobs.workAuthSignal} is null or ${jobs.workAuthSignal} <> 'needs_us_auth')`);
  }

  conditions.push(
    sql`(${jobs.postedAt} is null or ${jobs.postedAt} >= now() - ${sql.raw(`interval '${CANDIDATE_STALE_AFTER_DAYS} days'`)})`,
  );

  return conditions;
}
