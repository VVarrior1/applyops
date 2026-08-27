/**
 * `keywordScore` — the deterministic ranking baseline (spec §5: "Ranker v0").
 *
 * A direct port of v1's `calculatePriorityScore` (`~/Job_Auto_Apply/lib/db.ts`),
 * kept byte-for-byte equivalent in its point values so the two rankers are
 * genuinely comparable once `job_scores` has enough rows under both
 * `ranker_version`s to compare precision@10 against outcomes (spec §5). It
 * costs nothing to run (no LLM, no DB), which is what makes it a safe
 * fallback: `rankForUser` (`src/rank/rank.ts`) writes a `keyword-v1` row for
 * every job it visits regardless of whether the `fit` LLM call for that job
 * succeeds, so the Jobs UI always has *some* score to sort by.
 *
 * Two field-level departures from v1, both because this schema doesn't carry
 * what v1's did:
 *
 *   - v1's `source` was a scrape-source string (`'yc'`, `'wellfound'`, a
 *     Greenhouse company slug, …) and gave +1 for `'yc'` or `'wellfound'`.
 *     This build's finders (Task 7) have no Wellfound adapter, so the only
 *     signal left is `companies.ats_vendor === 'yc'`.
 *   - v1 read `job.scraped_at`/`job.posted_at` as ISO strings off a CSV row;
 *     here they're `Date | null` columns, so {@link toDate} accepts either.
 */

/** The subset of a job's fields v1's scoring rules read. */
export interface KeywordScoreInput {
  title: string;
  location: string | null;
  remote: boolean | null;
  description: string | null;
  postedAt: Date | string | null;
  scrapedAt: Date | string | null;
  /** `companies.ats_vendor` — see file header re: the dropped `source` field. */
  atsVendor?: string | null;
}

/** Posting freshness bonus (v1: `< 7 days` → +2, `< 14 days` → +1). */
const FRESH_DAYS_HIGH = 7;
const FRESH_DAYS_LOW = 14;

function toDate(value: Date | string | null): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysOld(date: Date): number {
  return (Date.now() - date.getTime()) / (1000 * 60 * 60 * 24);
}

/**
 * v1's `calculatePriorityScore`, ported. 0–10: +2 freshness, +3
 * location/remote (Calgary and remote are equal top priority; Canada +2;
 * USA +1 — mutually exclusive, in that order), +2 title match, +1 YC, +2
 * (capped) description keyword hits. Capped at 10 overall, same as v1.
 */
export function keywordScore(job: KeywordScoreInput): number {
  let score = 0;

  // Freshness: posted_at, falling back to scraped_at (v1's exact fallback).
  const postedOrScraped = toDate(job.postedAt) ?? toDate(job.scrapedAt);
  if (postedOrScraped) {
    const age = daysOld(postedOrScraped);
    if (age < FRESH_DAYS_HIGH) score += 2;
    else if (age < FRESH_DAYS_LOW) score += 1;
  }

  // Location priority: Calgary > Remote > Canada > USA > other.
  const locationLower = (job.location ?? "").toLowerCase();
  if (locationLower.includes("calgary")) {
    score += 3;
  } else if (job.remote) {
    score += 3;
  } else if (locationLower.includes("canada") || locationLower.includes("canadian")) {
    score += 2;
  } else if (
    locationLower.includes("usa") ||
    locationLower.includes("united states") ||
    locationLower.includes("u.s.")
  ) {
    score += 1;
  }

  // Title match.
  const titleLower = (job.title ?? "").toLowerCase();
  if (
    titleLower.includes("new grad") ||
    titleLower.includes("junior") ||
    titleLower.includes("ml") ||
    titleLower.includes("ai") ||
    titleLower.includes("full stack") ||
    titleLower.includes("fullstack")
  ) {
    score += 2;
  }

  // Source bonus — see file header for why this is narrower than v1.
  if ((job.atsVendor ?? "").toLowerCase() === "yc") {
    score += 1;
  }

  // Description keywords, capped at +2 regardless of how many hit.
  const descriptionLower = (job.description ?? "").toLowerCase();
  let keywordHits = 0;
  if (descriptionLower.includes("next.js") || descriptionLower.includes("nextjs")) keywordHits++;
  if (descriptionLower.includes("python")) keywordHits++;
  if (descriptionLower.includes("gcp") || descriptionLower.includes("google cloud")) keywordHits++;
  if (descriptionLower.includes("typescript")) keywordHits++;
  if (descriptionLower.includes("react")) keywordHits++;
  score += Math.min(keywordHits, 2);

  return Math.min(score, 10);
}
