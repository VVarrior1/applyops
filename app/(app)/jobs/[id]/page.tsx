import { notFound } from "next/navigation";
import { and, eq, inArray, isNotNull, isNull, like, or } from "drizzle-orm";
import { format } from "date-fns";
import { requireUser } from "@/src/auth/require";
import { getDb } from "@/src/db/client";
import { applications, companies, generations, jobs, jobScores } from "@/src/db/schema";
import { DEFAULT_MODEL_BY_STEP } from "@/src/llm/defaults";
import { checkCitations } from "@/src/pipeline/hallucination";
import { latestGenerationByStep } from "@/src/pipeline/generations";
import { SuggestOutput, TailorOutput, type FitOutput } from "@/src/pipeline/schemas";
import { factLabels } from "@/src/pipeline/steps";
import { getConfirmedFacts, getPrefs, type SearchPrefsRow } from "@/src/profile/facts";
import { countsAsApplied } from "@/src/rank/candidates";
import { fitRankerVersion, KEYWORD_RANKER_VERSION, pickFitScoreRow } from "@/src/rank/rank";
import { assessJob, type VerdictInput } from "@/src/rank/verdict";
import { isJobDetailTab } from "@/components/jobs/job-detail-tab";
import { JobDetailTabs } from "@/components/jobs/JobDetailTabs";
import type { SuggestInitialGeneration } from "@/components/jobs/SuggestionsTab";
import type { TailorInitialGeneration } from "@/components/jobs/TailorTab";
import { VerdictBadge } from "@/components/jobs/VerdictBadge";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Job",
};

type VerdictPrefs = NonNullable<VerdictInput["prefs"]>;

