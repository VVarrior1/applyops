/**
 * The golden set (spec §7): 40 frozen `eval_items` the eval harness re-runs
 * every time a prompt or a model changes.
 *
 * Two things make a golden set worth having, and both live here:
 *
 *   1. **Diversity.** 40 postings drawn at random from one scrape are 40
 *      variations of the same job. {@link selectGoldenItems} round-robins over
 *      (ATS vendor × remote × work-auth signal × title family) so a model that
 *      only handles remote backend postings cannot hide behind a good mean.
 *   2. **Freezing.** Each item stores `profile_snapshot` — the user's confirmed
 *      facts at selection time. Editing your profile next week must not
 *      silently change what last week's baseline run measured.
 *
 * Items are also the unit the grading UI works through, so this module owns
 * the cached sample generation each item is graded against
 * ({@link ensureSampleGeneration}).
 */

import { and, desc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  companies,
  evalItems,
  generations,
  jobs,
  type Step,
} from "../db/schema";
import type { ModelId } from "../llm/model-id";
import { runAnalyze, runTailor } from "../pipeline/steps";
import type { AnalyzeOutput, Fact, TailorOutput } from "../pipeline/schemas";
import { getConfirmedFacts } from "../profile/facts";

/**
 * A posting shorter than this is a title and a link, not something a tailoring
 * model can be graded on. Such rows are not excluded outright — the seeded v1
 * corpus is mostly title-only, and a golden set of 12 items has its own
 * problems — but they are only used to top the set up after every substantive
 * posting has been taken. See `tier` in {@link candidateTier}.
 */
export const GOLDEN_MIN_DESCRIPTION_CHARS = 400;

/** One job considered for the golden set, with its diversity dimensions. */
export interface GoldenCandidate {
  jobId: string;
  title: string;
  vendor: string;
  remote: boolean | null;
  workAuthSignal: string | null;
  descriptionLength: number;
}

/**
 * Coarse role family derived from the title — the fourth diversity dimension.
 *
 * Deliberately keyword-based rather than a model call: this runs over every
 * job in the database, must be deterministic (the same corpus must produce the
 * same golden set), and only needs to be right enough to stop the set filling
 * up with eight variations of "Software Engineer, Backend".
 *
 * Ordered most-specific-first: "Machine Learning Engineer" is ML, not backend.
 */
export function titleFamily(rawTitle: string): string {
  const t = ` ${(rawTitle ?? "").toLowerCase().replace(/[^a-z0-9+#]+/g, " ")} `;
  const has = (...needles: string[]) => needles.some((n) => t.includes(` ${n} `));
  const contains = (...needles: string[]) => needles.some((n) => t.includes(n));

  if (contains("machine learning", "deep learning", " ml ", " ai ", "nlp", "computer vision"))
    return "ml-ai";
  if (contains("data scien", "research scientist", "quantitative")) return "data-science";
  if (contains("data engineer", "analytics engineer", "etl", "data platform"))
    return "data-engineering";
  if (contains("data analyst", "business analyst", "bi analyst", "analytics")) return "analyst";
  if (contains("devops", "site reliability", " sre", "platform engineer", "infrastructure", "cloud engineer"))
    return "devops-infra";
  if (contains("security", "appsec", "infosec", "penetration")) return "security";
  if (contains("qa ", "quality assurance", " test engineer", "sdet", "automation engineer"))
    return "qa";
  if (contains("ios", "android", "mobile", "react native", "flutter")) return "mobile";
  if (contains("front end", "frontend", "front-end", "ui engineer", "web developer"))
    return "frontend";
  if (contains("back end", "backend", "back-end", "server", "api engineer")) return "backend";
  if (contains("full stack", "fullstack", "full-stack")) return "fullstack";
  if (contains("embedded", "firmware", "hardware")) return "embedded";
  if (contains("product manager", "product owner", "program manager")) return "product";
  if (contains("designer", "ux", "ui/ux")) return "design";
  if (contains("writer", "content", "editor", "journalis")) return "writing";
  if (contains("support", "success", "operations", "concierge", "associate", "coordinator", "admin"))
    return "support-ops";
  if (contains("software", "developer", "engineer", "programmer")) return "software-general";
  if (has("intern", "internship") || contains("co-op", "student")) return "student";
  return "other";
}

