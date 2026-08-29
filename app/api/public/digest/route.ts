/**
 * `POST /api/public/digest` — the last mile of the daily career-page watcher.
 *
 * A scheduled Claude cloud agent (claude.ai/code/routines) reads the careers
 * pages in `data/watchlist.json`, judges what it finds against the owner's
 * confirmed resume facts, and POSTs the result here. This route renders that
 * into an email and sends it. It is the *only* piece of the loop that holds a
 * Resend credential.
 *
 * Auth is a single shared secret in `Authorization: Bearer`, not the app's
 * Supabase session: the caller is an unattended agent with no browser and no
 * user to sign in as. The secret is compared in constant time — a plain `===`
 * on a secret leaks its prefix to an attacker who can measure response times,
 * and this endpoint is public on the internet.
 *
 * It lives under `/api/public/` because `middleware.ts` requires a Supabase
 * session for every other `/api/` path, and this caller has none. "Public"
 * there means "not session-gated", not "unauthenticated" — the bearer check
 * below is this route's auth.
 *
 * Scope is intentionally tiny. There is no recipient in the payload: mail goes
 * to `OWNER_EMAIL` and nowhere else, so possession of the secret buys an
 * attacker the ability to send the owner a job digest — not to send mail as
 * `cydsoccer.com`.
 */
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { digestPayloadSchema } from "@/src/digest/schema";
import { digestSubject, renderDigestHtml, renderDigestText } from "@/src/digest/render";
import { DigestSendError, sendDigestEmail } from "@/src/digest/send";

export const runtime = "nodejs";

/** Constant-time compare that also tolerates length mismatches without branching early on content. */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    // Still burn a comparison so the failure cost does not depend on length.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  const expected = process.env.DIGEST_SECRET;
  if (!expected) {
    return NextResponse.json({ error: "Digest endpoint is not configured." }, { status: 503 });
  }

  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!provided || !secretMatches(provided, expected)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const parsed = digestPayloadSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid digest payload.", issues: parsed.error.issues.slice(0, 10) },
      { status: 400 },
    );
  }
  const payload = parsed.data;

  // An empty digest is a successful run with nothing to report, and the owner
  // asked for silence on those days — so this is a 200, not a send.
  if (payload.jobs.length === 0) {
    return NextResponse.json({ sent: false, reason: "no jobs cleared the bar", checked: payload.checked });
  }

  const to = process.env.OWNER_EMAIL;
  if (!to) {
    return NextResponse.json({ error: "OWNER_EMAIL is not configured." }, { status: 503 });
  }

  try {
    const result = await sendDigestEmail({
      to,
      subject: digestSubject(payload),
      html: renderDigestHtml(payload),
      text: renderDigestText(payload),
    });
    return NextResponse.json({ sent: true, id: result.id, jobs: payload.jobs.length });
  } catch (error) {
    if (error instanceof DigestSendError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
