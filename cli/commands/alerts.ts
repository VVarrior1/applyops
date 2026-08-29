/**
 * `applyops alerts` — the hourly urgent tier (see `src/alerts/run.ts`).
 *
 * Run by `.github/workflows/alerts.yml`; also the way to test the whole
 * chain by hand without buzzing a phone:
 *
 *   npm run cli -- alerts --dry-run
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { closeDb, getDirectDb } from "../../src/db/client";
import {
  DEFAULT_FRESHNESS_HOURS,
  DEFAULT_SMS_THRESHOLD,
  runAlerts,
} from "../../src/alerts/run";
import { getStorageAdminClient } from "../../src/profile/storage";
import { profiles } from "../../src/db/schema";


/**
 * The recipient is the owner's phone from `profiles.contact`, not a flag or
 * an env var — one less place for a stale number to hide, and it means the
 * workflow needs no secret for it.
 */
async function resolveOwner(db: ReturnType<typeof getDirectDb>, email?: string) {
  const admin = getStorageAdminClient();
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw new Error(`Could not list Supabase auth users: ${error.message}`);

  const target = email
    ? data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase())
    : undefined;

  const rows = await db.select().from(profiles);
  const row = target
    ? rows.find((r) => r.userId === target.id)
    : rows.find((r) => r.isOwner) ?? rows[0];

  if (!row) throw new Error(email ? `No profile for ${email}.` : "No profile found.");

  const contact = row.contact as { phone?: string } | null;
  const raw = (contact?.phone ?? "").replace(/[^\d+]/g, "");
  if (!raw) throw new Error("No phone number on the profile — set one in /settings before enabling SMS alerts.");
  // North American 10-digit numbers get a +1; anything already E.164 is left alone.
  const phone = raw.startsWith("+") ? raw : raw.length === 10 ? `+1${raw}` : `+${raw}`;
  return { userId: row.userId, phone };
}

export function register(program: Command): void {
  program
    .command("alerts")
    .description(
      "Watch the community new-grad feeds and text the owner about strong, fresh, entry-level Canadian matches.",
    )
    .option("-n, --dry-run", "score everything and print what would be sent, but send nothing")
    .option("-u, --user <email>", "act for this user instead of the owner")
    .option(
      "-t, --threshold <n>",
      `minimum fit score to text (default ${DEFAULT_SMS_THRESHOLD})`,
      (v) => Number(v),
    )
    .option(
      "-f, --freshness <hours>",
      `how recently a posting must have gone up (default ${DEFAULT_FRESHNESS_HOURS})`,
      (v) => Number(v),
    )
    .option("--to <e164>", "override the recipient phone number")
    .action(
      async (opts: {
        dryRun?: boolean;
        user?: string;
        threshold?: number;
        freshness?: number;
        to?: string;
      }) => {
        if (opts.threshold !== undefined && (!Number.isFinite(opts.threshold) || opts.threshold < 0 || opts.threshold > 100)) {
          throw new Error(`--threshold must be between 0 and 100, got "${opts.threshold}".`);
        }

        const db = getDirectDb();
        try {
          const owner = await resolveOwner(db, opts.user);
          const sourcesPath = path.join(process.cwd(), "data/alert-sources.json");
          const sourcesJson = JSON.parse(readFileSync(sourcesPath, "utf8"));

          const summary = await runAlerts({
            db,
            userId: owner.userId,
            to: opts.to ?? owner.phone,
            sourcesJson,
            threshold: opts.threshold,
            freshnessHours: opts.freshness,
            dryRun: opts.dryRun,
            onProgress: (line) => console.log(line),
          });

          console.log(
            `\n${summary.fetched} listings · ${summary.shortlisted} shortlisted · ` +
              `${summary.descriptionMissing} unreadable · ${summary.rejectedEntryLevel} not entry level · ` +
              `${summary.scored} scored · ${summary.belowThreshold} below bar · ` +
              `${summary.sent} ${opts.dryRun ? "would be texted" : "texted"}`,
          );
          for (const error of summary.sourceErrors) console.log(`source error: ${error}`);
        } finally {
          await closeDb();
        }
        process.exit(0);
      },
    );
}
