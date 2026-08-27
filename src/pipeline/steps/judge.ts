/**
 * `judge` — grade a `tailor` output on the four-axis rubric (spec §7).
 *
 * The judge model is **fixed** ({@link JUDGE_MODEL_ID}) and versioned, because
 * an eval run varies the *step* model to find out which one is better; a grader
 * that moved at the same time would measure nothing. `modelId` is overridable
 * only so the benchmark page can honestly disclose a judge-vs-contestant
 * comparison — do not vary it casually.
 */

import type { Db } from "../../db/client";
import { JUDGE_MODEL_ID } from "../../llm/defaults";
import { JudgeOutput, type Fact, type TailorOutput } from "../schemas";
import {
  MAX_DESCRIPTION_CHARS,
  renderFacts,
  runStep,
  sections,
  truncate,
  type StepOptions,
  type StepResult,
} from "./shared";

export interface JudgeJobInput {
  title: string;
  company: string;
  description: string;
}

export interface RunJudgeArgs extends StepOptions {
  job: JudgeJobInput;
  facts: Fact[];
  tailor: TailorOutput;
}

/**
 * The tailored resume is shown as JSON, `fact_ids` included: the grounding
 * axis is precisely about whether those ids support the text, so hiding them
 * behind prose would make the axis ungradeable.
 */
export function buildJudgePrompt(args: {
  job: JudgeJobInput;
  facts: Fact[];
  tailor: TailorOutput;
}): string {
  return sections([
    {
      heading: "Job",
      body: [
        `Title: ${args.job.title}`,
        `Company: ${args.job.company}`,
        "",
        truncate(args.job.description, MAX_DESCRIPTION_CHARS),
      ].join("\n"),
    },
    { heading: "Candidate facts", body: renderFacts(args.facts) },
    {
      heading: "Tailored resume to grade (JSON)",
      body: JSON.stringify(args.tailor, null, 2),
    },
  ]);
}

export async function runJudge(
  db: Db,
  args: RunJudgeArgs,
): Promise<StepResult<JudgeOutput>> {
  return runStep(db, "judge", {
    ...args,
    modelId: args.modelId ?? JUDGE_MODEL_ID,
    schema: JudgeOutput,
    prompt: buildJudgePrompt(args),
  });
}
