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
  // 2026-08-27: Gemini 3.7 Flash is the provisional default for every step.
  // Reason: the only Anthropic keys available have no credit balance, and
  // Gemini 3.7 Flash is cheaper than Haiku 4.5 ($0.75/$3.75 vs $1/$5 per 1M).
  // The `bench` command re-decides these per step once Claude models are
  // callable again; update the run id in the comment when that happens.
  analyze: "google:gemini-3.7-flash",
  fit: "google:gemini-3.7-flash",
  tailor: "google:gemini-3.7-flash",
  suggest: "google:gemini-3.7-flash",
  judge: "google:gemini-3.7-flash",
  extract_facts: "google:gemini-3.7-flash",
};

/**
 * The judge model is fixed (Global Constraints): an eval run compares
 * candidate models for a step, so the grader must not move at the same time
 * or the comparison measures nothing. `bench`/`eval` may vary the *step*
 * model freely, never this one.
 */
export const JUDGE_MODEL_ID: ModelId = "google:gemini-3.7-flash"; // provisional: see DEFAULT_MODEL_BY_STEP note; spec §8 intends claude-sonnet-5 once credits exist

export function defaultModelForStep(step: Step): ModelId {
  return DEFAULT_MODEL_BY_STEP[step];
}
