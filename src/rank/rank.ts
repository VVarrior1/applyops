/**
 * `rankForUser` — the LLM ranker (spec §5 "Ranker v0", §6 "per-user ranking
 * budget").
 *
 * For one user: pick jobs that are active, entry-level, a relevant role, and
 * match their `search_prefs` (via `isPreferredLocation`, Task 7) and that
 * this ranker hasn't already scored for them; run `analyze` on each (only
 * when `jobs.analysis` is still null — analysis is per-job and cached,
 * shared across every user, spec §6) then `fit`; write both a
 * `fit-v1:<model>` `job_scores` row (the real ranking) and a `keyword-v1`
 * row (the free baseline — see `src/rank/keyword.ts`) for every job visited.
 * Newest postings first (spec §6: "capped by daily_budget_usd... newest
 * first"), so a budget-limited run always spends on the freshest listings.
 *
 * Both calls draw on the given `userId`'s real daily budget (never `null` —
 * this always represents a specific person's ranking, whether triggered by
 * `applyops rank --user`/`--all` or the Jobs page's "Rank more" button), so
 * once `checkBudget` refuses a call, `rankForUser` stops entirely rather
 * than burning through the rest of the candidate list on calls that would
 * all fail the same way (`BudgetExceededError` breaks the loop; every other
 * per-job failure is caught, counted as `skipped`, and the run continues —
 * the same "one bad item never kills the batch" shape as `runFinders`).
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { companies, jobs, jobScores } from "../db/schema";
import { isPreferredLocation } from "../finders/filters";
import { BudgetExceededError } from "../llm/budget";
import { DEFAULT_MODEL_BY_STEP } from "../llm/defaults";
import type { ModelId } from "../llm/model-id";
import { runAnalyze, runFit } from "../pipeline/steps";
import type { AnalyzeOutput, Fact, FitOutput } from "../pipeline/schemas";
import { getConfirmedFacts, getPrefs, type SearchPrefsRow } from "../profile/facts";
import { candidateConditions } from "./candidates";
import { keywordScore } from "./keyword";

/** `job_scores.ranker_version` for the free, deterministic baseline. */
export const KEYWORD_RANKER_VERSION = "keyword-v1";

/** `job_scores.ranker_version` for the LLM ranker at a given model. */
export function fitRankerVersion(modelId: string): string {
  return `fit-v1:${modelId}`;
}

/** Default batch size for both the CLI (`--max`) and `/api/rank`. */
export const DEFAULT_MAX_JOBS = 50;

/**
 * Safety cap on how many active/entry-level/relevant/unscored rows are
 * pulled from Postgres before `isPreferredLocation` (a JS predicate, not
 * expressible as SQL over free-text locations) narrows them down to
 * `maxJobs`. Generous on purpose — the live table has ~2k rows passing the
 * entry-level+relevant filters in total (Task 7's notes), so this is rarely
 * the limiting factor.
 */
const CANDIDATE_POOL_LIMIT = 5000;

/** The job fields both candidate selection and single-job (re-)scoring need. */
export interface RankableJob {
  id: string;
  title: string;
  companyName: string | null;
  atsVendor: string | null;
  location: string | null;
  remote: boolean | null;
  description: string | null;
  analysis: AnalyzeOutput | null;
  postedAt: Date | null;
  scrapedAt: Date | null;
}

const JOB_SELECT_COLUMNS = {
  id: jobs.id,
  title: jobs.title,
  companyName: companies.name,
  atsVendor: companies.atsVendor,
  location: jobs.location,
  remote: jobs.remote,
  description: jobs.description,
  analysis: jobs.analysis,
  postedAt: jobs.postedAt,
  scrapedAt: jobs.scrapedAt,
} as const;

/** One job, for the Fit tab's "Score this job" / "Re-score" button. */
export async function loadJobForScoring(db: Db, jobId: string): Promise<RankableJob | null> {
  const [row] = await db
    .select(JOB_SELECT_COLUMNS)
    .from(jobs)
    .leftJoin(companies, eq(jobs.companyId, companies.id))
    .where(eq(jobs.id, jobId))
    .limit(1);
  return row ?? null;
}

/**
 * Just enough to run `isPreferredLocation` and order the pool — deliberately
 * excludes `description`/`analysis` (up to a few KB each) which
 * {@link CANDIDATE_POOL_LIMIT} rows of would otherwise pull ~6 MB over the
 * pooler on every rank invocation just to discard all but `maxJobs` of them.
 */
const CANDIDATE_ID_COLUMNS = {
  id: jobs.id,
  location: jobs.location,
  remote: jobs.remote,
} as const;

