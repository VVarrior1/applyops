/**
 * The pipeline steps (spec §5, plus `guide`), re-exported from one place so callers
 * (`src/rank`, `src/eval`, `app/api/**`, `cli/`) import from
 * `src/pipeline/steps` rather than reaching into individual files.
 */

export {
  runAnalyze,
  buildAnalyzePrompt,
  type AnalyzeJobInput,
  type RunAnalyzeArgs,
} from "./analyze";
export {
  runFit,
  buildFitPrompt,
  renderPrefs,
  type FitPrefs,
  type FitJobContext,
  type RunFitArgs,
  type FitStepResult,
} from "./fit";
export {
  runTailor,
  buildTailorPrompt,
  type RunTailorArgs,
  type TailorResult,
} from "./tailor";
export {
  runSuggest,
  buildSuggestPrompt,
  type RunSuggestArgs,
  type SuggestResult,
} from "./suggest";
export {
  runGuide,
  buildGuidePrompt,
  checkGuideCitations,
  stripUnsupportedGuideClaims,
  renderFunnel,
  type GuideFunnel,
  type GuidePrefs,
  type RunGuideArgs,
  type GuideResult,
} from "./guide";
export {
  runJudge,
  buildJudgePrompt,
  type JudgeJobInput,
  type RunJudgeArgs,
} from "./judge";
export {
  runExtractFacts,
  buildExtractFactsPrompt,
  type RunExtractFactsArgs,
} from "./extract-facts";
export {
  factLabels,
  renderAnalysis,
  renderFacts,
  renderFit,
  runStep,
  truncate,
  MAX_DESCRIPTION_CHARS,
  MAX_RESUME_CHARS,
  type StepOptions,
  type StepResult,
} from "./shared";
