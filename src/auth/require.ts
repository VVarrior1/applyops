import { cache } from "react";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createSupabaseServerClient } from "./server";
import { getDb } from "../db/client";
import { profiles } from "../db/schema";
import type * as schema from "../db/schema";

type Db = PostgresJsDatabase<typeof schema>;

export interface SessionUser {
  id: string;
  email: string;
}

/**
 * Session lookup that never redirects — `null` when there is no session (or
 * the session's user has no verified email). Wrapped in React's `cache()`
 * so a layout and the page it wraps (e.g. `app/(public)/layout.tsx` and
 * `app/(public)/results/page.tsx`) share one Supabase `getUser()` call per
 * request instead of each paying its own round trip.
 */
export const getOptionalUser = cache(async (): Promise<SessionUser | null> => {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !user.email) {
    return null;
  }

  return { id: user.id, email: user.email };
});

/**
 * Server-side session guard for Server Components, Route Handlers, and
 * Server Actions under `app/(app)/**`. `middleware.ts` already blocks
 * unauthenticated requests to these routes, but calling this here too is
 * defense in depth (and the only way a page/route gets a typed, non-null
 * user without re-deriving it). Redirects to `/login` when there is no
 * session, or when the session's user has no verified email (magic-link
 * auth always sets one, so this only fires for a malformed/edge-case
 * session).
 */
export async function requireUser(): Promise<SessionUser> {
  const user = await getOptionalUser();

  if (!user) {
    redirect("/login");
  }

  return user;
}

/**
 * Like `requireUser`, but also requires `profiles.is_owner`. Redirects
 * non-owners to `/` — there is no dedicated "forbidden" page, and owner-only
 * surfaces (the allow-list admin page, later the evals/grading UI) are not
 * things a non-owner should be told exist in more detail than that.
 */
export async function requireOwner(db: Db = getDb()): Promise<SessionUser> {
  const user = await requireUser();

  const [profile] = await db
    .select({ isOwner: profiles.isOwner })
    .from(profiles)
    .where(eq(profiles.userId, user.id))
    .limit(1);

  if (!profile?.isOwner) {
    redirect("/");
  }

  return user;
}

/**
 * Creates the `profiles` row for a freshly-authenticated user if one
 * doesn't already exist. `is_owner` is set once, at creation, from
 * `OWNER_EMAIL` — it is intentionally not re-derived on every call, so
 * revoking/granting owner status for an existing row is a manual DB edit,
 * not something a changed env var silently flips on next login.
 */
export async function ensureProfile(db: Db, user: SessionUser): Promise<void> {
  const isOwner =
    !!process.env.OWNER_EMAIL &&
    process.env.OWNER_EMAIL.trim().toLowerCase() === user.email.trim().toLowerCase();

  await db
    .insert(profiles)
    .values({ userId: user.id, isOwner })
    .onConflictDoNothing({ target: profiles.userId });
}
