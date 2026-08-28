import type { Command } from "commander";
import { sql } from "drizzle-orm";
import { getDb } from "../../src/db/client";
import { jobs } from "../../src/db/schema";
import { detectCountries } from "../../src/finders/country";
import { isEntryLevel, isRelevantRole, detectWorkAuth } from "../../src/finders/filters";

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
      let offset = 0, scanned = 0, entry = 0, relevant = 0;
      for (;;) {
        const rows = await db.select({ id: jobs.id, title: jobs.title, description: jobs.description, location: jobs.location }).from(jobs).orderBy(jobs.id).limit(batch).offset(offset);
        if (rows.length === 0) break;
        const payload = JSON.stringify(rows.map((r) => {
          const e = isEntryLevel(r.title, r.description ?? ""); const rel = isRelevantRole(r.title);
          if (e) entry += 1; if (rel) relevant += 1;
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
        process.stdout.write(`\rscanned ${scanned} · entry ${entry} · relevant ${relevant}`);
        if (rows.length < batch) break;
      }
      console.log(`\ndone: scanned ${scanned}, entry-level ${entry}, relevant-role ${relevant}`);
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
