import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/src/auth/require";
import { fetchPostingDetails } from "@/src/funnel/manual-application";

const bodySchema = z.object({ url: z.string().trim().url() });

/**
 * `POST /api/applications/manual/fetch` — the "Add application" dialog's
 * "Fetch details" button: best-effort scrape of a job posting URL to
 * prefill title/company/location/description before the user submits.
 * See `fetchPostingDetails` (src/funnel/manual-application.ts) for the
 * vendor-JSON-first, JSON-LD/HTML-fallback strategy.
 *
 * Always 200 for a syntactically valid URL, even one that could not be
 * fetched or parsed — the result carries `{ error }` in that case instead
 * of the route throwing, so the dialog just leaves the fields for the user
 * to fill in by hand rather than showing a scary failure.
 */
export async function POST(request: Request) {
  await requireUser();

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "A valid URL is required." }, { status: 400 });
  }

  const result = await fetchPostingDetails(parsed.data.url);
  return NextResponse.json(result, { status: 200 });
}
