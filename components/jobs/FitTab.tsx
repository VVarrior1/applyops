"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { FitOutput } from "@/src/pipeline/schemas";
import { FIT_APPLY_FROM, FIT_SKIP_BELOW } from "@/src/rank/verdict";

/** How many `matched` cards render before "Show all" — same reasoning as the
 * hard cap this guards against: a real fit rarely clears more than a
 * handful of the posting's own must-haves, so a list this long is a signal
 * something upstream (see `stripInventedMatches`) let through, not a wall
 * the user should have to scroll past. */
const MATCHED_PREVIEW_COUNT = 6;

export interface FitTabProps {
  jobId: string;
  /** Whether `jobs.analysis` was already set when the page loaded. */
  initialAnalyzed: boolean;
  /**
   * The best available `fit-v1:*` `job_scores` row for this job/user, if
   * any — the current ranker version when one exists, otherwise the newest
   * row under an older version (`pickFitScoreRow`, `src/rank/rank.ts`).
   */
  initialFit: FitOutput | null;
  /** True when `initialFit` was scored under an older fit-ranker version than the current default (`pickFitScoreRow`'s fallback branch), not a fresh re-score. */
  initialFitStale?: boolean;
  /** The free `keyword-v1` baseline (0–10), shown while nothing has been fit-scored yet. */
  initialKeywordScore: number | null;
}

async function parseErrorBody(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `Request failed (${res.status}).`;
  } catch {
    return `Request failed (${res.status}).`;
  }
}

function FactChips({ ids }: { ids: string[] }) {
  if (ids.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {ids.map((id) => (
        <Badge key={id} variant="outline" className="font-mono text-[10px]">
          {id}
        </Badge>
      ))}
    </div>
  );
}

/**
 * Same thresholds `assessJob()` (`src/rank/verdict.ts`) uses to turn this
 * exact score into the "worth applying?" badge above the tabs — so the
 * number here is never green while that badge reads "Maybe" or "Skip".
 */
function scoreTone(score: number): string {
  if (score >= FIT_APPLY_FROM) return "text-emerald-600 dark:text-emerald-400";
  if (score >= FIT_SKIP_BELOW) return "text-amber-600 dark:text-amber-400";
  return "text-destructive";
}

/**
 * `/jobs/[id]`'s "Fit" tab — plan Task 8 Step 3: score, matched
 * requirements with fact chips, gaps, rationale, and a "Re-score" button.
 *
 * "Score this job" runs two calls in sequence — `POST .../analyze` (a
 * no-op once `jobs.analysis` is cached) then `POST .../fit` — the same two
 * real steps `rankForUser()` runs in one pass for a whole batch, split here
 * into two requests so a failed/expensive fit call never hides whether the
 * posting was successfully analyzed.
 */
export function FitTab({
  jobId,
  initialAnalyzed,
  initialFit,
  initialFitStale = false,
  initialKeywordScore,
}: FitTabProps) {
  const router = useRouter();
  const [fit, setFit] = useState<FitOutput | null>(initialFit);
  // Only ever true for `initialFit` — a fresh "Score this job"/"Re-score"
  // always writes under the current ranker version, so any score set by
  // `handleScore` below is never stale.
  const [stale, setStale] = useState(initialFitStale);
  const [scoring, setScoring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAllMatched, setShowAllMatched] = useState(false);

  async function handleScore() {
    setScoring(true);
    setError(null);
    try {
      const analyzeRes = await fetch(`/api/jobs/${jobId}/analyze`, { method: "POST" });
      if (!analyzeRes.ok) {
        setError(await parseErrorBody(analyzeRes));
        return;
      }
      const fitRes = await fetch(`/api/jobs/${jobId}/fit`, { method: "POST" });
      if (!fitRes.ok) {
        setError(await parseErrorBody(fitRes));
        return;
      }
      const body = (await fitRes.json()) as { output: FitOutput };
      setFit(body.output);
      setStale(false);
      setShowAllMatched(false);
      // Refresh server props (plan point 2) — the page-level "worth
      // applying?" verdict badge depends on this job's fit score and only
      // updates via a server re-render.
      router.refresh();
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setScoring(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button onClick={handleScore} disabled={scoring} size="sm" variant={fit ? "outline" : "default"}>
          {scoring ? "Scoring…" : fit ? "Re-score" : "Score this job"}
        </Button>
        {!fit && initialKeywordScore !== null && (
          <span className="text-sm text-muted-foreground">Keyword baseline: {initialKeywordScore}/10</span>
        )}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}

      {!fit && !scoring && (
        <p className="text-sm text-muted-foreground">
          {initialAnalyzed
            ? "Not yet scored against your profile."
            : "This posting hasn't been analyzed yet — scoring it will run that first."}
        </p>
      )}

      {fit && (
        <div className="flex flex-col gap-4">
          <div className="flex items-baseline gap-2">
            <span className={`text-3xl font-semibold ${scoreTone(fit.score)}`}>{fit.score}</span>
            <span className="text-sm text-muted-foreground">/ 100 fit score</span>
          </div>
          {stale && (
            <p className="text-sm text-muted-foreground">
              Scored under an older model — re-score to refresh.
            </p>
          )}

          <p className="text-sm leading-relaxed">{fit.rationale}</p>

          {fit.matched.length > 0 && (
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">
                Matched requirements
                <span className="ml-1.5 font-normal text-muted-foreground">({fit.matched.length})</span>
              </h3>
              <div className="flex flex-col gap-2">
                {(showAllMatched ? fit.matched : fit.matched.slice(0, MATCHED_PREVIEW_COUNT)).map((match, i) => (
                  <div key={i} className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-2.5">
                    <p className="text-sm">{match.requirement}</p>
                    <FactChips ids={match.fact_ids} />
                  </div>
                ))}
              </div>
              {fit.matched.length > MATCHED_PREVIEW_COUNT && (
                <Button variant="ghost" size="sm" className="w-fit" onClick={() => setShowAllMatched((v) => !v)}>
                  {showAllMatched ? "Show fewer" : `Show all ${fit.matched.length}`}
                </Button>
              )}
            </div>
          )}

          {fit.gaps.length > 0 && (
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">Gaps</h3>
              <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
                {fit.gaps.map((gap, i) => (
                  <li key={i} className="flex gap-2">
                    <span aria-hidden>·</span>
                    <span>{gap}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
