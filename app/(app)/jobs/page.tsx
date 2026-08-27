import { and, eq, gte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { requireUser } from "@/src/auth/require";
import { getDb } from "@/src/db/client";
import { atsVendorEnum, companies, jobs, jobScores, workAuthSignalEnum } from "@/src/db/schema";
import type { AtsVendor, WorkAuthSignal } from "@/src/finders/types";
import { DEFAULT_MODEL_BY_STEP } from "@/src/llm/defaults";
import { fitRankerVersion, KEYWORD_RANKER_VERSION } from "@/src/rank/rank";
import { JobFilters, type JobFiltersValue } from "@/components/jobs/JobFilters";
import { JobList, type JobListItem } from "@/components/jobs/JobList";

/** Rows fetched per load. The live table has ~2k active+entry+relevant jobs total (Task 7's notes); this is a browsing cap, not a hard ceiling on ranking. */
const JOBS_PAGE_LIMIT = 200;

type RemoteFilter = "any" | "remote" | "onsite";

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

/**
 * `/jobs` — plan Task 8 Step 3: table sorted by fit score (fallback keyword
 * score), filters (min score, remote, work-auth, vendor), "Rank more".
 *
 * Restricted to `active ∧ is_entry_level ∧ is_relevant_role`, same as
 * `rankForUser`'s candidate pool (`src/rank/rank.ts`) — this page is "your
 * matches", not a firehose of all ~42k scraped postings (Task 7's notes).
 * Score is `COALESCE(fit-v1 score, keyword-v1 score)`: since the two scales
 * differ (0–100 vs 0–10), every fit-scored job naturally outranks every
 * keyword-only job, which is exactly "fit score, fallback keyword score".
 */
export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<{ minScore?: string; remote?: string; workAuth?: string; vendor?: string }>;
}) {
  const user = await requireUser();
  const sp = await searchParams;

  const filters: JobFiltersValue = {
    minScore: parseMinScore(sp.minScore),
    remote: parseRemote(sp.remote),
    workAuth: parseWorkAuth(sp.workAuth),
    vendor: parseVendor(sp.vendor),
  };

  const db = getDb();
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
    conditions.push(gte(sql`coalesce(${fitScores.score}, ${kwScores.score})`, filters.minScore));
  }

  const rows = await db
    .select({
      id: jobs.id,
      title: jobs.title,
      companyName: companies.name,
      location: jobs.location,
      remote: jobs.remote,
      workAuthSignal: jobs.workAuthSignal,
      postedAt: jobs.postedAt,
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
      sql`coalesce(${fitScores.score}, ${kwScores.score}) DESC NULLS LAST`,
      sql`${jobs.postedAt} DESC NULLS LAST`,
    )
    .limit(JOBS_PAGE_LIMIT);

  const items: JobListItem[] = rows.map((row) => ({
    id: row.id,
    title: row.title,
    companyName: row.companyName,
    location: row.location,
    remote: row.remote,
    workAuthSignal: row.workAuthSignal,
    postedAt: row.postedAt ? row.postedAt.toISOString() : null,
    score: row.fitScore ?? row.keywordScore ?? null,
    scoreKind: row.fitScore != null ? "fit" : row.keywordScore != null ? "keyword" : null,
  }));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Jobs</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Active, entry-level, relevant postings — sorted by your fit score, falling back to the
          free keyword baseline for anything not yet scored.
        </p>
      </div>

      <JobFilters value={filters} />
      <JobList jobs={items} />
    </div>
  );
}
