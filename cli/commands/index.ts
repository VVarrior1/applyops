import type { Command } from "commander";

/**
 * Each CLI command lives in its own file and exports `register(program)`.
 * Add ONE line here per command; keep the list alphabetical to minimise merge
 * conflicts between parallel tasks.
 */
export const registrars: Array<(program: Command) => void> = [
  // (tasks append here, e.g.)  registerScrape,
];