async function selectCandidateJobs(
  db: Db,
  userId: string,
  rankerVersion: string,
  prefs: SearchPrefsRow | null,
  maxJobs: number,
): Promise<RankableJob[]> {
  const idRows = await db
    .select(CANDIDATE_ID_COLUMNS)
    .from(jobs)
    .leftJoin(
      jobScores,
      and(
        eq(jobScores.jobId, jobs.id),
        eq(jobScores.userId, userId),
        eq(jobScores.rankerVersion, rankerVersion),
      ),
    )
    .where(
      and(
        eq(jobs.active, true),
        eq(jobs.isEntryLevel, true),
        eq(jobs.isRelevantRole, true),
        isNull(jobScores.id),
        ...candidateConditions(prefs),
      ),
    )
    // Newest first (spec §6); NULLS LAST because a chunk of postings carry
    // no posted_at at all (Task 7's notes) and Postgres defaults NULLs to
    // sort first in a DESC order, which would spend budget on exactly the
    // jobs least likely to still be open.
    .orderBy(sql`${jobs.postedAt} DESC NULLS LAST`)
    .limit(CANDIDATE_POOL_LIMIT);

  const prefsArg = prefs ? { locations: prefs.locations ?? [], remote: prefs.remote ?? "any" } : undefined;
  const ids = idRows
    .filter((row) => isPreferredLocation(row.location, row.remote ?? false, prefsArg))
    .slice(0, maxJobs)
    .map((row) => row.id);
  if (ids.length === 0) return [];

  // Second pass: fetch the full columns (description, cached analysis) only
  // for the ≤maxJobs ids that survived the filter — never for the pool.
  const fullRows = await db
    .select(JOB_SELECT_COLUMNS)
    .from(jobs)
    .leftJoin(companies, eq(jobs.companyId, companies.id))
    .where(inArray(jobs.id, ids));

  const byId = new Map(fullRows.map((row) => [row.id, row]));
  // Re-order to the id list, not the DB's return order, to keep "newest
  // first" — `inArray` gives no ordering guarantee of its own.
  const ordered: RankableJob[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (row) ordered.push(row);
  }
  return ordered;
}

interface UpsertJobScoreInput {
  jobId: string;
  userId: string;
  rankerVersion: string;
  score: number;
  matched?: FitOutput["matched"] | null;
  gaps?: FitOutput["gaps"] | null;
  rationale?: string | null;
  generationId?: string | null;
}

/** `job_scores` is `UNIQUE(job_id, user_id, ranker_version)` — this is always a re-score, never a duplicate. */
async function upsertJobScore(db: Db, input: UpsertJobScoreInput): Promise<void> {
  const values = {
    jobId: input.jobId,
    userId: input.userId,
    rankerVersion: input.rankerVersion,
    score: input.score,
    matched: input.matched ?? null,
    gaps: input.gaps ?? null,
    rationale: input.rationale ?? null,
    generationId: input.generationId ?? null,
  };
  await db
    .insert(jobScores)
    .values(values)
    .onConflictDoUpdate({
      target: [jobScores.jobId, jobScores.userId, jobScores.rankerVersion],
      set: {
        score: values.score,
        matched: values.matched,
        gaps: values.gaps,
        rationale: values.rationale,
        generationId: values.generationId,
        createdAt: new Date(),
      },
    });
}

function toFitPrefs(prefs: SearchPrefsRow | null) {
  if (!prefs) return null;
  return {
    roles: prefs.roles,
    locations: prefs.locations,
    remote: prefs.remote,
    seniority: prefs.seniority,
    workAuth: prefs.workAuth,
    keywords: prefs.keywords,
    excludedCompanies: prefs.excludedCompanies,
  };
}

export interface EnsureAnalysisResult {
  analysis: AnalyzeOutput;
  /** `null` when `jobs.analysis` was already cached — no generation ran. */
  generationId: string | null;
  costUsd: number;
}

/**
 * Populates `jobs.analysis` if it isn't already (spec §5/§6: analysis is
 * per-job, cached, and shared across every user — a cache hit costs nothing
 * and runs no generation). Backs `POST /api/jobs/[id]/analyze`, which the
 * Posting and Fit tabs both call before anything that needs an analyzed
 * posting (`fit`, and — once cached — Task 9's `tailor`/`suggest`, which
 * 409 instead of running this themselves).
 */
export async function ensureAnalysis(
  db: Db,
  userId: string,
  job: Pick<RankableJob, "id" | "title" | "companyName" | "description" | "location" | "remote" | "analysis">,
): Promise<EnsureAnalysisResult> {
  if (job.analysis) {
    return { analysis: job.analysis, generationId: null, costUsd: 0 };
  }

  const analyzed = await runAnalyze(db, {
    job: {
      title: job.title,
      company: job.companyName ?? "Unknown company",
      description: job.description ?? "",
      location: job.location,
      remote: job.remote,
    },
    userId,
    jobId: job.id,
  });
  await db
    .update(jobs)
    .set({ analysis: analyzed.output, analysisGenerationId: analyzed.generationId })
    .where(eq(jobs.id, job.id));

  return { analysis: analyzed.output, generationId: analyzed.generationId, costUsd: analyzed.costUsd };
}

