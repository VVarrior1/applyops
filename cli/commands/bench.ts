/**
 * `applyops bench --steps analyze,fit,tailor,suggest --models <csv> [--items N]`
 * — spec §8.
 *
 * Runs every step × model pair over the golden set, writes one `eval_runs` row
 * per pair (which is what the public `/benchmark` page reads), prints the
 * comparison table, and ends with the exact `src/llm/defaults.ts` line each
 * step's quality-per-dollar winner justifies — including the run id, so the
 * comment in that file always cites a run someone can look up.
 *
 * Models whose provider has no key configured are reported as skipped before
 * anything is spent; nothing here ever fails half way through because
 * `OPENAI_API_KEY` is absent.
 */

import { execFileSync } from "node:child_process";
import type { Command } from "commander";
import {
  BENCH_STEPS,
  DEFAULT_BENCH_MODELS,
  bestByValue,
  benchProviderAvailability,
  isBenchStep,
  planBench,
  renderBenchTable,
  runBench,
  type BenchStep,
} from "../../src/bench/bench";
import { closeDb, getDb } from "../../src/db/client";
import { JUDGE_MODEL_ID } from "../../src/llm/defaults";
import { parseModelId, type ModelId } from "../../src/llm/model-id";
import { isProviderAvailable } from "../../src/llm/provider";

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseSteps(value: string): BenchStep[] {
  const steps = parseCsv(value);
  if (steps.length === 0) {
    throw new Error(`--steps needs at least one of: ${BENCH_STEPS.join(", ")}`);
  }
  for (const step of steps) {
    if (!isBenchStep(step)) {
      throw new Error(
        `Unknown step "${step}". The benchmark covers: ${BENCH_STEPS.join(", ")}.`,
      );
    }
  }
  // De-duplicate but keep the order given.
  return [...new Set(steps)] as BenchStep[];
}

function parsePositiveInt(value: string, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${label} must be a positive integer, got "${value}"`);
  }
  return n;
}

/** The commit the benchmark measured — stamped into `eval_runs.git_sha`. */
function currentGitSha(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function register(program: Command): void {
  program
    .command("bench")
    .description("Benchmark models per pipeline step over the golden set (spec §8)")
    .option("-s, --steps <csv>", "steps to benchmark", BENCH_STEPS.join(","))
    .option("-m, --models <csv>", "models to compare", DEFAULT_BENCH_MODELS.join(","))
    .option("-i, --items <count>", "run only the first N items of the golden set")
    .option("--item <uuid...>", "run only these eval_items ids")
    .option("--judge-model <id>", "grader model (fixed by default)", JUDGE_MODEL_ID)
    .option("-c, --concurrency <n>", "items evaluated in parallel", "3")
    .option("--seed <n>", "bootstrap seed (determinism)")
    .option("--git-sha <sha>", "override the recorded commit")
    .action(
      async (options: {
        steps: string;
        models: string;
        items?: string;
        item?: string[];
        judgeModel: string;
        concurrency: string;
        seed?: string;
        gitSha?: string;
      }) => {
        const steps = parseSteps(options.steps);
        const models = parseCsv(options.models);
        const judgeModelId = options.judgeModel as ModelId;
        const limit = options.items ? parsePositiveInt(options.items, "--items") : undefined;
        const concurrency = parsePositiveInt(options.concurrency, "--concurrency");

        // The judge is not a contestant: if it cannot run, nothing can be
        // graded and there is no point spending anything on the step models.
        const judgeProvider = parseModelId(judgeModelId).provider;
        if (!isProviderAvailable(judgeProvider)) {
          throw new Error(
            `Judge model "${judgeModelId}" needs a ${judgeProvider} API key, which is not set.`,
          );
        }

        const plan = planBench({ models });
        const availability = benchProviderAvailability();

        console.log(
          `\nProviders: ${Object.entries(availability)
            .map(([provider, ok]) => `${provider} ${ok ? "ok" : "no key"}`)
            .join(", ")}`,
        );
        for (const skip of plan.skipped) {
          console.log(`  skipped ${skip.modelId} — ${skip.reason}`);
        }
        if (plan.models.length === 0) {
          throw new Error("No runnable models. Every requested model was skipped.");
        }

        console.log(
          `\nBenchmarking ${plan.models.length} model(s) × ${steps.length} step(s) = ` +
            `${plan.models.length * steps.length} runs of ${limit ?? "the full"} golden ` +
            `item(s), judged by ${judgeModelId}.\n`,
        );

        const db = getDb();
        try {
          const { runs, skipped } = await runBench(db, {
            steps,
            models: plan.models,
            itemIds: options.item,
            limit,
            judgeModelId,
            concurrency,
            gitSha: options.gitSha ?? currentGitSha(),
            seed: options.seed ? Number(options.seed) : undefined,
            onRunStart: ({ step, modelId, index, total }) =>
              console.log(`[${index + 1}/${total}] ${step} × ${modelId}`),
            onItem: ({ index, total, row }) => {
              const score = row.meanScore == null ? "failed" : row.meanScore.toFixed(2);
              console.log(
                `    [${String(index + 1).padStart(String(total).length)}/${total}] ` +
                  `${score.padStart(6)}  ${row.title}${row.error ? `  — ${row.error}` : ""}`,
              );
            },
          });

          console.log(`\n${renderBenchTable(runs)}\n`);

          if (skipped.length > 0) {
            console.log("Skipped:");
            for (const skip of skipped) {
              console.log(`  ${skip.modelId} — ${skip.reason}`);
            }
            console.log("");
          }

          const winners = bestByValue(runs);
          if (winners.length > 0) {
            const today = new Date().toISOString().slice(0, 10);
            console.log(
              "Best quality-per-dollar per step (cheapest model not measurably\n" +
                "worse than the best) — src/llm/defaults.ts:",
            );
            for (const winner of winners) {
              console.log(
                `  // chosen by eval_run ${winner.runId} on ${today}\n` +
                  `  ${winner.step}: "${winner.modelId}",` +
                  `   // mean ${winner.meanScore.toFixed(2)} of a best ` +
                  `${winner.bestMeanScore.toFixed(2)}, ` +
                  `$${winner.costPerItemUsd.toFixed(5)}/item, ` +
                  `${winner.contenders} contender(s)`,
              );
            }
            console.log("");
          }

          console.log("Public page: /benchmark (cached 1h)\n");
        } finally {
          // postgres-js holds its socket open; without this the CLI hangs
          // instead of exiting (src/db/client.ts).
          await closeDb();
        }
      },
    );
}
