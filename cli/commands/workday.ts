/**
 * `applyops workday` — Workday tenant management (spec: Workday finder).
 *
 * `seed` upserts the curated `WORKDAY_TENANTS` list (src/finders/
 * workday-tenants.ts) into `companies` so `applyops scrape --vendors
 * workday` has something to walk. `probe` is the one-off tool for adding a
 * new tenant by hand: paste any URL under a company's Workday careers site
 * and it derives `{tenant, host, site}` and confirms the `/jobs` endpoint
 * actually answers, without touching the database.
 *
 * Self-contained on purpose: `src/finders/companies.ts` and
 * `cli/commands/companies.ts` are being edited concurrently elsewhere, so
 * this file talks to the `companies` table directly with Drizzle rather than
 * importing their `upsertCompanies`/`CompanyCandidate` helpers (whose
 * `source` union doesn't know about `"workday_seed"` and shouldn't have to).
 */
import type { Command } from "commander";
import { getDb } from "../../src/db/client";
import { companies } from "../../src/db/schema";
import {
  parseWorkdayUrl,
  probeWorkdayTenant,
  workdayBoardUrl,
} from "../../src/finders/workday";
import { WORKDAY_TENANTS, type WorkdayTenant } from "../../src/finders/workday-tenants";

const SOURCE = "workday_seed";

type UpsertResult = { inserted: number; existing: number; renamed: number };

/**
 * Inserts every tenant not already present as `(workday, tenant/site)`.
 * `companies` also has a unique `lower(name)` index, and several tenants here
 * share a name with an existing `ats_vendor = 'other'` row from v1's Workday
 * allow-list import (same company, no working finder at the time) — those
 * get disambiguated to `"<name> (workday)"` rather than colliding, mirroring
 * `upsertCompanies`' own name-clash handling in companies.ts.
 */
async function upsertWorkdayTenants(
  db: ReturnType<typeof getDb>,
  tenants: WorkdayTenant[],
): Promise<UpsertResult> {
  const existingRows = await db
    .select({ name: companies.name, atsVendor: companies.atsVendor, atsSlug: companies.atsSlug })
    .from(companies);

  const byVendorSlug = new Set<string>();
  const byNameLower = new Set<string>();
  for (const row of existingRows) {
    if (row.atsSlug) byVendorSlug.add(`${row.atsVendor}:${row.atsSlug.toLowerCase()}`);
    byNameLower.add(row.name.toLowerCase());
  }

  let existing = 0;
  let renamed = 0;
  const toInsert: Array<{
    name: string;
    atsVendor: "workday";
    atsSlug: string;
    careersUrl: string;
    source: string;
  }> = [];

  for (const t of tenants) {
    const slug = `${t.tenant}/${t.site}`;
    const key = `workday:${slug.toLowerCase()}`;
    if (byVendorSlug.has(key)) {
      existing++;
      continue;
    }
    byVendorSlug.add(key);

    let name = t.name;
    if (byNameLower.has(name.toLowerCase())) {
      name = `${t.name} (workday)`;
      renamed++;
      if (byNameLower.has(name.toLowerCase())) name = `${t.name} (workday/${t.tenant})`;
    }
    byNameLower.add(name.toLowerCase());

    toInsert.push({
      name,
      atsVendor: "workday",
      atsSlug: slug,
      careersUrl: workdayBoardUrl(t.tenant, t.host, t.site),
      source: SOURCE,
    });
  }

  let inserted = 0;
  if (toInsert.length > 0) {
    const rows = await db
      .insert(companies)
      .values(toInsert)
      // Belt-and-suspenders against a concurrent seed run; the in-memory
      // dedupe above already prevents this within one run.
      .onConflictDoNothing()
      .returning({ id: companies.id });
    inserted = rows.length;
  }

  return { inserted, existing, renamed };
}

export function register(program: Command): void {
  const workday = program.command("workday").description("manage Workday tenant boards");

  workday
    .command("seed")
    .description(`upsert the ${WORKDAY_TENANTS.length} verified Workday tenants into companies`)
    .action(async () => {
      const db = getDb();
      const result = await upsertWorkdayTenants(db, WORKDAY_TENANTS);
      console.log(
        `workday seed: ${result.inserted} inserted · ${result.existing} already present` +
          (result.renamed ? ` · ${result.renamed} renamed to avoid a name clash` : "") +
          ` (of ${WORKDAY_TENANTS.length} tenants)`,
      );
      process.exit(0);
    });

  workday
    .command("probe")
    .description("derive tenant/host/site from a Workday careers URL and test its /jobs endpoint")
    .argument("<url>", "any URL under a Workday careers site, e.g. https://x.wd3.myworkdayjobs.com/Y")
    .action(async (url: string) => {
      const parsed = parseWorkdayUrl(url);
      if (!parsed) {
        console.error(
          `could not find a "{tenant}.{host}.myworkdayjobs.com" host in ${JSON.stringify(url)}`,
        );
        process.exit(1);
        return;
      }
      const { tenant, host, site } = parsed;
      console.log(`tenant=${tenant} host=${host} site=${site}`);
      console.log(`board url: ${workdayBoardUrl(tenant, host, site)}`);
      console.log(`ats_slug for companies: ${tenant}/${site}`);
      try {
        const total = await probeWorkdayTenant(tenant, host, site);
        if (total === null) {
          console.log("no response (404/410/422) — this tenant/site does not exist");
          process.exit(1);
          return;
        }
        console.log(`OK — ${total} posting(s) currently listed`);
        process.exit(0);
      } catch (err) {
        console.error(`probe failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
