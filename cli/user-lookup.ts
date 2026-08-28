/**
 * Resolving a sign-in email to a `profiles.user_id` for operator commands.
 *
 * `profiles` carries no email — that is Supabase Auth's, not ours (see the
 * header of `src/db/schema.ts`) — so this goes through the Auth admin API,
 * the same move `src/db/seed-v1.ts` and `cli/commands/rank.ts` make.
 * `getStorageAdminClient()` is just a cached service-role `SupabaseClient`;
 * `.auth.admin` is available on any client built with the service-role key.
 */

import { getStorageAdminClient } from "../src/profile/storage";

/**
 * The user id for `email`, or the `OWNER_EMAIL` user when `email` is omitted.
 * Throws with an actionable message rather than returning null — every caller
 * is an operator command that cannot proceed without it.
 */
export async function resolveUserId(email?: string): Promise<{ userId: string; email: string }> {
  const wanted = (email ?? process.env.OWNER_EMAIL ?? "").trim();
  if (!wanted) {
    throw new Error(
      "No email given and OWNER_EMAIL is not set (check .env.local). Pass --user <email>.",
    );
  }

  const admin = getStorageAdminClient();
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw new Error(`Could not list Supabase auth users: ${error.message}`);

  const match = data.users.find(
    (u) => u.email?.trim().toLowerCase() === wanted.toLowerCase(),
  );
  if (!match) {
    throw new Error(
      `No Supabase auth user matches ${wanted}. Sign in once as that address (or run the v1 seed) first.`,
    );
  }
  return { userId: match.id, email: wanted };
}
