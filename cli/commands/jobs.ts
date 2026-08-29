import type { Command } from "commander";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../../src/db/client";
import { jobs } from "../../src/db/schema";
import { detectCountries } from "../../src/finders/country";
import {
  classifyEntryLevel,
  detectWorkAuth,
  hasUsableDescription,
  isRelevantRole,
  MIN_USABLE_DESCRIPTION_CHARS,
} from "../../src/finders/filters";
import { sleep } from "../../src/finders/http";
import { MAX_DESCRIPTION_CHARS } from "../../src/finders/run";
import { fetchSmartRecruitersDescription } from "../../src/finders/smartrecruiters";
import { fetchWorkdayDescriptionByUrl } from "../../src/finders/workday";

/** One row of `backfill-descriptions`' repair set. */
type BackfillRow = {
  id: string;
  url: string;
  title: string;
  location: string | null;
  external_id: string | null;
  ats_vendor: string;
  ats_slug: string | null;
};

/** Vendors whose per-posting detail endpoint `backfill-descriptions` can call. */
const BACKFILLABLE_VENDORS = ["workday", "smartrecruiters"];
/** ≥150 ms between any two requests to the SAME board — the finders' own politeness floor. */
const BACKFILL_DELAY_MS = 150;
/** How many companies' boards are worked at once. Each stays sequential internally. */
const BACKFILL_CONCURRENCY = 8;

/**
 * `applyops jobs backfill-countries` — detect countries for every job whose
 * `countries` is still NULL (or all jobs with --all). Pure string parsing, no
 * LLM calls; ~50k rows takes well under a minute.
 */
