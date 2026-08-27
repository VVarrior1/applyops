/**
 * `applyops companies import` — populate the `companies` table the nightly
 * scrape walks (spec §6).
 *
 * Both sources are idempotent, so this is safe to re-run; the printed counts
 * distinguish rows created, existing v1-seed rows that were *linked* to a
 * board, and candidates that were already there.
 */
import type { Command } from "commander";
import { getDb } from "../../src/db/client";
import {
  importOpenJobs,
  importV1Allowlists,
  type ImportResult,
} from "../../src/finders/companies";

const SOURCES = ["v1", "openjobs", "all"] as const;
type Source = (typeof SOURCES)[number];

function print(label: string, result: ImportResult): void {
  console.log(
    `${label}: ${result.inserted} inserted · ${result.linked} linked to existing rows · ` +
      `${result.existing} already present` +
      (result.unknownVendor ? ` · ${result.unknownVendor} links on unsupported ATSs skipped` : ""),
  );
}

export function register(program: Command): void {
  const companies = program
    .command("companies")
    .description("manage the company → ATS board list");

  companies
    .command("import")
    .description("import companies from v1's allow-lists and/or the OpenJobs dataset")
    .option("-s, --source <source>", `one of ${SOURCES.join(" | ")}`, "all")
    .option("--no-tech-only", "keep non-software companies from OpenJobs too")
    .option("--v1-path <path>", "path to the v1 repo checkout (default $V1_REPO_PATH)")
    .action(async (opts: { source: string; techOnly: boolean; v1Path?: string }) => {
      const source = opts.source as Source;
      if (!SOURCES.includes(source)) {
        throw new Error(`--source must be one of ${SOURCES.join(", ")}`);
      }
      const db = getDb();
      const totals: ImportResult = { inserted: 0, linked: 0, existing: 0, unknownVendor: 0 };

      if (source === "v1" || source === "all") {
        const result = await importV1Allowlists(db, { repoPath: opts.v1Path });
        print("v1 allow-lists", result);
        for (const k of Object.keys(totals) as Array<keyof ImportResult>) totals[k] += result[k];
      }
      if (source === "openjobs" || source === "all") {
        const result = await importOpenJobs(db, { techOnly: opts.techOnly });
        print(`OpenJobs (${opts.techOnly ? "software/tech only" : "all industries"})`, result);
        for (const k of Object.keys(totals) as Array<keyof ImportResult>) totals[k] += result[k];
      }
      if (source === "all") print("total", totals);
      process.exit(0);
    });
}
