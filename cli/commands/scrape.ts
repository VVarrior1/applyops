/**
 * `applyops scrape` — one pass of the finders over every active company
 * (spec §6). Also what `.github/workflows/scrape.yml` runs daily at 05:00
 * America/Edmonton.
 */
import type { Command } from "commander";
import { getDb } from "../../src/db/client";
import {
  DEFAULT_STALE_DAYS,
  DEFAULT_VENDOR_DELAY_MS,
  FINDER_VENDORS,
  parseVendors,
  runFinders,
} from "../../src/finders/run";

export function register(program: Command): void {
  program
    .command("scrape")
    .description("fetch current postings from every active company's ATS board")
    .option(
      "-v, --vendors <list>",
      `comma-separated subset of ${FINDER_VENDORS.join(",")}`,
    )
    .option("-m, --max-companies <n>", "stop after this many companies", (v) => Number(v))
    .option(
      "-d, --delay <ms>",
      `milliseconds between requests to the same vendor (default ${DEFAULT_VENDOR_DELAY_MS})`,
      (v) => Number(v),
    )
    .option("--no-mark-stale", `keep postings unseen for ${DEFAULT_STALE_DAYS} days active`)
    .action(
      async (opts: {
        vendors?: string;
        maxCompanies?: number;
        delay?: number;
        markStale: boolean;
      }) => {
        const started = Date.now();
        const summary = await runFinders(getDb(), {
          vendors: parseVendors(opts.vendors),
          maxCompanies: opts.maxCompanies,
          delayMs: opts.delay,
          staleDays: opts.markStale ? DEFAULT_STALE_DAYS : null,
          onProgress: (line) => console.log(line),
        });

        console.log(
          `\nscraped ${summary.companiesScanned} companies in ${(
            (Date.now() - started) / 1000
          ).toFixed(1)}s`,
        );
        console.log(
          `fetched ${summary.fetched} · inserted ${summary.inserted} · updated ${summary.updated} · ` +
            `errors ${summary.errors} · deactivated ${summary.deactivated}`,
        );
        process.exit(0);
      },
    );
}
