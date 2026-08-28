/**
 * Everything the public `/results` page (and its `/api/public/results`
 * mirror) needs, loaded in one pass — plan Task 14 Step 2: "owner's funnel
 * (weekly + by prompt version, CIs), latest baseline eval scorecard
 * (hallucination %, kappa or 'pending'), latest gate run status, the
 * benchmark headline row; no company names, no job titles beyond role
 * family."
 *
 * Not in the plan's locked file list for this task, but there was no other
 * place to put logic shared by both the page (a Server Component) and the
 * API route without either duplicating ~100 lines of Drizzle queries or
 * having the page `fetch()` its own site's API mid-render (an antipattern —
 * no clean base URL during SSR, an extra network hop, and its own caching
 * headaches). Task 9 set the same precedent for an unavoidable small
 * addition outside its file list; this mirrors that call.
 *
 * Three data-modelling decisions worth knowing about, since none of them are
 * literally in the spec text:
 *
 *   - **"Latest gate run"** has no dedicated table (Task 12, which owns
 *     `src/eval/gate.ts` and the `eval-gate.yml` workflow, was not merged as
 *     of this branch). This reads it off `eval_runs` instead: the most
 *     recent non-baseline run for the flagship step, graded with the same
 *     rule `evaluateGate` is specified to use (spec §7) — see
 *     `computeGateStatus` below. Once Task 12 lands, importing
 *     `evaluateGate` directly here would remove the small duplication.
 *   - **"Benchmark headline row"** is the latest recorded run of the
 *     *current default* model (`src/llm/defaults.ts`) for the flagship step
 *     — "where the model actually in use stands right now" — rather than
 *     Task 13's full multi-model table, which this task does not own.
 *   - **The flagship step is `tailor`**, matching `/evals`
 *     (`app/(app)/evals/page.tsx`), which fixes the same constant for the
 *     same reason: it's the step with a golden set and the most eval
 *     history.
 */

import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  applications,
  companies,
  generations,
  jobs,
  outcomeEvents,
  profiles,
  promptVersions,
} from "../db/schema";
import { defaultModelForStep } from "../llm/defaults";
import { listEvalRuns, type EvalRunListItem } from "../eval/runner";
import { currentStage, deriveFunnel, type ApplicationStage, type FunnelApplication, type FunnelRow } from "./derive";
import { redactCompanies, roleFamily } from "./redact";

/** Same step `/evals` (Task 11) fixes its trend chart to — see file header. */
const FLAGSHIP_STEP = "tailor" as const;

/**
 * Spec §7's gate thresholds, pinned to match Task 12's
 * `DEFAULT_GATE_THRESHOLDS` (`src/eval/gate.ts`) exactly — as of this branch
 * that module lives on `origin/task/12`, not yet merged here, so it can't be
 * imported directly. `tests/funnel/public-results.test.ts` pins these three
 * numbers so a value drift between the two modules fails a test instead of
 * shipping a public badge that disagrees with the real CI gate. Once Task 12
 * merges, replace `computeGateStatus` with a call to `evaluateGate` from
 * `src/eval/gate.ts` and delete these constants.
 */
const GATE_MAX_HALLUCINATION_RATE = 0.02;
const GATE_MAX_FAILED_ITEM_RATE = 0.1;
const GATE_MIN_SCORED_ITEMS = 1;

/** How many recent applications to show, redacted, on the public page. */
const RECENT_APPLICATIONS_LIMIT = 15;

/** Eval runs to scan for "latest baseline" / "latest candidate" / "latest default-model run" — generous because `listEvalRuns` is not filterable by step server-side. */
const EVAL_RUNS_SCAN_LIMIT = 500;

export interface EvalScorecard {
  runId: string;
  createdAt: string;
  modelId: string;
  itemCount: number | null;
  meanScore: number | null;
  hallucinationRate: number | null;
  /** `null` means "pending" — fewer than the min graded items for kappa (spec §7). */
  kappa: number | null;
  costUsd: number | null;
}

export interface GateStatus {
  runId: string;
  createdAt: string;
  modelId: string;
  itemCount: number | null;
  status: "pass" | "fail";
  reasons: string[];
}

export interface BenchmarkHeadline {
  step: string;
  modelId: string;
  meanScore: number | null;
  hallucinationRate: number | null;
  /** Mean cost per item, in USD. */
  costPerItemUsd: number | null;
  p50Ms: number | null;
  n: number | null;
  createdAt: string;
}

export interface RecentApplicationRow {
  /** Redacted — "Company #n", never the real employer name. */
  company: string;
  /** Coarse category — never the literal posting title. */
  roleFamily: string;
  stage: ApplicationStage;
  /** Date only (`YYYY-MM-DD`), not a timestamp. */
  appliedOn: string;
}

export interface PublicResults {
  funnelByWeek: FunnelRow[];
  funnelByPromptVersion: FunnelRow[];
  evalScorecard: EvalScorecard | null;
  gate: GateStatus | null;
  benchmarkHeadline: BenchmarkHeadline | null;
  recentApplications: RecentApplicationRow[];
  generatedAt: string;
}

