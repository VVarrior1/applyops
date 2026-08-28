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
import { CANADA_COMPANIES } from "../../src/finders/canada-companies";
import {
  careersUrlFor,
  existingVendorSlugKeys,
  importOpenJobs,
  importV1Allowlists,
  upsertCompanies,
  type CompanyCandidate,
  type ImportResult,
} from "../../src/finders/companies";
import { discoverAts, PROBE_VENDORS, type DiscoverHit } from "../../src/finders/discover";

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

  companies
    .command("discover-canada")
    .description(
      "probe the curated Canadian-employer list against Greenhouse/Lever/Ashby/Recruitee/" +
        "SmartRecruiters' public endpoints and upsert any hits (free HTTP only, no LLM/paid API)",
    )
    .option("-l, --limit <n>", "probe only the first N companies from the curated list", (v) =>
      Number(v),
    )
    .option("--dry-run", "probe and print hits without writing to the database")
    .action(async (opts: { limit?: number; dryRun?: boolean }) => {
      const list =
        opts.limit && opts.limit > 0 ? CANADA_COMPANIES.slice(0, opts.limit) : CANADA_COMPANIES;

      console.log(
        `probing ${list.length} curated Canadian companies across ${PROBE_VENDORS.join(", ")}…`,
      );

      const db = getDb();
      const existingKeys = await existingVendorSlugKeys(db);

      const started = Date.now();
      let probed = 0;
      const results = await Promise.all(
        list.map(async (company) => {
          const hit = await discoverAts(company);
          probed++;
          if (probed % 25 === 0 || probed === list.length) {
            console.log(`  probed ${probed}/${list.length}…`);
          }
          return hit;
        }),
      );
      const hits = results.filter((r): r is DiscoverHit => r !== null);
      const elapsedS = ((Date.now() - started) / 1000).toFixed(1);

      const alreadyPresent = hits.filter((h) =>
        existingKeys.has(`${h.vendor}:${h.slug.toLowerCase()}`),
      );
      const newHits = hits.filter((h) => !alreadyPresent.includes(h));

      if (hits.length > 0) {
        console.log("\nhits (name · vendor · slug · jobs):");
        for (const h of [...hits].sort((a, b) => b.jobCount - a.jobCount)) {
          const flag = existingKeys.has(`${h.vendor}:${h.slug.toLowerCase()}`)
            ? " (already present)"
            : "";
          console.log(`  ${h.name} · ${h.vendor} · ${h.slug} · ${h.jobCount}${flag}`);
        }

        const byVendor = new Map<string, number>();
        for (const h of hits) byVendor.set(h.vendor, (byVendor.get(h.vendor) ?? 0) + 1);
        console.log(
          "\nby vendor: " +
            [...byVendor.entries()].map(([v, n]) => `${v}=${n}`).join(" · "),
        );
      }

      let inserted = 0;
      let linked = 0;
      if (!opts.dryRun && newHits.length > 0) {
        const candidates: CompanyCandidate[] = newHits.map((h) => ({
          name: h.name,
          atsVendor: h.vendor,
          atsSlug: h.slug,
          careersUrl: careersUrlFor(h.vendor, h.slug),
          source: "canada_curated",
        }));
        const result = await upsertCompanies(db, candidates);
        inserted = result.inserted;
        linked = result.linked;
      }

      console.log(
        `\nprobed ${list.length} · found ${hits.length} · already present ${alreadyPresent.length} · ` +
          `new ${newHits.length}` +
          (opts.dryRun
            ? " (dry run — nothing written)"
            : ` · inserted ${inserted} · linked ${linked}`) +
          ` · ${elapsedS}s`,
      );
      process.exit(0);
    });
}
