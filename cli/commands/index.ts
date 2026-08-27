import type { Command } from "commander";
import { register as registerEval } from "./eval";
import { register as registerGolden } from "./golden";

/**
 * Each CLI command lives in its own file and exports `register(program)`.
 * Add ONE line here per command; keep the list alphabetical to minimise merge
 * conflicts between parallel tasks.
 */
export const registrars: Array<(program: Command) => void> = [
  registerEval,
  registerGolden,
  // (tasks append here, e.g.)  registerScrape,
];
