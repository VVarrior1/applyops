import { NextResponse } from "next/server";
import { requireUser } from "@/src/auth/require";
import { getDb } from "@/src/db/client";
import { LlmError } from "@/src/llm/model-id";
import { loadJobForScoring, scoreFit } from "@/src/rank/rank";

/**
 * `POST /api/jobs/[id]/fit` — the Fit tab's "Score this job" / "Re-score"
 * button (plan Task 8 Step 3). Requires `jobs.analysis` already set — 409,
 * same message shape as Task 9's `/tailor` and `/suggest` routes, if it
 * isn't; the Fit tab calls `POST .../analyze` first (a no-op once cached).
 * Always runs — no "already scored" guard, unlike the bulk `rank`
 * CLI/`/api/rank`, where that guard only matters for choosing among many
 * candidates — and (re)writes both the `fit-v1:<model>` and `keyword-v1`
 * `job_scores` rows for this job.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  const { id: jobId } = await params;
  const db = getDb();

  const job = await loadJobForScoring(db, jobId);
  if (!job) {
    return NextResponse.json({ error: "That job doesn't exist." }, { status: 404 });
  }
  if (!job.analysis) {
    return NextResponse.json(
      { error: "This job hasn't been analyzed yet. Open the Posting or Fit tab first." },
      { status: 409 },
    );
  }

  try {
    const result = await scoreFit(db, user.id, job, job.analysis);
    return NextResponse.json({
      output: result.output,
      generationId: result.generationId,
      costUsd: result.costUsd,
    });
  } catch (err) {
    if (err instanceof LlmError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status ?? 500 });
    }
    throw err;
  }
}
