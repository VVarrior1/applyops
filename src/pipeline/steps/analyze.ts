/**
 * `analyze` — read one job posting, return its structured requirements.
 *
 * Runs once per job and is cached in `jobs.analysis` (spec §6): the output
 * describes the posting, not any candidate, so every user's ranking reuses the
 * same analysis. That is why nothing about a profile is passed in here.
 */

import type { Db } from "../../db/client";
import { AnalyzeOutput } from "../schemas";
import {
  MAX_DESCRIPTION_CHARS,
  runStep,
  sections,
  truncate,
  type StepOptions,
  type StepResult,
} from "./shared";

export interface AnalyzeJobInput {
  title: string;
  company: string;
  description: string;
  location?: string | null;
  remote?: boolean | null;
}

export interface RunAnalyzeArgs extends StepOptions {
  job: AnalyzeJobInput;
}

export function buildAnalyzePrompt(job: AnalyzeJobInput): string {
  return sections([
    {
      heading: "Job",
      body: [
        `Title: ${job.title}`,
        `Company: ${job.company}`,
        job.location ? `Location: ${job.location}` : null,
        job.remote == null ? null : `Remote: ${job.remote ? "yes" : "no"}`,
      ]
        .filter(Boolean)
        .join("\n"),
    },
    {
      heading: "Posting",
      body: truncate(job.description, MAX_DESCRIPTION_CHARS),
    },
  ]);
}

export async function runAnalyze(
  db: Db,
  args: RunAnalyzeArgs,
): Promise<StepResult<AnalyzeOutput>> {
  return runStep(db, "analyze", {
    ...args,
    schema: AnalyzeOutput,
    prompt: buildAnalyzePrompt(args.job),
  });
}