/**
 * The bucket a candidate round-robins in: the four diversity dimensions from
 * spec §7. Nulls collapse to a named bucket rather than disappearing — an
 * un-analyzed posting (`work_auth_signal` null) is its own kind of item and
 * should still be spread across the set.
 */
export function diversityKey(candidate: GoldenCandidate): string {
  const remote =
    candidate.remote === null ? "remote:unknown" : `remote:${candidate.remote}`;
  return [
    `vendor:${candidate.vendor || "other"}`,
    remote,
    `auth:${candidate.workAuthSignal ?? "unclear"}`,
    `family:${titleFamily(candidate.title)}`,
  ].join(" | ");
}

/** 0 = a substantive posting, 1 = a title-only stub used only to top up. */
export function candidateTier(candidate: GoldenCandidate, minChars: number): 0 | 1 {
  return candidate.descriptionLength >= minChars ? 0 : 1;
}

/**
 * Take up to `n` items, one from each bucket in turn, so the set is as spread
 * across buckets as the corpus allows. Buckets are visited largest-first (a
 * bucket holding half the corpus should not be starved by a bucket of one),
 * and within a bucket the richest posting goes first.
 *
 * Exported for its own unit test — the DB half of `selectGoldenItems` is not
 * worth mocking, this part is.
 */
export function roundRobinByBucket<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  n: number,
  rank?: (a: T, b: T) => number,
): T[] {
  if (n <= 0) return [];

  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }

  const ordered = [...buckets.entries()]
    .map(([key, bucket]) => ({
      key,
      bucket: rank ? [...bucket].sort(rank) : bucket,
    }))
    // Largest bucket first, ties broken by key so the result is deterministic.
    .sort((a, b) => b.bucket.length - a.bucket.length || a.key.localeCompare(b.key));

  const picked: T[] = [];
  for (let round = 0; picked.length < n; round++) {
    let tookAny = false;
    for (const { bucket } of ordered) {
      if (round >= bucket.length) continue;
      picked.push(bucket[round]);
      tookAny = true;
      if (picked.length >= n) break;
    }
    if (!tookAny) break; // every bucket exhausted
  }
  return picked;
}

/**
 * Choose `n` candidates: every substantive posting first (round-robined over
 * the diversity buckets), then title-only stubs to top up if the corpus cannot
 * fill the set. Pure, so the selection policy is testable without a database.
 */
export function chooseCandidates(
  candidates: readonly GoldenCandidate[],
  n: number,
  minChars: number = GOLDEN_MIN_DESCRIPTION_CHARS,
): GoldenCandidate[] {
  const richest = (a: GoldenCandidate, b: GoldenCandidate) =>
    b.descriptionLength - a.descriptionLength || a.jobId.localeCompare(b.jobId);

  const rich = candidates.filter((c) => candidateTier(c, minChars) === 0);
  const thin = candidates.filter((c) => candidateTier(c, minChars) === 1);

  const picked = roundRobinByBucket(rich, diversityKey, n, richest);
  if (picked.length < n) {
    picked.push(...roundRobinByBucket(thin, diversityKey, n - picked.length, richest));
  }
  return picked;
}

export interface SelectGoldenArgs {
  /** Target size of the golden set for this step (spec §7: 40). */
  n: number;
  step: Step;
  /** Whose confirmed facts get frozen into every new item. */
  userId: string;
  /** Override the substantive-posting threshold. */
  minDescriptionChars?: number;
}

/**
 * Top the golden set for `step` up to `n` items and return the ids of the
 * items this call created.
 *
 * Re-runnable: jobs already in the set for this step are skipped, so running
 * it again after a fresh scrape adds only what is missing. Existing items are
 * never re-snapshotted — freezing means freezing.
 */
