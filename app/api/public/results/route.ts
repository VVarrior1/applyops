import { NextResponse } from "next/server";
import { getDb } from "@/src/db/client";
import { loadPublicResults } from "@/src/funnel/public-results";

/**
 * `GET /api/public/results` — public, no auth (already allow-listed in
 * `middleware.ts` under `/api/public/**`; see also `PUBLIC_PAGE_PATHS`
 * covering the `/results` page itself). Mirrors `app/(public)/results/page.tsx`
 * as machine-readable JSON, e.g. for a future status badge or external tool.
 *
 * Revalidated on a short interval rather than served on every request —
 * this is a public, unauthenticated route hitting the database directly, so
 * some caching is the cheap version of spec §11's cost/abuse controls for a
 * surface with no per-user budget to check.
 */
export const revalidate = 300;

export async function GET() {
  const db = getDb();
  const data = await loadPublicResults(db);

  // 200 either way: `data: null` ("no owner has signed in yet") is a valid,
  // expected state for a fresh deploy, not an error a client should retry.
  return NextResponse.json({ ok: true, data });
}
