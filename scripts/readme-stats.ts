/**
 * Prints the real, live numbers the README (spec §14 order) needs: eval
 * scorecard, funnel, benchmark table, finder coverage. Read-only — no writes.
 *
 * Run with `npx tsx scripts/readme-stats.ts` (needs `DATABASE_URL` in the
 * environment/`.env.local`). Output is meant to be read and hand-copied into
 * README.md, not parsed by anything — this is a reporting script, not part
 * of the app.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { closeDb, getDirectDb } from "../src/db/client";
import { loadBenchmarkBoard } from "../src/bench/bench";
import { loadPublicResults } from "../src/funnel/public-results";
import { companies, jobs } from "../src/db/schema";

function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n == null) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}

function fmtUsd(n: number | null | undefined, digits = 4): string {
  if (n == null) return "—";
  return `$${n.toFixed(digits)}`;
}

function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n == null) return "—";
  return n.toFixed(digits);
}

async function main() {
  const db = getDirectDb();

  console.log("\n=== EVAL SCORECARD / GATE / FUNNEL (from loadPublicResults, same as /results) ===\n");
  const results = await loadPublicResults(db);
  if (!results) {
    console.log("No owner profile found yet — /results has nothing to show.");
  } else {
    const { evalScorecard, gate, benchmarkHeadline, funnelByWeek, funnelByPromptVersion } = results;

    console.log("-- Eval scorecard (latest baseline, flagship step = tailor) --");
    if (evalScorecard) {
      console.log(`  run id:              ${evalScorecard.runId}`);
      console.log(`  model:               ${evalScorecard.modelId}`);
      console.log(`  items:               ${evalScorecard.itemCount}`);
      console.log(`  mean judge score:    ${fmtNum(evalScorecard.meanScore)} / 5`);
      console.log(`  hallucination rate:  ${fmtPct(evalScorecard.hallucinationRate, 2)}`);
      console.log(`  kappa:               ${evalScorecard.kappa == null ? "pending human grades" : fmtNum(evalScorecard.kappa)}`);
      console.log(`  cost:                ${fmtUsd(evalScorecard.costUsd, 2)} (${fmtUsd(evalScorecard.itemCount ? evalScorecard.costUsd! / evalScorecard.itemCount : null)}/item)`);
    } else {
      console.log("  none yet");
    }

    console.log("\n-- Latest gate run (candidate, non-baseline) --");
    if (gate) {
      console.log(`  run id:  ${gate.runId}`);
      console.log(`  model:   ${gate.modelId}`);
      console.log(`  items:   ${gate.itemCount}`);
      console.log(`  status:  ${gate.status.toUpperCase()}`);
      if (gate.reasons.length) console.log(`  reasons: ${gate.reasons.join("; ")}`);
    } else {
      console.log("  none yet");
    }

    console.log("\n-- Benchmark headline (latest baseline run of the default model, tailor) --");
    if (benchmarkHeadline) {
      console.log(`  model:               ${benchmarkHeadline.modelId}`);
      console.log(`  mean score:          ${fmtNum(benchmarkHeadline.meanScore)} / 5`);
      console.log(`  hallucination rate:  ${fmtPct(benchmarkHeadline.hallucinationRate, 2)}`);
      console.log(`  cost/item:           ${fmtUsd(benchmarkHeadline.costPerItemUsd)}`);
      console.log(`  p50 latency:         ${benchmarkHeadline.p50Ms ?? "—"} ms`);
      console.log(`  n:                   ${benchmarkHeadline.n}`);
    } else {
      console.log("  none yet");
    }

    console.log("\n-- Funnel by week (owner) --");
    for (const row of funnelByWeek) {
      console.log(
        `  ${row.key}: applied=${row.applied} responded=${row.responded} interviewing=${row.interviewing} offers=${row.offers} rejected=${row.rejected} ghosted=${row.ghosted} responseRate=${fmtPct(row.responseRate)} interviewRate=${fmtPct(row.interviewRate)}`,
      );
    }

    console.log("\n-- Funnel by prompt version (owner) --");
    for (const row of funnelByPromptVersion) {
      console.log(
        `  ${row.key}: applied=${row.applied} responded=${row.responded} interviewing=${row.interviewing} offers=${row.offers} responseRate=${fmtPct(row.responseRate)}`,
      );
    }
  }

  console.log("\n=== MODEL BENCHMARK BOARD (from loadBenchmarkBoard, same as /benchmark) ===\n");
  const board = await loadBenchmarkBoard(db);
  console.log(`judge: ${board.judgeModelId} (${board.judgeProvider})`);
  console.log(`last updated: ${board.lastUpdated}`);
  for (const group of board.steps) {
    console.log(`\n-- ${group.step} --`);
    for (const row of group.rows) {
      console.log(
        `  ${row.isDefault ? "* " : "  "}${row.modelId.padEnd(32)} mean=${fmtNum(row.meanScore)} ${
          row.meanCi ? `[${fmtNum(row.meanCi[0])}-${fmtNum(row.meanCi[1])}]` : ""
        } halluc=${fmtPct(row.hallucinationRate, 1)} cost/item=${fmtUsd(row.costPerItemUsd)} n=${row.n} p50=${row.p50Ms}ms`,
      );
    }
  }

  console.log("\n=== FINDER COVERAGE (live jobs table) ===\n");
  const [totals] = await db
    .select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where ${jobs.active})::int`,
      entryLevelRelevant: sql<number>`count(*) filter (where ${jobs.isEntryLevel} and ${jobs.isRelevantRole})::int`,
      hiresCanadians: sql<number>`count(*) filter (where ${jobs.workAuthSignal} = 'hires_canadians')::int`,
      tnFriendly: sql<number>`count(*) filter (where ${jobs.workAuthSignal} = 'tn_friendly')::int`,
      needsUsAuth: sql<number>`count(*) filter (where ${jobs.workAuthSignal} = 'needs_us_auth')::int`,
      unclear: sql<number>`count(*) filter (where ${jobs.workAuthSignal} = 'unclear' or ${jobs.workAuthSignal} is null)::int`,
    })
    .from(jobs);
  console.log(`  total postings:              ${totals.total}`);
  console.log(`  active:                      ${totals.active}`);
  console.log(`  entry-level & relevant role: ${totals.entryLevelRelevant}`);
  console.log(`  work_auth hires_canadians:   ${totals.hiresCanadians}`);
  console.log(`  work_auth tn_friendly:       ${totals.tnFriendly}`);
  console.log(`  work_auth needs_us_auth:     ${totals.needsUsAuth}`);
  console.log(`  work_auth unclear:           ${totals.unclear}`);

  const byVendor = await db
    .select({
      vendor: companies.atsVendor,
      companies: sql<number>`count(distinct ${companies.id})::int`,
      jobs: sql<number>`count(${jobs.id})::int`,
    })
    .from(companies)
    .leftJoin(jobs, sql`${jobs.companyId} = ${companies.id} and ${jobs.active}`)
    .groupBy(companies.atsVendor)
    .orderBy(sql`count(${jobs.id}) desc`);
  console.log("\n  by vendor (active jobs):");
  for (const row of byVendor) {
    console.log(`    ${row.vendor.padEnd(16)} companies=${row.companies} active_jobs=${row.jobs}`);
  }

  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