export async function selectGoldenItems(
  db: Db,
  { n, step, userId, minDescriptionChars }: SelectGoldenArgs,
): Promise<string[]> {
  const existing = await db
    .select({ jobId: evalItems.jobId })
    .from(evalItems)
    .where(eq(evalItems.step, step));

  const alreadyIn = new Set(existing.map((row) => row.jobId).filter(Boolean) as string[]);
  const missing = n - existing.length;
  if (missing <= 0) return [];

  const facts = await getConfirmedFacts(db, userId);
  if (facts.length === 0) {
    throw new Error(
      `User ${userId} has no confirmed facts — a golden set frozen against an empty profile grades nothing.`,
    );
  }

  const rows = await db
    .select({
      jobId: jobs.id,
      title: jobs.title,
      vendor: companies.atsVendor,
      remote: jobs.remote,
      workAuthSignal: jobs.workAuthSignal,
      descriptionLength: sql<number>`coalesce(length(${jobs.description}), 0)`,
    })
    .from(jobs)
    .leftJoin(companies, eq(companies.id, jobs.companyId))
    .where(isNotNull(jobs.description));

  const candidates: GoldenCandidate[] = rows
    .filter((row) => !alreadyIn.has(row.jobId))
    .map((row) => ({
      jobId: row.jobId,
      title: row.title,
      vendor: row.vendor ?? "other",
      remote: row.remote,
      workAuthSignal: row.workAuthSignal,
      descriptionLength: Number(row.descriptionLength),
    }));

  const chosen = chooseCandidates(candidates, missing, minDescriptionChars);
  if (chosen.length === 0) return [];

  const inserted = await db
    .insert(evalItems)
    .values(
      chosen.map((candidate) => ({
        jobId: candidate.jobId,
        step,
        profileSnapshot: facts,
      })),
    )
    .returning({ id: evalItems.id });

  return inserted.map((row) => row.id);
}

export interface GoldenSetSummary {
  step: Step;
  total: number;
  graded: number;
  withSample: number;
  substantive: number;
  byVendor: Record<string, number>;
  byRemote: Record<string, number>;
  byWorkAuth: Record<string, number>;
  byTitleFamily: Record<string, number>;
}

function tally(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return Object.fromEntries(
    Object.entries(out).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  );
}

/** What `golden select` prints after selecting: the set's actual spread. */
export async function goldenSetSummary(db: Db, step: Step): Promise<GoldenSetSummary> {
  const rows = await db
    .select({
      itemId: evalItems.id,
      graded: sql<boolean>`${evalItems.humanGrades} is not null`,
      hasSample: sql<boolean>`${evalItems.sampleGenerationId} is not null`,
      title: jobs.title,
      vendor: companies.atsVendor,
      remote: jobs.remote,
      workAuthSignal: jobs.workAuthSignal,
      descriptionLength: sql<number>`coalesce(length(${jobs.description}), 0)`,
    })
    .from(evalItems)
    .leftJoin(jobs, eq(jobs.id, evalItems.jobId))
    .leftJoin(companies, eq(companies.id, jobs.companyId))
    .where(eq(evalItems.step, step));

  return {
    step,
    total: rows.length,
    graded: rows.filter((r) => r.graded).length,
    withSample: rows.filter((r) => r.hasSample).length,
    substantive: rows.filter(
      (r) => Number(r.descriptionLength) >= GOLDEN_MIN_DESCRIPTION_CHARS,
    ).length,
    byVendor: tally(rows.map((r) => r.vendor ?? "other")),
    byRemote: tally(rows.map((r) => (r.remote === null ? "unknown" : String(r.remote)))),
    byWorkAuth: tally(rows.map((r) => r.workAuthSignal ?? "unclear")),
    byTitleFamily: tally(rows.map((r) => titleFamily(r.title ?? ""))),
  };
}

// ---------------------------------------------------------------------------
// Item loading + the cached sample the grading UI grades
// ---------------------------------------------------------------------------

export interface GoldenItem {
  itemId: string;
  step: Step;
  jobId: string | null;
  title: string;
  company: string;
  location: string | null;
  remote: boolean | null;
  description: string;
  analysis: AnalyzeOutput | null;
  facts: Fact[];
  sampleGenerationId: string | null;
  humanGrades: typeof evalItems.$inferSelect.humanGrades;
  notes: string | null;
}

const goldenItemColumns = {
  itemId: evalItems.id,
  step: evalItems.step,
  jobId: evalItems.jobId,
  profileSnapshot: evalItems.profileSnapshot,
  sampleGenerationId: evalItems.sampleGenerationId,
  humanGrades: evalItems.humanGrades,
  notes: evalItems.notes,
  title: jobs.title,
  company: companies.name,
  location: jobs.location,
  remote: jobs.remote,
  description: jobs.description,
  analysis: jobs.analysis,
};

