/**
 * `extract_facts` — turn resume text into atomic, quoted facts.
 *
 * The entry point to everything else: the user confirms these, they become
 * `profile_facts` with `F-001`-style labels, and from then on they are the only
 * evidence any other step may cite. Nothing here writes to the database — the
 * caller (`src/profile/facts.ts`, Task 6) labels and stores the confirmed
 * subset.
 */

import type { Db } from "../../db/client";
import { ExtractFactsOutput } from "../schemas";
import {
  MAX_RESUME_CHARS,
  runStep,
  sections,
  truncate,
  type StepOptions,
  type StepResult,
} from "./shared";

export interface RunExtractFactsArgs extends StepOptions {
  resumeText: string;
}

export function buildExtractFactsPrompt(resumeText: string): string {
  return sections([
    {
      heading: "Resume text",
      body: truncate(resumeText, MAX_RESUME_CHARS),
    },
  ]);
}

export async function runExtractFacts(
  db: Db,
  args: RunExtractFactsArgs,
): Promise<StepResult<ExtractFactsOutput>> {
  return runStep(db, "extract_facts", {
    ...args,
    schema: ExtractFactsOutput,
    prompt: buildExtractFactsPrompt(args.resumeText),
  });
}
