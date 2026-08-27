/**
 * `applyops apply <applicationId>` — spec §10.
 *
 * A thin shell around `applyToApplication()`: parse flags, open a direct DB
 * connection (this is a one-off operator script, not request-scoped app code),
 * print a human-readable summary, close the connection. All of the behaviour
 * lives in `src/agent/`.
 */

import type { Command } from "commander";
import { getDirectDb } from "../../src/db/client";
import { ApplyError, applyToApplication } from "../../src/agent/run";
import { isModelId, type ModelId } from "../../src/llm/model-id";

interface ApplyCliOptions {
  dryRun?: boolean;
  headless?: boolean;
  verbose?: boolean;
  maxSteps?: string;
  model?: string;
}

export function register(program: Command): void {
  program
    .command("apply")
    .description(
      "Open a job application in a real browser, fill it, and stop for your approval before submitting.",
    )
    .argument("<applicationId>", "applications.id (uuid)")
    .option("--dry-run", "Fill and screenshot the form, then decline at the approval gate")
    .option("--headless", "Run without a visible browser window (CI/Docker)")
    .option("--verbose", "Print each agent step")
    .option("--max-steps <n>", "Cap on model round trips", "35")
    .option("--model <id>", 'Model id, e.g. "google:gemini-3.7-flash"')
    .action(async (applicationId: string, options: ApplyCliOptions) => {
      // The Docker image sets APPLYOPS_FORCE_DRY_RUN=1: a container has no
      // human at the terminal to approve a submission, so spec §10's
      // "--dry-run default in Docker" is enforced here rather than trusted to
      // whoever writes the `docker run` line.
      const forcedDryRun = process.env.APPLYOPS_FORCE_DRY_RUN === "1";
      const dryRun = Boolean(options.dryRun) || forcedDryRun;
      if (forcedDryRun && !options.dryRun) {
        process.stdout.write("APPLYOPS_FORCE_DRY_RUN=1 — running as --dry-run.\n");
      }

      const maxSteps = Number.parseInt(options.maxSteps ?? "35", 10);
      if (!Number.isFinite(maxSteps) || maxSteps < 1) {
        throw new Error(`--max-steps must be a positive integer, got ${options.maxSteps}`);
      }

      let modelId: ModelId | undefined;
      if (options.model) {
        if (!isModelId(options.model)) {
          throw new Error(`--model must look like "<provider>:<model>", got ${options.model}`);
        }
        modelId = options.model;
      }

      const db = getDirectDb();
      try {
        const result = await applyToApplication(db, applicationId, {
          dryRun,
          headless: Boolean(options.headless),
          verbose: Boolean(options.verbose),
          maxSteps,
          modelId,
        });

        const cost = result.costUsd == null ? "unknown" : `$${result.costUsd.toFixed(4)}`;
        process.stdout.write(
          [
            "",
            `status        ${result.status}`,
            `ats           ${result.ats}`,
            `job           ${result.jobUrl}`,
            `ended on      ${result.url}`,
            `fast path     filled: ${result.fastPath.filled.join(", ") || "(nothing)"}`,
            `              remaining: ${result.fastPath.remaining.join(", ") || "(nothing)"}`,
            `agent         ${result.steps} step(s) on ${result.modelId}`,
            `tokens/cost   ${result.usage.inputTokens} in / ${result.usage.outputTokens} out — ${cost}`,
            `approval      ${result.approved ? "approved" : "not approved"}${result.approvalId ? ` (approvals.${result.approvalId})` : ""}`,
            `screenshot    ${result.screenshotPath ?? "(none)"}`,
            `notes         ${result.notes}`,
            "",
          ].join("\n"),
        );

        // Only a real, approved submission is a success for scripting purposes;
        // a dry run or a declined gate is a deliberate non-application.
        process.exitCode = result.status === "applied" ? 0 : 1;
      } catch (err) {
        if (err instanceof ApplyError) {
          process.stderr.write(`${err.message}\n`);
          process.exitCode = 1;
          return;
        }
        throw err;
      } finally {
        // postgres-js holds the socket open, which would keep the CLI alive
        // after the work is done. `$client` is on the concrete driver object
        // but not on drizzle's exported `PostgresJsDatabase` type, hence the
        // cast; a wrong cast here can only fail to close a connection in a
        // process that is exiting anyway.
        const client = (db as unknown as {
          $client?: { end?: (opts?: { timeout?: number }) => Promise<void> };
        }).$client;
        await client?.end?.({ timeout: 5 }).catch(() => {});
      }
    });
}
