import type { Command } from "commander";
import { register as registerCompanies } from "./companies";
import { register as registerOutcome } from "./outcome";
import { register as registerScrape } from "./scrape";

/**
 * Each CLI command lives in its own file and exports `register(program)`.
 * Add ONE line here per command; keep the list alphabetical to minimise merge
 * conflicts between parallel tasks.
 */
export const registrars: Array<(program: Command) => void> = [
  registerCompanies,
  registerOutcome,
  registerScrape,
];
