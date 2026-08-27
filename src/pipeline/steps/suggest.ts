/**
 * `suggest` — what to do about this job: gaps, what to lead with, a weekend
 * build, likely questions, honest keywords.
 *
 * Shares `tailor`'s citation contract: `lead_with` entries and the
 * `weekend_build` must cite real facts, and the same mechanical check runs on
 * the result (spec §5).
 */

import type { Db } from "../../db/client";
import { checkCitations, type HallucinationReport } from "../hallucination";
import { SuggestOutput, type AnalyzeOutput, type Fact, type FitOutput } from "../schemas";
import {
  factLabels,
  renderAnalysis,
  renderFacts,
  renderFit,
  runStep,
  sections,
  type StepOptions,
  type StepResult,
} from "./shared";

export interface RunSuggestArgs extends StepOptions {
  analysis: AnalyzeOutput;
  facts: Fact[];
  fit?: FitOutput | null;
}

export interface SuggestResult extends StepResult<SuggestOutput> {
  hallucination: HallucinationReport;
}

export function buildSuggestPrompt(args: {
  analysis: AnalyzeOutput;
  facts: Fact[];
  fit?: FitOutput | null;
}): string {
  return sections([
    { heading: "Job analysis", body: renderAnalysis(args.analysis) },
    { heading: "Candidate facts", body: renderFacts(args.facts) },
    { heading: "Fit assessment", body: args.fit ? renderFit(args.fit) : null },
  ]);
}

export async function runSuggest(
  db: Db,
  args: RunSuggestArgs,
): Promise<SuggestResult> {
  const result = await runStep(db, "suggest", {
    ...args,
    schema: SuggestOutput,
    prompt: buildSuggestPrompt(args),
  });

  return {
    ...result,
    hallucination: checkCitations(result.output, factLabels(args.facts)),
  };
}
