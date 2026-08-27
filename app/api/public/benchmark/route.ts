/**
 * `GET /api/public/benchmark` — the same scoreboard `/benchmark` renders, as
 * JSON, so the numbers on the public page are machine-checkable by anyone.
 *
 * Public and unauthenticated: `eval_runs` holds model names, scores, costs and
 * latencies — no user data, no company names, no posting text — so there is
 * nothing here to scope to a session. Cached for an hour
 * ({@link BENCHMARK_CACHE_SECONDS}) both in Next's data cache and at the CDN,
 * so an uncached public route cannot be used to hammer the database.
 */

import { unstable_cache } from "next/cache";
import { NextResponse } from "next/server";
import {
  BENCHMARK_CACHE_SECONDS,
  BENCHMARK_CACHE_TAG,
  loadBenchmarkBoard,
} from "@/src/bench/bench";
import { getDb } from "@/src/db/client";

// Rendered per request (and then served from the caches below) rather than
// prerendered: `next build` runs without DATABASE_URL in CI, and a build-time
// query would either fail the build or bake an empty scoreboard into the
// deployment for the first hour after every deploy.
export const dynamic = "force-dynamic";

const getBoard = unstable_cache(
  async () => loadBenchmarkBoard(getDb()),
  [BENCHMARK_CACHE_TAG, "route"],
  { revalidate: BENCHMARK_CACHE_SECONDS, tags: [BENCHMARK_CACHE_TAG] },
);

export async function GET() {
  const board = await getBoard();

  return NextResponse.json(board, {
    headers: {
      "Cache-Control": `public, s-maxage=${BENCHMARK_CACHE_SECONDS}, stale-while-revalidate=86400`,
    },
  });
}
