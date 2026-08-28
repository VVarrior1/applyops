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

/**
 * Postings older than this are excluded from ranking candidates (spec: item
 * 3c). 30, not 45 — the owner explicitly wants no ranking budget spent
 * scoring postings older than 30 days (Jobs page build notes, item 4).
 */
export const CANDIDATE_STALE_AFTER_DAYS = 30;

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
export function countryOverlapCondition(wanted: CountryCode[], opts: { strict?: boolean } = {}): SQL {
  const overlap = sql`${jobs.countries} && ${sql.param(wanted)}::text[]`;
  if (opts.strict) return sql`(${overlap})`;
  // Non-strict: a posting with NO detectable country passes only when its
  // location is remote-ish ("Remote", "Anywhere", null). A concrete city we
  // could not map (e.g. a town in Albania) is treated as abroad, not as
  // "anywhere" — see hasUnrecognizedGeography() in src/finders/country.ts.
  return sql`(${overlap} or ((${jobs.countries} is null or cardinality(${jobs.countries}) = 0) and ${remoteishLocationCondition()}))`;
}

/** SQL twin of isRemoteishLocation(): null location or a remote-ish token (Postgres uses \y for word boundaries). */
export function remoteishLocationCondition(): SQL {
  return sql`(${jobs.location} is null or ${jobs.location} ~* '\\y(remote|anywhere|worldwide|world-wide|global|distributed|work from home|wfh|virtual|telecommute)\\y')`;
}

export function countryUnknownCondition(): SQL {
  return sql`(${jobs.countries} is null or cardinality(${jobs.countries}) = 0)`;
}

/**
 * Whether a prefs `workAuth` value means "doesn't already have US work
 * authorization" — exported so `/jobs`' verdict=worth SQL blockers can apply
 * the exact same rule `candidateConditions` uses below, rather than a second
 * hand-maintained copy.
 */
export function lacksUsAuth(workAuth: string | null | undefined): boolean {
  return workAuth === "canada" || workAuth === "needs_sponsorship" || workAuth == null;
}

/**
 * `applications.status` values that must NOT count as "the user has applied
 * to this posting" for `/jobs`' exclusion filter or `assessJob`'s
 * already-applied hard blocker — `withdrawn` (the user took it back) and
 * `draft` (never actually submitted). Every other status (including
 * `rejected`/`ghosted`, which are still real applications) counts as
 * applied. Without this, withdrawing an application permanently hid the job
 * from `/jobs` and made the detail page claim "You already applied" forever,
 * with no way back (QA finding, Aug 2026).
 */
const NOT_APPLIED_STATUSES = new Set(["draft", "withdrawn"]);

/** See {@link NOT_APPLIED_STATUSES}. */
export function countsAsApplied(status: string): boolean {
  return !NOT_APPLIED_STATUSES.has(status);
}

/**
 * `applications` rows for one user → the set of `jobId`s that count as
 * applied ({@link countsAsApplied}), i.e. must be hidden/blocked. Pulled out
 * of `app/(app)/jobs/page.tsx`'s `appliedJobIds` derivation so the actual
 * regression this guards against (a call site treating any row — including
 * a withdrawn one — as "applied") is covered by a unit test instead of only
 * by a manual repro against the rendered page.
 */
export function appliedJobIds<T extends { jobId: string; status: string }>(
  appliedRows: readonly T[],
): Set<string> {
  return new Set(appliedRows.filter((row) => countsAsApplied(row.status)).map((row) => row.jobId));
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