/**
 * The same pass/fail rule spec §7 / Task 12's `evaluateGate` describes
 * (`hallucinationRate > 0.02`, or a vs-baseline CI entirely below zero, or a
 * *fraction* — not any nonzero count — of attempted items failing to run:
 * see `GATE_MAX_FAILED_ITEM_RATE`'s doc comment for why a fraction), plus one
 * extra check this module's context flagged as important: a run where every
 * item errored reports 0% hallucination by construction (no claims were ever
 * checked) and must not read as "passed" — see Task 11's completed-task
 * notes on `failed_items`, and `GATE_MIN_SCORED_ITEMS` below.
 *
 * Exported (pure, no I/O) so `tests/funnel/public-results.test.ts` can pin
 * it against Task 12's real threshold values without a DB handle.
 */
export function computeGateStatus(run: EvalRunListItem): { status: "pass" | "fail"; reasons: string[] } {
  const reasons: string[] = [];
  const hallucinationRate = run.hallucinationRate ?? 0;

  if (hallucinationRate > GATE_MAX_HALLUCINATION_RATE) {
    reasons.push(
      `hallucination rate ${(hallucinationRate * 100).toFixed(1)}% exceeds the ${(
        GATE_MAX_HALLUCINATION_RATE * 100
      ).toFixed(0)}% gate threshold`,
    );
  }

  if (run.vsBaseline && run.vsBaseline.ci95[1] < 0) {
    const [lo, hi] = run.vsBaseline.ci95;
    reasons.push(
      `95% CI of the score delta vs. baseline [${lo.toFixed(2)}, ${hi.toFixed(2)}] is entirely below zero`,
    );
  }

  // A fraction, not `failedItems > 0` — see file header / GATE_MAX_FAILED_ITEM_RATE.
  const failedItems = run.failedItems ?? 0;
  const itemsAttempted = run.itemsAttempted ?? failedItems;
  const failedItemRate = itemsAttempted > 0 ? failedItems / itemsAttempted : 0;
  if (failedItemRate > GATE_MAX_FAILED_ITEM_RATE) {
    reasons.push(
      `${failedItems} of ${run.itemsAttempted ?? "?"} items failed to run (${(failedItemRate * 100).toFixed(
        0,
      )}% > ${(GATE_MAX_FAILED_ITEM_RATE * 100).toFixed(0)}% threshold)`,
    );
  }

  // A run that scored nothing proves nothing — must not read as "passed".
  const scoredItems = run.itemCount ?? 0;
  if (scoredItems < GATE_MIN_SCORED_ITEMS) {
    reasons.push(`only ${scoredItems} scored item(s), below the minimum of ${GATE_MIN_SCORED_ITEMS}`);
  }

  return { status: reasons.length === 0 ? "pass" : "fail", reasons };
}

/**
 * Loads everything `/results` needs. Returns `null` only when no owner
 * profile exists yet (a fresh deploy before the owner's first sign-in) —
 * there is nothing to show before that.
 */
