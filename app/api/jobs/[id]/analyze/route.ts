import { NextResponse } from "next/server";
import { requireUser } from "@/src/auth/require";
import { getDb } from "@/src/db/client";
import { LlmError } from "@/src/llm/model-id";
import { ensureAnalysis, loadJobForScoring } from "@/src/rank/rank";

/**
 * `POST /api/jobs/[id]/analyze` — ensures `jobs.analysis` is populated
 * (plan Task 8 Step 3, spec §5/§6: analysis is per-job, cached, and shared
 * across every user). A no-op, zero-cost call when it's already cached;
 * otherwise runs the `analyze` step — charged to the signed-in user — and
 * caches the result on the job row for every future user and step (`fit`
 * here, and Task 9's `tailor`/`suggest`, which never call `analyze`
 * themselves and 409 instead if this hasn't run yet).
 *
 * The Posting and Fit tabs both call this before anything that needs an
 * analyzed posting, which is why Task 9's 409 message says "Open the
 * Posting or Fit tab first" — landing on either tab is what runs this.
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

  try {
    const result = await ensureAnalysis(db, user.id, job);
    return NextResponse.json({
      output: result.analysis,
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
