/**
 * `applyops rank --user <email>|--all [--max <n>]` — spec §5/§6: score
 * active, entry-level, relevant jobs against one or every user's confirmed
 * facts and prefs via the `fit` LLM step (plus the free `keyword-v1`
 * baseline), stopping at that user's daily budget. The Jobs page's "Rank
 * more" button (`POST /api/rank`) calls the same `rankForUser()`.
 */
import { eq } from "drizzle-orm";
import type { Command } from "commander";
import { closeDb, getDirectDb } from "../../src/db/client";
import { profiles } from "../../src/db/schema";
import { getStorageAdminClient } from "../../src/profile/storage";
import { DEFAULT_MAX_JOBS, rankForUser } from "../../src/rank/rank";

interface RankCliOptions {
  user?: string;
  all?: boolean;
  max?: number;
}

/**
 * `profiles` carries no email — it's Supabase Auth's, not ours (see
 * `src/db/schema.ts`'s file header) — so resolving `--user <email>` means
 * the Auth admin API, the same move `src/db/seed-v1.ts` makes for
 * `OWNER_EMAIL`. `getStorageAdminClient()` is just a cached service-role
 * `SupabaseClient`; its name is about what it was first built for
 * (`src/profile/storage.ts`), not what it's limited to — `.auth.admin` is
 * available on any client built with the service-role key.
 */
async function loadEmailDirectory(): Promise<Map<string, string>> {
  const admin = getStorageAdminClient();
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) {
    throw new Error(`Could not list Supabase auth users: ${error.message}`);
  }
  const byId = new Map<string, string>();
  for (const user of data.users) {
    if (user.email) byId.set(user.id, user.email);
  }
  return byId;
}

export function register(program: Command): void {
  program
    .command("rank")
    .description(
      "Score active, entry-level, relevant jobs against a user's confirmed facts (spec §5 'fit' ranker).",
    )
    .option("-u, --user <email>", "rank for one user, by their sign-in email")
    .option("--all", "rank for every user who has signed in at least once")
    .option(
      "-m, --max <n>",
      `max jobs to score per user (default ${DEFAULT_MAX_JOBS})`,
      (v) => Number(v),
    )
    .action(async (opts: RankCliOptions) => {
      if (!opts.user && !opts.all) {
        throw new Error("Pass --user <email> or --all.");
      }
      if (opts.user && opts.all) {
        throw new Error("Pass either --user or --all, not both.");
      }
      if (opts.max !== undefined && (!Number.isFinite(opts.max) || opts.max <= 0)) {
        throw new Error(`--max must be a positive number, got "${opts.max}".`);
      }

      const db = getDirectDb();
      const emailById = await loadEmailDirectory();

      let targets: { userId: string; email: string }[];
      if (opts.all) {
        const rows = await db.select({ userId: profiles.userId }).from(profiles);
        targets = rows.map((row) => ({
          userId: row.userId,
          email: emailById.get(row.userId) ?? row.userId,
        }));
      } else {
        const wanted = opts.user!.trim().toLowerCase();
        const match = [...emailById.entries()].find(([, email]) => email.toLowerCase() === wanted);
        if (!match) {
          throw new Error(`No Supabase auth user found for "${opts.user}".`);
        }
        const [userId, email] = match;
        const [profile] = await db
          .select({ userId: profiles.userId })
          .from(profiles)
          .where(eq(profiles.userId, userId))
          .limit(1);
        if (!profile) {
          throw new Error(
            `"${email}" has a Supabase auth account but no ApplyOps profile yet — ` +
              "they need to sign in at applyops at least once before they can be ranked.",
          );
        }
        targets = [{ userId, email }];
      }

      if (targets.length === 0) {
        console.log("No users to rank for.");
        await closeDb();
        return;
      }

      for (const target of targets) {
        const result = await rankForUser(db, target.userId, {
          maxJobs: opts.max,
          log: (line) => console.log(`  [${target.email}] ${line}`),
        });
        console.log(
          `${target.email}: scored ${result.scored} · skipped ${result.skipped} · ` +
            `cost $${result.costUsd.toFixed(4)}`,
        );
      }

      await closeDb();
    });
}
