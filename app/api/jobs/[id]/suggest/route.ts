import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { requireUser } from "@/src/auth/require";
import { getDb } from "@/src/db/client";
import { jobs, jobScores } from "@/src/db/schema";
import { LlmError } from "@/src/llm/model-id";
import { runSuggest } from "@/src/pipeline/steps";
import type { FitOutput } from "@/src/pipeline/schemas";
import { getConfirmedFacts } from "@/src/profile/facts";

/**
 * `POST /api/jobs/[id]/suggest` — the Suggestions tab's "Generate" button
 * (plan Task 9 Step 3). Same inputs as `/tailor` (this job's cached
 * `analysis`, the user's confirmed facts, their latest `fit` score), but
 * runs the `suggest` step: gaps, what to lead with, a weekend build, likely
 * questions, honest keywords.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  const { id: jobId } = await params;
  const db = getDb();

  const [job] = await db
    .select({ id: jobs.id, analysis: jobs.analysis })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);
  if (!job) {
    return NextResponse.json({ error: "That job doesn't exist." }, { status: 404 });
  }
  if (!job.analysis) {
    return NextResponse.json(
      { error: "This job hasn't been analyzed yet. Open the Posting or Fit tab first." },
      { status: 409 },
    );
  }

  const facts = await getConfirmedFacts(db, user.id);
  if (facts.length === 0) {
    return NextResponse.json(
      { error: "You have no confirmed resume facts yet. Finish onboarding first." },
      { status: 409 },
    );
  }

  const [scoreRow] = await db
    .select({
      score: jobScores.score,
      matched: jobScores.matched,
      gaps: jobScores.gaps,
      rationale: jobScores.rationale,
    })
    .from(jobScores)
    .where(and(eq(jobScores.jobId, jobId), eq(jobScores.userId, user.id)))
    .orderBy(desc(jobScores.createdAt))
    .limit(1);

  const fit: FitOutput | null = scoreRow
    ? {
        score: scoreRow.score,
        matched: scoreRow.matched ?? [],
        gaps: scoreRow.gaps ?? [],
        rationale: scoreRow.rationale ?? "",
      }
    : null;

  try {
    const { output, generationId, hallucination, costUsd } = await runSuggest(db, {
      analysis: job.analysis,
      facts,
      fit,
      userId: user.id,
      jobId: job.id,
    });
    return NextResponse.json({ output, generationId, hallucination, costUsd });
  } catch (err) {
    if (err instanceof LlmError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status ?? 500 });
    }
    throw err;
  }
}
