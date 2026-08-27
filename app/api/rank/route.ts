import { NextResponse } from "next/server";
import { requireUser } from "@/src/auth/require";
import { getDb } from "@/src/db/client";
import { LlmError } from "@/src/llm/model-id";
import { rankForUser } from "@/src/rank/rank";

/** Hard ceiling on a single click's batch size — `applyops rank --max` has no such cap. */
const MAX_JOBS_CEILING = 100;

/**
 * Default batch size for this route specifically — deliberately smaller
 * than the CLI's `DEFAULT_MAX_JOBS` (50). Each job here is a sequential
 * `analyze` + `fit` pair of live LLM calls inside one Next.js route
 * handler; measured against this project's own `generations` table,
 * analyze/fit latency alone can run into the tens of seconds per job at the
 * high end, and Vercel's Node function duration is bounded (see
 * `maxDuration` below). The CLI has no such ceiling and keeps its own
 * larger default for bulk runs.
 */
const ROUTE_DEFAULT_MAX_JOBS = 5;

/**
 * Bounds how long this route is allowed to run (Vercel Node functions
 * default to well under what a multi-job batch of sequential LLM calls can
 * take). 300s comfortably covers `ROUTE_DEFAULT_MAX_JOBS` jobs even at this
 * project's observed worst-case per-job analyze+fit latency; a caller who
 * explicitly requests more (up to `MAX_JOBS_CEILING`) can still exceed it —
 * that trade is intentional here (see `maxJobs` below), the button never
 * does.
 */
export const maxDuration = 300;

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
      : ROUTE_DEFAULT_MAX_JOBS;

  try {
    const result = await rankForUser(db, user.id, {
      maxJobs,
      log: (line) => console.error(`[rank] ${user.id}: ${line}`),
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof LlmError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status ?? 500 });
    }
    throw err;
  }
}
