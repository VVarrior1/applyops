import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/src/auth/server";
import { ensureProfile } from "@/src/auth/require";
import { isEmailAllowed } from "@/src/auth/allowlist";
import { getDb } from "@/src/db/client";

/**
 * Magic-link landing page. Supabase's `signInWithOtp` (PKCE flow) redirects
 * the browser here with a `?code=...` to exchange for a session.
 *
 * `/settings` is the default post-login destination rather than `/jobs`:
 * this task doesn't create `/jobs` yet (that's Task 7+), and `/settings`
 * always exists and is meaningful to land on. Revisit once a real "home"
 * page exists.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const otpType = url.searchParams.get("type") as "magiclink" | "email" | "recovery" | "invite" | "signup" | null;
  const next = url.searchParams.get("next") ?? "/settings";

  if (!code && !tokenHash) {
    return NextResponse.redirect(new URL("/login?error=auth_failed", url.origin), 302);
  }

  const supabase = await createSupabaseServerClient();
  // Two ways in: the PKCE `code` from signInWithOtp, or a `token_hash` from an
  // admin-generated link / a custom email template (no PKCE verifier needed).
  const { data, error } = code
    ? await supabase.auth.exchangeCodeForSession(code)
    : await supabase.auth.verifyOtp({ token_hash: tokenHash as string, type: otpType ?? "magiclink" });

  if (error || !data.user?.email) {
    return NextResponse.redirect(new URL("/login?error=auth_failed", url.origin), 302);
  }

  const db = getDb();
  const email = data.user.email;

  const allowed = await isEmailAllowed(db, email);
  if (!allowed) {
    await supabase.auth.signOut();
    return NextResponse.redirect(new URL("/login?error=invite_only", url.origin), 302);
  }

  await ensureProfile(db, { id: data.user.id, email });

  return NextResponse.redirect(new URL(next, url.origin), 302);
}