export interface ScoreFitOptions {
  /** Pre-fetched to avoid refetching per job in a batch; falls back to a DB read. */
  facts?: Fact[];
  /** `undefined` = fetch it; explicit `null` = "no prefs on file", skip the read. */
  prefs?: SearchPrefsRow | null;
  modelId?: ModelId;
}

export interface ScoreFitResult {
  output: FitOutput;
  generationId: string;
  costUsd: number;
}

/**
 * Score exactly one already-analyzed job for one user: run `fit`, then
 * (re)write both the `fit-v1:<model>` and the free `keyword-v1` `job_scores`
 * rows. Requires `analysis` (call {@link ensureAnalysis} first — that's a
 * genuinely separate step, not folded in here, because `POST
 * /api/jobs/[id]/fit` mirrors Task 9's `/tailor`/`/suggest` contract: 409 if
 * the job hasn't been analyzed, rather than silently spending on analysis
 * from inside what looks like a "just fit" call).
 *
 * Always runs — no "already scored" check — which is what makes it correct
 * both as `rankForUser`'s per-candidate worker and as the Fit tab's "Score
 * this job" / "Re-score" action.
 */
export async function scoreFit(
  db: Db,
  userId: string,
  job: Pick<RankableJob, "id" | "title" | "companyName" | "atsVendor" | "location" | "remote" | "description" | "postedAt" | "scrapedAt">,
  analysis: AnalyzeOutput,
  opts: ScoreFitOptions = {},
): Promise<ScoreFitResult> {
  const modelId = opts.modelId ?? DEFAULT_MODEL_BY_STEP.fit;

  // Free and instant — refreshed regardless of whether the fit call below
  // succeeds, so a job keeps a fallback score even on a failed/expensive fit.
  await upsertJobScore(db, {
    jobId: job.id,
    userId,
    rankerVersion: KEYWORD_RANKER_VERSION,
    score: keywordScore({
      title: job.title,
      location: job.location,
      remote: job.remote,
      description: job.description,
      postedAt: job.postedAt,
      scrapedAt: job.scrapedAt,
      atsVendor: job.atsVendor,
    }),
  });

  const facts = opts.facts ?? (await getConfirmedFacts(db, userId));
  const prefsRow = opts.prefs === undefined ? await getPrefs(db, userId) : opts.prefs;

  const fitResult = await runFit(db, {
    analysis,
    facts,
    prefs: toFitPrefs(prefsRow),
    job: { title: job.title, company: job.companyName, location: job.location, remote: job.remote },
    userId,
    jobId: job.id,
    modelId,
  });

  await upsertJobScore(db, {
    jobId: job.id,
    userId,
    rankerVersion: fitRankerVersion(modelId),
    score: fitResult.output.score,
    matched: fitResult.output.matched,
    gaps: fitResult.output.gaps,
    rationale: fitResult.output.rationale,
    generationId: fitResult.generationId,
  });

  return { output: fitResult.output, generationId: fitResult.generationId, costUsd: fitResult.costUsd };
}

export interface RankForUserOptions {
  /** Defaults to {@link DEFAULT_MAX_JOBS}. */
  maxJobs?: number;
  /**
   * Called once per per-job failure that isn't a {@link BudgetExceededError}
   * (which stops the loop instead) — same shape as `runFinders`' `ctx.log`.
   * Without this the CLI/route only ever see the aggregate `skipped` count,
   * with no way to tell a systemic failure (provider down, schema rejection,
   * DB error) from a handful of genuinely bad postings.
   */
  log?: (line: string) => void;
}

export interface RankForUserResult {
  scored: number;
  skipped: number;
  costUsd: number;
}

/**
 * Batch entry point (spec §5/§6): scores up to `maxJobs` unranked candidate
 * jobs for `userId`, stopping early if their daily AI budget runs out.
 * Called by `applyops rank` and `POST /api/rank`.
 */
export async function rankForUser(
  db: Db,
  userId: string,
  opts: RankForUserOptions = {},
): Promise<RankForUserResult> {
  const maxJobs =
    opts.maxJobs !== undefined && opts.maxJobs > 0 ? Math.floor(opts.maxJobs) : DEFAULT_MAX_JOBS;
  const modelId = DEFAULT_MODEL_BY_STEP.fit;
  const rankerVersion = fitRankerVersion(modelId);

  const [prefs, facts] = await Promise.all([getPrefs(db, userId), getConfirmedFacts(db, userId)]);
  const candidates = await selectCandidateJobs(db, userId, rankerVersion, prefs, maxJobs);

  let scored = 0;
  let skipped = 0;
  let costUsd = 0;

  for (const job of candidates) {
    try {
      const ensured = await ensureAnalysis(db, userId, job);
      costUsd += ensured.costUsd;

      const fitResult = await scoreFit(db, userId, job, ensured.analysis, { facts, prefs, modelId });
      costUsd += fitResult.costUsd;

      scored++;
    } catch (err) {
      if (err instanceof BudgetExceededError) break;
      skipped++;
      opts.log?.(`${job.id} ${job.title}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { scored, skipped, costUsd };
}
