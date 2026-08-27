/**
 * `applyops eval --step tailor --model <id> [--items N] [--baseline]` — spec §7.
 *
 * Runs the golden set, prints a per-item table and the run summary, and writes
 * `eval-report.json` / `eval-report.html` next to the repo root (or `--out`).
 * The CI gate (Task 12) drives this same command.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import type { Command } from "commander";
import { getDb } from "../../src/db/client";
import type { Step } from "../../src/db/schema";
import { isProviderAvailable } from "../../src/llm/provider";
import { JUDGE_MODEL_ID, defaultModelForStep } from "../../src/llm/defaults";
import { parseModelId, type ModelId } from "../../src/llm/model-id";
import {
  renderConsoleSummary,
  renderConsoleTable,
  writeReports,
} from "../../src/eval/report";
import {
  evaluateGate,
  gateExitCode,
  renderGateSummaryMarkdown,
} from "../../src/eval/gate";
import { runEval } from "../../src/eval/runner";

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

function parseRate(value: string, label: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`${label} must be a fraction between 0 and 1, got "${value}"`);
  }
  return n;
}

/** The commit the run measured — stamped into `eval_runs.git_sha`. */
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

function assertProviderAvailable(modelId: ModelId, role: string): void {
  const { provider } = parseModelId(modelId);
  if (!isProviderAvailable(provider)) {
    throw new Error(
      `${role} model "${modelId}" needs a ${provider} API key, which is not set. ` +
        `Set it in .env.local or pass a model from an available provider.`,
    );
  }
}

export function register(program: Command): void {
  program
    .command("eval")
    .description("Run the eval harness over the golden set (spec §7)")
    .option("-s, --step <step>", "pipeline step to evaluate", "tailor")
    .option("-m, --model <id>", "model under test (default: the step's default)")
    .option("--judge-model <id>", "grader model (fixed by default)", JUDGE_MODEL_ID)
    .option("-i, --items <count>", "run only the first N items of the golden set")
    .option("--item <uuid...>", "run only these eval_items ids")
    .option("-b, --baseline", "mark this run as the baseline for future comparisons", false)
    .option("-o, --out <dir>", "directory for eval-report.{json,html}", process.cwd())
    .option("-c, --concurrency <n>", "items evaluated in parallel", "3")
    .option("--seed <n>", "bootstrap seed (determinism)")
    .option("--git-sha <sha>", "override the recorded commit")
    .option(
      "--gate",
      "apply the CI quality gate: exit 1 on a regression and write a job summary (spec §7)",
      false,
    )
    .option(
      "--max-hallucination-rate <rate>",
      "override the gate's hallucination ceiling (default 0.02)",
    )
    .action(
      async (options: {
        step: string;
        model?: string;
        judgeModel: string;
        items?: string;
        item?: string[];
        baseline: boolean;
        out: string;
        concurrency: string;
        seed?: string;
        gitSha?: string;
        gate: boolean;
        maxHallucinationRate?: string;
      }) => {
        const db = getDb();
        const step = parseStep(options.step);
        const modelId = (options.model ?? defaultModelForStep(step)) as ModelId;
        const judgeModelId = options.judgeModel as ModelId;

        // Fail before spending anything if a key is missing (Global
        // Constraints: a missing provider key is "unavailable", not a crash
        // halfway through a 40-item run).
        assertProviderAvailable(modelId, "Step");
        assertProviderAvailable(judgeModelId, "Judge");

        const limit = options.items ? parsePositiveInt(options.items, "--items") : undefined;
        const concurrency = parsePositiveInt(options.concurrency, "--concurrency");

        console.log(
          `\nEvaluating step "${step}" with ${modelId} (judge: ${judgeModelId})${
            options.baseline ? " — this run will be the new baseline" : ""
          }`,
        );

        const summary = await runEval(db, {
          step,
          modelId,
          judgeModelId,
          itemIds: options.item,
          baseline: options.baseline,
          gitSha: options.gitSha ?? currentGitSha(),
          limit,
          concurrency,
          seed: options.seed ? Number(options.seed) : undefined,
          userId: null, // owner CLI: budget bypassed (src/llm/budget.ts)
          onProgress: ({ index, total, row }) => {
            const score = row.meanScore == null ? "failed" : row.meanScore.toFixed(2);
            console.log(
              `  [${String(index + 1).padStart(String(total).length)}/${total}] ${score.padStart(6)}  ${row.title}${
                row.error ? `  — ${row.error}` : ""
              }`,
            );
          },
        });

        console.log(`\n${renderConsoleTable(summary.results)}`);
        console.log(renderConsoleSummary(summary));

        const written = writeReports(summary, summary.results, options.out);
        console.log(`\nReports:\n  ${written.json}\n  ${written.html}\n`);

        if (!options.gate) process.exit(0);

        // --- CI gate (spec §7, src/eval/gate.ts) -------------------------
        const gate = evaluateGate(summary, {
          maxHallucinationRate: options.maxHallucinationRate
            ? parseRate(options.maxHallucinationRate, "--max-hallucination-rate")
            : undefined,
        });

        for (const check of gate.checks) {
          const mark = check.status === "pass" ? "PASS" : check.status === "fail" ? "FAIL" : "SKIP";
          console.log(`  [${mark}] ${check.name}: ${check.detail}`);
        }
        console.log(`\nEval gate: ${gate.pass ? "PASS" : "FAIL"}\n`);

        // GitHub Actions surfaces this on the run page. Appended, never
        // overwritten: other steps in the same job write here too.
        const stepSummary = process.env.GITHUB_STEP_SUMMARY;
        if (stepSummary) {
          fs.appendFileSync(stepSummary, renderGateSummaryMarkdown(summary, gate), "utf8");
        }

        process.exit(gateExitCode(gate));
      },
    );
}