function toGoldenItem(row: {
  itemId: string;
  step: Step;
  jobId: string | null;
  profileSnapshot: Fact[] | null;
  sampleGenerationId: string | null;
  humanGrades: typeof evalItems.$inferSelect.humanGrades;
  notes: string | null;
  title: string | null;
  company: string | null;
  location: string | null;
  remote: boolean | null;
  description: string | null;
  analysis: AnalyzeOutput | null;
}): GoldenItem {
  return {
    itemId: row.itemId,
    step: row.step,
    jobId: row.jobId,
    title: row.title ?? "(untitled posting)",
    company: row.company ?? "Unknown company",
    location: row.location,
    remote: row.remote,
    description: row.description ?? "",
    analysis: row.analysis,
    facts: row.profileSnapshot ?? [],
    sampleGenerationId: row.sampleGenerationId,
    humanGrades: row.humanGrades,
    notes: row.notes,
  };
}

export interface LoadGoldenItemsArgs {
  step: Step;
  itemIds?: string[];
  limit?: number;
}

/** Load the golden set (or a named subset) with everything a run needs. */
export async function loadGoldenItems(
  db: Db,
  { step, itemIds, limit }: LoadGoldenItemsArgs,
): Promise<GoldenItem[]> {
  const where =
    itemIds && itemIds.length > 0
      ? and(eq(evalItems.step, step), inArray(evalItems.id, itemIds))
      : eq(evalItems.step, step);

  const query = db
    .select(goldenItemColumns)
    .from(evalItems)
    .leftJoin(jobs, eq(jobs.id, evalItems.jobId))
    .leftJoin(companies, eq(companies.id, jobs.companyId))
    .where(where)
    // Deterministic order so `--items 5` means the same five items every run.
    .orderBy(evalItems.id);

  const rows = await (limit && limit > 0 ? query.limit(limit) : query);
  return rows.map(toGoldenItem);
}

export async function loadGoldenItem(
  db: Db,
  itemId: string,
): Promise<GoldenItem | null> {
  const [row] = await db
    .select(goldenItemColumns)
    .from(evalItems)
    .leftJoin(jobs, eq(jobs.id, evalItems.jobId))
    .leftJoin(companies, eq(companies.id, jobs.companyId))
    .where(eq(evalItems.id, itemId))
    .limit(1);
  return row ? toGoldenItem(row) : null;
}

/**
 * The next item with no `human_grades`, in the set's stable order.
 *
 * `after` is how the grading UI's "skip" works: take the next ungraded item
 * *past* this one, wrapping back to the start when there is nothing past it,
 * so skipping never strands the owner on the last item.
 */
export async function nextUngradedItem(
  db: Db,
  step: Step,
  after?: string,
): Promise<GoldenItem | null> {
  const ungraded = and(eq(evalItems.step, step), sql`${evalItems.humanGrades} is null`);

  const query = (extra?: ReturnType<typeof and>) =>
    db
      .select(goldenItemColumns)
      .from(evalItems)
      .leftJoin(jobs, eq(jobs.id, evalItems.jobId))
      .leftJoin(companies, eq(companies.id, jobs.companyId))
      .where(extra ? and(ungraded, extra) : ungraded)
      .orderBy(evalItems.id)
      .limit(1);

  if (after) {
    const [next] = await query(and(gt(evalItems.id, after)));
    if (next) return toGoldenItem(next);
  }

  const [row] = await query();
  return row ? toGoldenItem(row) : null;
}

export interface EnsureAnalysisArgs {
  userId?: string | null;
  modelId?: ModelId;
}

/**
 * `tailor` needs an `analyze` output, and most seeded jobs have never been
 * analyzed. Analyze once, cache it on the job row (which is exactly what the
 * ranking pipeline does — spec §6), and hand back the cost so the eval run can
 * account for it honestly.
 */
export async function ensureAnalysis(
  db: Db,
  item: GoldenItem,
  { userId = null, modelId }: EnsureAnalysisArgs = {},
): Promise<{ analysis: AnalyzeOutput; costUsd: number; cached: boolean }> {
  if (item.analysis) return { analysis: item.analysis, costUsd: 0, cached: true };

  const result = await runAnalyze(db, {
    job: {
      title: item.title,
      company: item.company,
      description: item.description,
      location: item.location,
      remote: item.remote,
    },
    jobId: item.jobId ?? undefined,
    userId,
    modelId,
  });

  if (item.jobId) {
    await db
      .update(jobs)
      .set({ analysis: result.output, analysisGenerationId: result.generationId })
      .where(eq(jobs.id, item.jobId));
  }
  item.analysis = result.output;

  return { analysis: result.output, costUsd: result.costUsd, cached: false };
}

