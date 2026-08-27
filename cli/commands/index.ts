import type { Command } from "commander";
import { register as registerApply } from "./apply";
import { register as registerEval } from "./eval";
import { register as registerGolden } from "./golden";
import { register as registerOutcome } from "./outcome";

/**
 * Each CLI command lives in its own file and exports `register(program)`.
 * Add ONE line here per command; keep the list alphabetical to minimise merge
 * conflicts between parallel tasks.
 */
export const registrars: Array<(program: Command) => void> = [
  registerApply,
  registerEval,
  registerGolden,
  registerOutcome,
  // (tasks append here, e.g.)  registerScrape,
];