export function register(program: Command): void {
  const cmd = program.command("jobs").description("Job-table maintenance");

  cmd
    .command("backfill-flags")
    .description("Recompute is_entry_level / is_relevant_role / work_auth_signal for every job from title+description (no LLM)")
    .option("--batch <n>", "rows per batch", "2000")
    .action(async (opts: { batch: string }) => {
      const db = getDb();
      const batch = Math.max(100, Number(opts.batch) || 2000);
      let offset = 0, scanned = 0, entryTrue = 0, entryFalse = 0, entryNull = 0, relevant = 0;
      for (;;) {
        const rows = await db.select({ id: jobs.id, title: jobs.title, description: jobs.description, location: jobs.location }).from(jobs).orderBy(jobs.id).limit(batch).offset(offset);
        if (rows.length === 0) break;
        const payload = JSON.stringify(rows.map((r) => {
          // Three-valued (src/finders/filters.ts): null = "no posting body was
          // ever fetched and the title gave nothing away". `->>'e'` yields SQL
          // NULL for a JSON null, so `::boolean` stores it as NULL — which is
          // exactly what `is_entry_level` (a nullable column) means by it.
          const e = classifyEntryLevel(r.title, r.description); const rel = isRelevantRole(r.title);
          if (e === true) entryTrue += 1; else if (e === false) entryFalse += 1; else entryNull += 1;
          if (rel) relevant += 1;
          return { id: r.id, e, rel, wa: detectWorkAuth(`${r.location ?? ""} ${r.description ?? ""}`) };
        }));
        await db.execute(sql`
          update jobs as j
             set is_entry_level = (v.item->>'e')::boolean,
                 is_relevant_role = (v.item->>'rel')::boolean,
                 work_auth_signal = (v.item->>'wa')::work_auth_signal
            from jsonb_array_elements(${payload}::jsonb) as v(item)
           where j.id = (v.item->>'id')::uuid
        `);
        scanned += rows.length; offset += rows.length;
        process.stdout.write(`\rscanned ${scanned} · entry ${entryTrue} · unknown ${entryNull} · relevant ${relevant}`);
        if (rows.length < batch) break;
      }
      console.log(`\ndone: scanned ${scanned}, entry-level ${entryTrue}, not-entry-level ${entryFalse}, unknown ${entryNull}, relevant-role ${relevant}`);
      process.exit(0);
    });

  cmd
    .command("backfill-descriptions")
    .description("Re-fetch posting bodies for active jobs stored with only their title (no LLM), then recompute their flags")
    .option("--vendors <list>", "comma-separated: workday,smartrecruiters", "workday,smartrecruiters")
    .option("--limit <n>", "max postings to re-fetch", "5000")
    .option("--all-roles", "include titles that don't pass isRelevantRole", false)
    .action(async (opts: { vendors: string; limit: string; allRoles: boolean }) => {
      const db = getDb();
      const wanted = opts.vendors.split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
      const unknown = wanted.filter((v) => !BACKFILLABLE_VENDORS.includes(v));
      if (unknown.length) {
        console.error(`Unknown vendor(s): ${unknown.join(", ")}. Known: ${BACKFILLABLE_VENDORS.join(", ")}`);
        process.exit(1);
      }
      const limit = Math.max(1, Number(opts.limit) || 5000);

      // The repair set: active postings whose stored `description` is the
      // finder's title-only placeholder (see hasUsableDescription). Restricted
      // to relevant-role titles by default — that is the same set the finders
      // themselves fetch details for, and it is what the Jobs page shows.
      const rows = await db.execute<BackfillRow>(sql`
        select j.id, j.url, j.title, j.location, j.external_id, c.ats_vendor, c.ats_slug
          from jobs j join companies c on c.id = j.company_id
         where j.active = true
           and c.ats_vendor in ${sql.raw(`(${wanted.map((v) => `'${v}'`).join(", ")})`)}
           and (j.description is null
                or length(j.description) < ${MIN_USABLE_DESCRIPTION_CHARS}
                or lower(btrim(j.description)) = lower(btrim(j.title)))
           ${opts.allRoles ? sql`` : sql`and j.is_relevant_role = true`}
         order by j.posted_at desc nulls last
         limit ${limit}
      `);

      console.log(`${rows.length} postings to re-fetch (${wanted.join(", ")})`);
      let done = 0, fetched = 0, failed = 0, updated = 0;
      let entryTrue = 0, entryFalse = 0, entryNull = 0;

      // Politeness is PER BOARD, not global: the ≥150 ms floor is about not
      // hammering one company's ATS, and these rows span hundreds of separate
      // tenants. So group by company and run a bounded number of company
      // workers concurrently, each strictly sequential with the delay — the
      // same shape `runFinders` uses (one sequential worker per vendor,
      // vendors concurrent). Sequential-across-everything measured at ~4.8 s
      // per posting end to end, i.e. ~3 h for a 2.4k-row repair set; almost
      // all of that is waiting on someone else's server.
      const byCompany = new Map<string, BackfillRow[]>();
      for (const row of rows) {
        const key = `${row.ats_vendor}:${row.ats_slug ?? row.id}`;
        const list = byCompany.get(key) ?? [];
        list.push(row);
        byCompany.set(key, list);
      }
      const queue = [...byCompany.values()];

      async function worker(): Promise<void> {
        for (;;) {
          const group = queue.shift();
          if (!group) return;
          for (const [i, row] of group.entries()) {
            if (i > 0) await sleep(BACKFILL_DELAY_MS);
            let description: string | null = null;
            try {
              if (row.ats_vendor === "workday") {
                description = await fetchWorkdayDescriptionByUrl(row.url);
              } else if (row.ats_vendor === "smartrecruiters" && row.ats_slug && row.external_id) {
                description = await fetchSmartRecruitersDescription(row.ats_slug, row.external_id);
              }
            } catch {
              // A dead posting or a flaky board must not abort the run.
              description = null;
            }

            if (!description || !hasUsableDescription(description, row.title)) {
              failed += 1;
            } else {
              fetched += 1;
              const clean = description.replace(/\u0000/g, "").slice(0, MAX_DESCRIPTION_CHARS);
              const e = classifyEntryLevel(row.title, clean);
              if (e === true) entryTrue += 1; else if (e === false) entryFalse += 1; else entryNull += 1;
              // Drizzle's update builder, not raw `sql` — `countries` is a
              // `text[]` and a raw-tagged JS array interpolates as an empty
              // tuple `()`, which Postgres rejects.
              await db
                .update(jobs)
                .set({
                  description: clean,
                  isEntryLevel: e,
                  isRelevantRole: isRelevantRole(row.title),
                  workAuthSignal: detectWorkAuth(`${row.location ?? ""} ${clean}`),
                  countries: detectCountries(row.location, clean),
                })
                .where(eq(jobs.id, row.id));
              updated += 1;
            }
            done += 1;
            if (done % 25 === 0 || done === rows.length) {
              process.stdout.write(`\r${done}/${rows.length} · fetched ${fetched} · no body ${failed}`);
            }
          }
        }
      }

      await Promise.all(
        Array.from({ length: Math.min(BACKFILL_CONCURRENCY, queue.length) }, () => worker()),
      );

      console.log(
        `\ndone: ${rows.length} scanned, ${updated} descriptions written, ${failed} still bodyless.\n` +
          `re-classified: entry-level ${entryTrue}, not-entry-level ${entryFalse}, unknown ${entryNull}`,
      );
      process.exit(0);
    });

  cmd
    .command("backfill-countries")
    .description("Detect ISO country codes from job locations and store them in jobs.countries")
    .option("--all", "re-detect for every job, not just rows where countries is NULL", false)
    .option("--batch <n>", "rows per batch", "5000")
    .action(async (opts: { all: boolean; batch: string }) => {
      const db = getDb();
      const batch = Math.max(100, Number(opts.batch) || 5000);
      let offset = 0;
      let scanned = 0;
      let known = 0;
      for (;;) {
        const rows = await db
          .select({ id: jobs.id, location: jobs.location, description: jobs.description })
          .from(jobs)
          .where(opts.all ? sql`true` : sql`${jobs.countries} is null`)
          .orderBy(jobs.id)
          .limit(batch)
          .offset(opts.all ? offset : 0);
        if (rows.length === 0) break;
        const ids: string[] = [];
        const values: string[][] = [];
        for (const r of rows) {
          const codes = detectCountries(r.location, r.description);
          ids.push(r.id);
          values.push(codes);
          if (codes.length > 0) known += 1;
        }
        // One UPDATE per batch. Drizzle expands JS arrays into `$1, $2, ...`
        // lists, so the batch travels as ONE jsonb parameter and is unpacked
        // server-side with jsonb_array_elements.
        const payload = JSON.stringify(ids.map((id, i) => ({ id, codes: values[i] })));
        await db.execute(sql`
          update jobs as j
             set countries = coalesce((select array_agg(e) from jsonb_array_elements_text(v.item->'codes') as e), '{}'::text[])
            from jsonb_array_elements(${payload}::jsonb) as v(item)
           where j.id = (v.item->>'id')::uuid
        `);
        scanned += rows.length;
        offset += rows.length;
        process.stdout.write(`\rscanned ${scanned} · with country ${known}`);
        if (rows.length < batch) break;
      }
      console.log(`\ndone: scanned ${scanned}, ${known} with a detectable country, ${scanned - known} unknown/anywhere`);
      process.exit(0);
    });
}
