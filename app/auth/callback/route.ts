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
  const next = url.searchParams.get("next") ?? "/settings";

  if (!code) {
    return NextResponse.redirect(new URL("/login?error=auth_failed", url.origin), 302);
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

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
