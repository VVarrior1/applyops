/**
 * `applyops golden select --n 40` — build (or top up) the eval golden set.
 *
 * Owner-only by construction: the CLI runs with the database credentials, and
 * the snapshot it freezes is the owner's confirmed facts.
 */

import type { Command } from "commander";
import { eq } from "drizzle-orm";
import { getDb } from "../../src/db/client";
import { profiles, type Step } from "../../src/db/schema";
import {
  GOLDEN_MIN_DESCRIPTION_CHARS,
  goldenSetSummary,
  selectGoldenItems,
} from "../../src/eval/golden";

const STEPS = ["analyze", "fit", "tailor", "suggest", "judge", "extract_facts"] as const;

function parseStep(value: string): Step {
  if (!(STEPS as readonly string[]).includes(value)) {
    throw new Error(`Unknown step "${value}". Expected one of: ${STEPS.join(", ")}`);
  }
  return value as Step;
}

function parsePositiveInt(value: string, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${label} must be a positive integer, got "${value}"`);
  }
  return n;
}

/** Resolve whose facts get frozen: `--user <uuid>` or the single owner row. */
async function resolveUserId(
  db: ReturnType<typeof getDb>,
  explicit: string | undefined,
): Promise<string> {
  if (explicit) return explicit;

  const owners = await db
    .select({ userId: profiles.userId })
    .from(profiles)
    .where(eq(profiles.isOwner, true))
    .limit(2);

  if (owners.length === 0) {
    throw new Error(
      "No owner profile found. Sign in once as OWNER_EMAIL (or run the v1 seed) before selecting a golden set.",
    );
  }
  if (owners.length > 1) {
    throw new Error("More than one owner profile exists — pass --user <uuid> to disambiguate.");
  }
  return owners[0].userId;
}

function printDistribution(label: string, counts: Record<string, number>): void {
  const entries = Object.entries(counts);
  if (entries.length === 0) {
    console.log(`  ${label}: (none)`);
    return;
  }
  console.log(`  ${label}: ${entries.map(([k, v]) => `${k}=${v}`).join("  ")}`);
}

export function register(program: Command): void {
  const golden = program
    .command("golden")
    .description("Manage the eval golden set (spec §7)");

  golden
    .command("select")
    .description("Top the golden set up to N diverse items, freezing a profile snapshot")
    .option("-n, --n <count>", "target size of the golden set", "40")
    .option("-s, --step <step>", "pipeline step the set is for", "tailor")
    .option("-u, --user <uuid>", "profile whose confirmed facts are frozen (default: the owner)")
    .option(
      "--min-description <chars>",
      "postings shorter than this are only used to top the set up",
      String(GOLDEN_MIN_DESCRIPTION_CHARS),
    )
    .action(
      async (options: {
        n: string;
        step: string;
        user?: string;
        minDescription: string;
      }) => {
        const db = getDb();
        const step = parseStep(options.step);
        const n = parsePositiveInt(options.n, "--n");
        const minDescriptionChars = parsePositiveInt(
          options.minDescription,
          "--min-description",
        );
        const userId = await resolveUserId(db, options.user);

        const created = await selectGoldenItems(db, { n, step, userId, minDescriptionChars });
        const summary = await goldenSetSummary(db, step);

        console.log(
          `\nGolden set for "${step}": ${summary.total} items (${created.length} added this run)`,
        );
        console.log(
          `  substantive postings (≥ ${minDescriptionChars} chars): ${summary.substantive}/${summary.total}`,
        );
        console.log(`  graded by a human: ${summary.graded}/${summary.total}`);
        console.log(`  with a cached sample generation: ${summary.withSample}/${summary.total}`);
        printDistribution("vendor", summary.byVendor);
        printDistribution("remote", summary.byRemote);
        printDistribution("work auth", summary.byWorkAuth);
        printDistribution("title family", summary.byTitleFamily);

        if (summary.total < n) {
          console.log(
            `\nNote: only ${summary.total} of the requested ${n} items exist — the job corpus has no more unused postings. Re-run after the next scrape to top the set up.`,
          );
        }
        console.log("");
        process.exit(0);
      },
    );

  golden
    .command("status")
    .description("Print the golden set's size, grading progress and diversity")
    .option("-s, --step <step>", "pipeline step", "tailor")
    .action(async (options: { step: string }) => {
      const db = getDb();
      const step = parseStep(options.step);
      const summary = await goldenSetSummary(db, step);

      console.log(`\nGolden set for "${step}": ${summary.total} items`);
      console.log(`  graded by a human: ${summary.graded}/${summary.total}`);
      console.log(`  with a cached sample generation: ${summary.withSample}/${summary.total}`);
      printDistribution("vendor", summary.byVendor);
      printDistribution("remote", summary.byRemote);
      printDistribution("work auth", summary.byWorkAuth);
      printDistribution("title family", summary.byTitleFamily);
      console.log("");
      process.exit(0);
    });
}
