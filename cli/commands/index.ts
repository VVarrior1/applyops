import type { Command } from "commander";
import { register as registerApply } from "./apply";
import { register as registerBench } from "./bench";
import { register as registerCompanies } from "./companies";
import { register as registerEval } from "./eval";
import { register as registerGolden } from "./golden";
import { register as registerOutcome } from "./outcome";
import { register as registerPdf } from "./pdf";
import { register as registerRank } from "./rank";
import { register as registerResume } from "./resume";
import { register as registerScrape } from "./scrape";
import { register as registerJobs } from "./jobs";
import { register as registerWorkday } from "./workday";

/**
 * Each CLI command lives in its own file and exports `register(program)`.
 * Add ONE line here per command; keep the list alphabetical to minimise merge
 * conflicts between parallel tasks.
 */
export const registrars: Array<(program: Command) => void> = [
  registerApply,
  registerBench,
  registerCompanies,
  registerEval,
  registerGolden,
  registerJobs,
  registerOutcome,
  registerPdf,
  registerRank,
  registerResume,
  registerScrape,
  registerWorkday,
];
