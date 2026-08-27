/**
 * Default model per pipeline step.
 *
 * Per the build plan's Global Constraints this file is the *only* place
 * default model ids are written down: steps, routes and the CLI all resolve
 * their model through `DEFAULT_MODEL_BY_STEP` (or an explicit override), so
 * changing what `analyze` runs on is a one-line edit here, and the eval gate
 * (spec §7) has a single baseline to compare a candidate model against.
 *
 * The v1 split: cheap-and-fast Haiku for the high-volume mechanical steps
 * (`analyze` runs once per job, `fit` once per job per user, `extract_facts`
 * once per resume); Sonnet for the steps whose output a human reads and acts
 * on (`tailor`, `suggest`) and for `judge`, where grading quality is the whole
 * point.
 */

import type { Step } from "../db/schema";
import type { ModelId } from "./model-id";

export const DEFAULT_MODEL_BY_STEP: Record<Step, ModelId> = {
  analyze: "anthropic:claude-haiku-4-5",
  fit: "anthropic:claude-haiku-4-5",
  tailor: "anthropic:claude-sonnet-5",
  suggest: "anthropic:claude-sonnet-5",
  judge: "anthropic:claude-sonnet-5",
  extract_facts: "anthropic:claude-haiku-4-5",
};

/**
 * The judge model is fixed (Global Constraints): an eval run compares
 * candidate models for a step, so the grader must not move at the same time
 * or the comparison measures nothing. `bench`/`eval` may vary the *step*
 * model freely, never this one.
 */
export const JUDGE_MODEL_ID: ModelId = "anthropic:claude-sonnet-5";

export function defaultModelForStep(step: Step): ModelId {
  return DEFAULT_MODEL_BY_STEP[step];
}
