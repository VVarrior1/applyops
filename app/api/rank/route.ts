import { NextResponse } from "next/server";
import { requireUser } from "@/src/auth/require";
import { getDb } from "@/src/db/client";
import { LlmError } from "@/src/llm/model-id";
import { DEFAULT_MAX_JOBS, rankForUser } from "@/src/rank/rank";

/** Hard ceiling on a single click's batch size — `applyops rank --max` has no such cap. */
const MAX_JOBS_CEILING = 100;

/**
 * `POST /api/rank` — the Jobs page's "Rank more" button (plan Task 8 Step
 * 3). Budget-aware: `rankForUser()` stops itself once the signed-in user's
 * daily AI budget is spent and reports how far it got (`{scored, skipped,
 * costUsd}`), rather than this route pre-checking anything.
 */
export async function POST(request: Request) {
  const user = await requireUser();
  const db = getDb();

  const body: unknown = await request.json().catch(() => ({}));
  const requested =
    typeof body === "object" && body !== null && "maxJobs" in body
      ? (body as { maxJobs?: unknown }).maxJobs
      : undefined;

  const maxJobs =
    typeof requested === "number" && Number.isFinite(requested)
      ? Math.max(1, Math.min(MAX_JOBS_CEILING, Math.floor(requested)))
      : DEFAULT_MAX_JOBS;

  try {
    const result = await rankForUser(db, user.id, { maxJobs });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof LlmError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status ?? 500 });
    }
    throw err;
  }
}