export async function loadPublicResults(db: Db): Promise<PublicResults | null> {
  const [owner] = await db
    .select({ userId: profiles.userId })
    .from(profiles)
    .where(eq(profiles.isOwner, true))
    .limit(1);
  if (!owner) return null;

  // --- Funnel: same shape as app/(app)/funnel/page.tsx, scoped to the owner. ---
  // Joined to `jobs` (inner) and filtered on `isPlaceholder` so v1-migration
  // orphan rows (no real posting behind them) never inflate the public
  // funnel counts or surface as a "Company #n" / role-family row below —
  // see src/db/schema.ts on `jobs.isPlaceholder`.
  const appRows = await db
    .select({
      id: applications.id,
      createdAt: applications.createdAt,
      jobId: applications.jobId,
      promptVersion: promptVersions.version,
    })
    .from(applications)
    .innerJoin(jobs, eq(applications.jobId, jobs.id))
    .leftJoin(generations, eq(applications.tailorGenerationId, generations.id))
    .leftJoin(promptVersions, eq(generations.promptVersionId, promptVersions.id))
    .where(and(eq(applications.userId, owner.userId), eq(jobs.isPlaceholder, false)));

  const events =
    appRows.length === 0
      ? []
      : await db
          .select({
            applicationId: outcomeEvents.applicationId,
            type: outcomeEvents.type,
            occurredAt: outcomeEvents.occurredAt,
          })
          .from(outcomeEvents)
          .where(
            inArray(
              outcomeEvents.applicationId,
              appRows.map((row) => row.id),
            ),
          );

  const eventsByApplication = new Map<string, FunnelApplication["events"]>();
  for (const event of events) {
    const bucket = eventsByApplication.get(event.applicationId);
    const entry = { type: event.type, occurredAt: event.occurredAt };
    if (bucket) bucket.push(entry);
    else eventsByApplication.set(event.applicationId, [entry]);
  }

  const funnelApplications: FunnelApplication[] = appRows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt,
    promptVersion: row.promptVersion,
    events: eventsByApplication.get(row.id) ?? [],
  }));

  const funnelByWeek = deriveFunnel(funnelApplications, { groupBy: "week" });
  const funnelByPromptVersion = deriveFunnel(funnelApplications, { groupBy: "prompt_version" });

  // --- Recent applications, redacted. ---
  const recentSourceRows = [...appRows]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, RECENT_APPLICATIONS_LIMIT);

  const jobIds = recentSourceRows.map((row) => row.jobId);
  const jobRows =
    jobIds.length === 0
      ? []
      : await db
          .select({ id: jobs.id, title: jobs.title, companyName: companies.name })
          .from(jobs)
          .leftJoin(companies, eq(jobs.companyId, companies.id))
          .where(inArray(jobs.id, jobIds));
  const jobById = new Map(jobRows.map((job) => [job.id, job]));

  const redactedCompanyNames = redactCompanies(
    recentSourceRows.map((row) => ({ company: jobById.get(row.jobId)?.companyName ?? "Unknown" })),
  );

  const recentApplications: RecentApplicationRow[] = recentSourceRows.map((row, i) => ({
    company: redactedCompanyNames[i],
    roleFamily: roleFamily(jobById.get(row.jobId)?.title ?? ""),
    stage: currentStage(eventsByApplication.get(row.id) ?? []),
    appliedOn: row.createdAt.toISOString().slice(0, 10),
  }));

  // --- Eval scorecard / gate / benchmark headline: all read off eval_runs. ---
  const runs = await listEvalRuns(db, EVAL_RUNS_SCAN_LIMIT);
  const flagshipRuns = runs
    .filter((run) => run.step === FLAGSHIP_STEP)
    // `eval_runs.metrics` is null from insert until `runEval` finishes and
    // updates the row (src/eval/runner.ts) — a run this page's live testing
    // caught mid-flight had `itemCount: 20` (set at insert) but every metric
    // read back `null`. `listEvalRuns` can't tell "still running" apart from
    // "completed with an all-null metrics blob" at the type level, so this
    // reads `hallucinationRate` (always a real number once `runEval`
    // finishes, even 0) as the completion signal. Skipping incomplete runs
    // here matters: `null ?? 0` on an unfinished run's hallucination rate
    // would otherwise report a public "PASS" for a gate check that never
    // actually ran.
    .filter((run) => run.hallucinationRate != null)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const latestBaseline = flagshipRuns.find((run) => run.baseline);
  const evalScorecard: EvalScorecard | null = latestBaseline
    ? {
        runId: latestBaseline.id,
        createdAt: latestBaseline.createdAt.toISOString(),
        modelId: latestBaseline.modelId,
        itemCount: latestBaseline.itemCount,
        meanScore: latestBaseline.meanScore,
        hallucinationRate: latestBaseline.hallucinationRate,
        kappa: latestBaseline.kappa,
        costUsd: latestBaseline.costUsd,
      }
    : null;

  const latestCandidate = flagshipRuns.find((run) => !run.baseline);
  const gate: GateStatus | null = latestCandidate
    ? {
        runId: latestCandidate.id,
        createdAt: latestCandidate.createdAt.toISOString(),
        modelId: latestCandidate.modelId,
        itemCount: latestCandidate.itemCount,
        ...computeGateStatus(latestCandidate),
      }
    : null;

  // Prefer the latest *baseline* run of the default model — "where the
  // shipping model stands" should read the number spec §7's gate compares
  // everything else against, not whatever non-baseline run happened most
  // recently (which can be a deliberate regression/candidate run and
  // simultaneously fail the gate card above it). Fall back to the latest run
  // only when no baseline exists yet for that model.
  const defaultModelId = defaultModelForStep(FLAGSHIP_STEP);
  const latestDefaultModelRun =
    flagshipRuns.find((run) => run.modelId === defaultModelId && run.baseline) ??
    flagshipRuns.find((run) => run.modelId === defaultModelId);
  const benchmarkHeadline: BenchmarkHeadline | null = latestDefaultModelRun
    ? {
        step: FLAGSHIP_STEP,
        modelId: latestDefaultModelRun.modelId,
        meanScore: latestDefaultModelRun.meanScore,
        hallucinationRate: latestDefaultModelRun.hallucinationRate,
        costPerItemUsd:
          latestDefaultModelRun.costUsd != null && latestDefaultModelRun.itemCount
            ? latestDefaultModelRun.costUsd / latestDefaultModelRun.itemCount
            : null,
        p50Ms: latestDefaultModelRun.p50Ms,
        n: latestDefaultModelRun.itemCount,
        createdAt: latestDefaultModelRun.createdAt.toISOString(),
      }
    : null;

  return {
    funnelByWeek,
    funnelByPromptVersion,
    evalScorecard,
    gate,
    benchmarkHeadline,
    recentApplications,
    generatedAt: new Date().toISOString(),
  };
}
