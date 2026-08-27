/**
 * `tailor` — rewrite the user's confirmed facts as a resume aimed at one job.
 *
 * The step that most needs a leash: it is generative, a human acts on its
 * output, and the failure mode (an invented employer or metric) is a lie on a
 * job application. So the citation contract is enforced twice — the prompt
 * demands `fact_ids` on every bullet, and {@link checkCitations} verifies it
 * mechanically afterwards. The report travels with the output so no caller can
 * render a PDF without having seen it (spec §5).
 */

import type { Db } from "../../db/client";
import { checkCitations, type HallucinationReport } from "../hallucination";
import { TailorOutput, type AnalyzeOutput, type Fact, type FitOutput } from "../schemas";
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

export interface RunTailorArgs extends StepOptions {
  analysis: AnalyzeOutput;
  facts: Fact[];
  fit?: FitOutput | null;
}

export interface TailorResult extends StepResult<TailorOutput> {
  /** Verified citations. `rate > 0` means bullets are blocked from the PDF. */
  hallucination: HallucinationReport;
}

export function buildTailorPrompt(args: {
  analysis: AnalyzeOutput;
  facts: Fact[];
  fit?: FitOutput | null;
}): string {
  return sections([
    { heading: "Job analysis", body: renderAnalysis(args.analysis) },
    { heading: "Candidate facts", body: renderFacts(args.facts) },
    {
      heading: "Fit assessment",
      body: args.fit ? renderFit(args.fit) : null,
    },
  ]);
}

export async function runTailor(
  db: Db,
  args: RunTailorArgs,
): Promise<TailorResult> {
  const result = await runStep(db, "tailor", {
    ...args,
    schema: TailorOutput,
    prompt: buildTailorPrompt(args),
  });

  return {
    ...result,
    hallucination: checkCitations(result.output, factLabels(args.facts)),
  };
}