export interface SampleGeneration {
  generationId: string;
  output: TailorOutput;
  modelId: string;
  costUsd: number;
  latencyMs: number | null;
  createdAt: string;
  generated: boolean;
}

/**
 * The tailored resume an item is graded against, generated once with the
 * current default model and cached on `eval_items.sample_generation_id`.
 *
 * Caching is the point: a human grade only means something next to the exact
 * output the human saw, and the judge-vs-human kappa compares grades of the
 * same artifact. Re-generating on every page view would make both meaningless.
 */
export async function loadCachedSample(
  db: Db,
  item: GoldenItem,
): Promise<SampleGeneration | null> {
  if (!item.sampleGenerationId) return null;

  const [row] = await db
    .select({
      id: generations.id,
      output: generations.output,
      modelId: generations.modelId,
      costUsd: generations.costUsd,
      latencyMs: generations.latencyMs,
      createdAt: generations.createdAt,
    })
    .from(generations)
    .where(eq(generations.id, item.sampleGenerationId))
    .limit(1);

  // A generation row with no `output` is a failed call (src/llm/call.ts records
  // those with an `error`); treat it as no sample rather than as a cached one.
  if (!row?.output) return null;

  return {
    generationId: row.id,
    output: row.output as TailorOutput,
    modelId: row.modelId,
    costUsd: Number(row.costUsd ?? 0),
    latencyMs: row.latencyMs,
    createdAt: row.createdAt.toISOString(),
    generated: false,
  };
}

export async function ensureSampleGeneration(
  db: Db,
  item: GoldenItem,
  { userId = null, modelId }: EnsureAnalysisArgs = {},
): Promise<SampleGeneration> {
  const cached = await loadCachedSample(db, item);
  if (cached) return cached;

  const { analysis } = await ensureAnalysis(db, item, { userId });
  const result = await runTailor(db, {
    analysis,
    facts: item.facts,
    jobId: item.jobId ?? undefined,
    userId,
    modelId,
  });

  await db
    .update(evalItems)
    .set({ sampleGenerationId: result.generationId })
    .where(eq(evalItems.id, item.itemId));
  item.sampleGenerationId = result.generationId;

  const [row] = await db
    .select({ modelId: generations.modelId, createdAt: generations.createdAt })
    .from(generations)
    .where(eq(generations.id, result.generationId))
    .limit(1);

  return {
    generationId: result.generationId,
    output: result.output,
    modelId: row?.modelId ?? "unknown",
    costUsd: result.costUsd,
    latencyMs: result.latencyMs,
    createdAt: (row?.createdAt ?? new Date()).toISOString(),
    generated: true,
  };
}

/** Progress for the grading UI: "12/40 graded". */
export async function gradingProgress(
  db: Db,
  step: Step,
): Promise<{ graded: number; total: number }> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)`,
      graded: sql<number>`count(*) filter (where ${evalItems.humanGrades} is not null)`,
    })
    .from(evalItems)
    .where(eq(evalItems.step, step));

  return { graded: Number(row?.graded ?? 0), total: Number(row?.total ?? 0) };
}

export interface HumanGrades {
  grounding: number;
  coverage: number;
  specificity: number;
  stuffing_penalty: number;
}

/** Write one human grading into `eval_items.human_grades` (spec §7). */
export async function saveHumanGrades(
  db: Db,
  args: { itemId: string; grades: HumanGrades; grader: string; notes?: string | null },
): Promise<void> {
  await db
    .update(evalItems)
    .set({
      humanGrades: {
        ...args.grades,
        grader: args.grader,
        graded_at: new Date().toISOString(),
      },
      ...(args.notes === undefined ? {} : { notes: args.notes }),
    })
    .where(eq(evalItems.id, args.itemId));
}

/** Most recent items graded — shown as context in the grading UI. */
export async function recentlyGraded(db: Db, step: Step, limit = 5) {
  return db
    .select({ itemId: evalItems.id, humanGrades: evalItems.humanGrades, title: jobs.title })
    .from(evalItems)
    .leftJoin(jobs, eq(jobs.id, evalItems.jobId))
    .where(and(eq(evalItems.step, step), isNotNull(evalItems.humanGrades)))
    .orderBy(desc(evalItems.id))
    .limit(limit);
}