/** `search_prefs` (untyped `text` columns) → `assessJob`'s narrow prefs union — same shape/rationale as `app/(app)/jobs/page.tsx`'s `toVerdictPrefs`. */
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
 * `/jobs/[id]` — plan Task 8 Step 3: tabs Posting · Fit · Tailor ·
 * Suggestions (spec §9's "Apply" step is the "Mark as applied" button
 * inside Task 9's Tailor tab, not a separate tab component — see that
 * task's notes on this file).
 *
 * Deliberately does *not* run `analyze` itself — this is a GET render, and
 * a paid LLM call plus a DB write has no business happening on a plain page
 * load: a `next/link` prefetch from `/jobs`, a refresh, or a crawler could
 * all spend the viewing user's daily budget without them clicking anything.
 * `initialAnalyzed` just reflects whatever `jobs.analysis` already is. The
 * Fit tab (`FitTab`) is what actually runs `analyze` (via
 * `POST /api/jobs/[id]/analyze`) then `fit`, from its own explicit "Score
 * this job" button — Task 9's Tailor/Suggestions tabs should call the same
 * `/analyze` route themselves rather than rely on a side effect here.
 */
export default async function JobDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const user = await requireUser();
  const { id: jobId } = await params;
  const sp = await searchParams;
  const initialTab = isJobDetailTab(sp.tab) ? sp.tab : "posting";
  const db = getDb();

  const [jobRow] = await db
    .select({
      id: jobs.id,
      title: jobs.title,
      companyName: companies.name,
      location: jobs.location,
      remote: jobs.remote,
      description: jobs.description,
      url: jobs.url,
      analysis: jobs.analysis,
      postedAt: jobs.postedAt,
      scrapedAt: jobs.scrapedAt,
      lastSeenAt: jobs.lastSeenAt,
      active: jobs.active,
      isEntryLevel: jobs.isEntryLevel,
      isRelevantRole: jobs.isRelevantRole,
      workAuthSignal: jobs.workAuthSignal,
      countries: jobs.countries,
    })
    .from(jobs)
    .leftJoin(companies, eq(jobs.companyId, companies.id))
    .where(eq(jobs.id, jobId))
    .limit(1);

  if (!jobRow) {
    notFound();
  }

  const analysis = jobRow.analysis;

  const fitVersion = fitRankerVersion(DEFAULT_MODEL_BY_STEP.fit);
  const [scoreRows, prefs, appliedRows, genRows, facts] = await Promise.all([
    // Every fit-ranker version this job+user has ever been scored under,
    // not just the current one — a stale-model row still needs to be
    // visible so `pickFitScoreRow` below can fall back to it instead of
    // the page acting like the job was never scored. `like('fit-v1:%')`
    // catches every model that's ever been the fit default; the exact
    // `KEYWORD_RANKER_VERSION` match is unaffected.
    db
      .select({
        rankerVersion: jobScores.rankerVersion,
        score: jobScores.score,
        matched: jobScores.matched,
        gaps: jobScores.gaps,
        rationale: jobScores.rationale,
        createdAt: jobScores.createdAt,
      })
      .from(jobScores)
      .where(
        and(
          eq(jobScores.jobId, jobRow.id),
          eq(jobScores.userId, user.id),
          or(like(jobScores.rankerVersion, "fit-v1:%"), eq(jobScores.rankerVersion, KEYWORD_RANKER_VERSION)),
        ),
      ),
    getPrefs(db, user.id),
    // No `.limit(1)`: a user can withdraw and later re-apply, leaving more
    // than one applications row for the same job — every one has to be
    // checked against countsAsApplied, not just whichever comes back first.
    db
      .select({ id: applications.id, status: applications.status })
      .from(applications)
      .where(and(eq(applications.userId, user.id), eq(applications.jobId, jobRow.id))),
    // Every `tailor`/`suggest` generation for this job+user — reduced to
    // "the latest one per step" below by `latestGenerationByStep` (spec:
    // "tailor and suggest from the generations table (step + jobId +
    // userId, newest)"). `generations` keeps full history, so this is a
    // handful of rows per job at most, not an unbounded scan.
    db
      .select({
        id: generations.id,
        step: generations.step,
        output: generations.output,
        userEdits: generations.userEdits,
        createdAt: generations.createdAt,
      })
      .from(generations)
      .where(
        and(
          eq(generations.jobId, jobRow.id),
          eq(generations.userId, user.id),
          inArray(generations.step, ["tailor", "suggest"]),
          // A terminal LLM failure is stored as its own generations row
          // (output: null, error: <message>) so it never wins over an
          // older, actually-usable result just because it's newer — see
          // `src/pipeline/generations.ts`.
          isNull(generations.error),
          isNotNull(generations.output),
        ),
      ),
    // Needed to re-derive each generation's hallucination report against
    // the user's *current* confirmed facts (never stored — see
    // `TailorInitialGeneration`'s doc comment), the same way `runTailor`/
    // `runSuggest` compute it fresh on generation.
    getConfirmedFacts(db, user.id),
  ]);

  // Prefer a row scored under the current fit default; fall back to the
  // newest row under an older `fit-v1:<model>` version rather than
  // treating a job scored before the default last changed as unscored
  // (see `pickFitScoreRow`'s doc comment — this is the fix for the real
  // 6903598 fit-default change stranding rows).
  const pickedFit = pickFitScoreRow(scoreRows, fitVersion);
  const fitRow = pickedFit?.row ?? null;
  const initialFitStale = pickedFit?.stale ?? false;
  const keywordRow = scoreRows.find((row) => row.rankerVersion === KEYWORD_RANKER_VERSION);
  const initialFit: FitOutput | null = fitRow
    ? {
        score: fitRow.score,
        matched: fitRow.matched ?? [],
        gaps: fitRow.gaps ?? [],
        rationale: fitRow.rationale ?? "",
      }
    : null;

  // A row that made it past the query filter above still has to satisfy
  // the *current* Zod schema — a stored output can predate a schema
  // change (e.g. `TailorOutput` just gained `projects`). Fall back through
  // older rows for that step rather than collapsing to "never generated".
  const latestGenByStep = latestGenerationByStep(genRows, ["tailor", "suggest"], (row) => {
    if (row.step === "tailor") return TailorOutput.safeParse(row.output).success;
    if (row.step === "suggest") return SuggestOutput.safeParse(row.output).success;
    return true;
  });
  const labels = factLabels(facts);

  const tailorGenRow = latestGenByStep.get("tailor");
  const tailorOutput = tailorGenRow ? TailorOutput.safeParse(tailorGenRow.output) : null;
  const initialTailorGeneration: TailorInitialGeneration | null =
    tailorGenRow && tailorOutput?.success
      ? {
          generationId: tailorGenRow.id,
          output: tailorOutput.data,
          hallucination: checkCitations(tailorOutput.data, labels),
          userEdits: tailorGenRow.userEdits ?? null,
        }
      : null;

  const suggestGenRow = latestGenByStep.get("suggest");
  const suggestOutput = suggestGenRow ? SuggestOutput.safeParse(suggestGenRow.output) : null;
  const initialSuggestGeneration: SuggestInitialGeneration | null =
    suggestGenRow && suggestOutput?.success
      ? {
          output: suggestOutput.data,
          hallucination: checkCitations(suggestOutput.data, labels),
        }
      : null;

  const { verdict, reasons } = assessJob({
    job: {
      title: jobRow.title,
      remote: jobRow.remote,
      countries: jobRow.countries,
      postedAt: jobRow.postedAt,
      lastSeenAt: jobRow.lastSeenAt,
      active: jobRow.active,
      isEntryLevel: jobRow.isEntryLevel,
      isRelevantRole: jobRow.isRelevantRole,
      workAuthSignal: jobRow.workAuthSignal,
      location: jobRow.location,
    },
    analysis,
    fitScore: fitRow?.score ?? null,
    prefs: toVerdictPrefs(prefs),
    alreadyApplied: appliedRows.some((row) => countsAsApplied(row.status)),
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">{jobRow.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{jobRow.companyName ?? "Unknown company"}</p>
      </div>

      <div className="flex flex-col gap-2 rounded-lg border bg-card p-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">Is this worth applying to?</span>
          <VerdictBadge verdict={verdict} reasons={reasons} />
        </div>
        {reasons.length > 0 ? (
          <ul className="list-inside list-disc text-sm text-muted-foreground">
            {reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No caveats — go for it.</p>
        )}
      </div>

      <JobDetailTabs
        jobId={jobRow.id}
        initialTab={initialTab}
        posting={{
          title: jobRow.title,
          companyName: jobRow.companyName,
          location: jobRow.location,
          remote: jobRow.remote,
          url: jobRow.url,
          description: jobRow.description,
          postedAt: jobRow.postedAt ? format(jobRow.postedAt, "MMM d, yyyy") : null,
        }}
        fit={{
          initialAnalyzed: analysis != null,
          initialFit,
          initialFitStale,
          initialKeywordScore: keywordRow?.score ?? null,
        }}
        initialTailorGeneration={initialTailorGeneration}
        initialSuggestGeneration={initialSuggestGeneration}
      />
    </div>
  );
}
