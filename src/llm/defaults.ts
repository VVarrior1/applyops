/**
 * Default model per pipeline step.
 *
 * Per the build plan's Global Constraints this file is the *only* place
 * default model ids are written down: steps, routes and the CLI all resolve
 * their model through `DEFAULT_MODEL_BY_STEP` (or an explicit override), so
 * changing what `analyze` runs on is a one-line edit here, and the eval gate
 * (spec §7) has a single baseline to compare a candidate model against.
 *
 * Every choice below is a measurement, not a preference. `applyops bench`
 * (spec §8, `src/bench/bench.ts`) runs each candidate model over the frozen
 * golden set, grades it with the fixed judge, and names the cheapest model
 * that is **not measurably worse** than the best — i.e. whose mean judge score
 * sits inside the best model's 95% bootstrap interval. The `eval_run` id in
 * each comment is the winning run; the losing runs are in the same table, and
 * all of them are on the public `/benchmark` page.
 */

import type { Step } from "../db/schema";
import type { ModelId } from "./model-id";

export const DEFAULT_MODEL_BY_STEP: Record<Step, ModelId> = {
  // Benchmarked 2026-08-27 over 20 golden items, judged by google:gemini-3.7-flash.
  //   google:gemini-3.7-flash        4.54 [4.22–4.81]   0.0% halluc   $0.00400/item
  //   google:gemini-2.5-flash-lite   4.11 [3.66–4.50]   0.0% halluc   $0.00030/item
  // Flash-lite is 13x cheaper but its mean is below 3.7-flash's lower bound.
  // chosen by eval_run 0739750e-7cba-478f-ac48-731e707814af on 2026-08-27
  analyze: "google:gemini-3.7-flash",

  // Benchmarked 2026-08-27 over 40 golden items.
  //   google:gemini-3.7-flash        4.93 [4.88–4.96]    0.0% halluc  $0.00526/item
  //   google:gemini-2.5-flash-lite   3.75 [3.44–4.05]   12.4% halluc  $0.00039/item
  // `fit` is the highest-volume call in the system, so the 13x price gap was
  // the one genuinely worth taking — but flash-lite cited a fact that does not
  // support the match on 12% of its claims, which is six times the eval gate's
  // own hallucination limit. Not a trade worth making on the ranker.
  // chosen by eval_run 167ce7ea-b3c5-4c1e-8a59-bfa97cda4358 on 2026-08-27
  fit: "google:gemini-3.7-flash",

  // Benchmarked 2026-08-27 over 40 golden items (38 scored for 3.7-flash; two
  // items hit a transient "model is experiencing high demand" error).
  //   google:gemini-3.7-flash        4.82 [4.72–4.91]   0.0% halluc   $0.00914/item
  //   google:gemini-2.5-flash-lite   3.98 [3.70–4.29]   2.3% halluc   $0.00060/item
  // chosen by eval_run d64492a0-230e-435c-a183-f41763e6abd7 on 2026-08-27
  tailor: "google:gemini-3.7-flash",

  // Benchmarked 2026-08-27 over 20 golden items.
  //   google:gemini-3.7-flash        4.84 [4.67–4.96]   0.0% halluc   $0.00695/item
  //   google:gemini-2.5-flash-lite   3.67 [3.36–4.01]   5.0% halluc   $0.00056/item
  // chosen by eval_run d50cf04a-4d87-420f-bb5d-234feac76c1b on 2026-08-27
  suggest: "google:gemini-3.7-flash",

  // Not benchmarked: the golden set is job postings, and `judge` is fixed
  // below in any case.
  judge: "google:gemini-3.7-flash",

  // Not benchmarked: there is no golden set of resumes to grade extraction
  // against, and the step runs once per user per upload, so its cost is noise.
  extract_facts: "google:gemini-3.7-flash",
};

/**
 * The judge model is fixed (Global Constraints): an eval run compares
 * candidate models for a step, so the grader must not move at the same time
 * or the comparison measures nothing. `bench`/`eval` may vary the *step*
 * model freely, never this one.
 *
 * Spec §8 intends `anthropic:claude-sonnet-5`. Every Anthropic key available
 * to this project has a zero credit balance — verified 2026-08-27, when a
 * 4-model benchmark run returned "Your credit balance is too low to access the
 * Anthropic API" on all 80 Anthropic items and 0 on the Google ones — so the
 * judge is Gemini 3.7 Flash until credits exist. This is the *one* case where
 * a contestant and the grader are the same model; `/benchmark` says so on the
 * page rather than leaving the reader to work it out.
 */
export const JUDGE_MODEL_ID: ModelId = "google:gemini-3.7-flash";

export function defaultModelForStep(step: Step): ModelId {
  return DEFAULT_MODEL_BY_STEP[step];
}
