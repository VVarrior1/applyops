/**
 * `fit` — score one analyzed posting against one user's confirmed facts.
 *
 * This is the ranker (spec §5, "Ranker v0"): `job_scores.ranker_version` is
 * `fit-v1:<model>`, compared against the ported v1 keyword baseline. It runs
 * per job per user, so it is the highest-volume LLM call in the system and its
 * default model is deliberately the cheap one.
 */

import type { Db } from "../../db/client";
import { FitOutput, type AnalyzeOutput, type Fact } from "../schemas";
import {
  renderAnalysis,
  renderFacts,
  runStep,
  sections,
  type StepOptions,
  type StepResult,
} from "./shared";

/**
 * The subset of `search_prefs` the fit step reasons about. Structurally
 * compatible with the Drizzle row (`typeof searchPrefs.$inferSelect`), so a
 * caller can pass the row straight through; every field is optional because a
 * user who has not finished onboarding still gets ranked.
 */
export interface FitPrefs {
  roles?: string[] | null;
  locations?: string[] | null;
  remote?: string | null;
  seniority?: string[] | null;
  workAuth?: string | null;
  keywords?: string[] | null;
  excludedCompanies?: string[] | null;
}

export interface FitJobContext {
  title?: string | null;
  company?: string | null;
  location?: string | null;
  remote?: boolean | null;
}

export interface RunFitArgs extends StepOptions {
  analysis: AnalyzeOutput;
  facts: Fact[];
  prefs?: FitPrefs | null;
  /** Optional posting header — the analysis alone omits title and company. */
  job?: FitJobContext | null;
}

export function renderPrefs(prefs: FitPrefs | null | undefined): string {
  if (!prefs) return "(no preferences on file — judge on the facts alone)";
  const list = (values: string[] | null | undefined) =>
    values && values.length ? values.join(", ") : null;

  const lines = [
    list(prefs.roles) && `Target roles: ${list(prefs.roles)}`,
    list(prefs.locations) && `Locations: ${list(prefs.locations)}`,
    prefs.remote && `Remote preference: ${prefs.remote}`,
    list(prefs.seniority) && `Seniority: ${list(prefs.seniority)}`,
    prefs.workAuth && `Work authorization: ${prefs.workAuth}`,
    list(prefs.keywords) && `Interests: ${list(prefs.keywords)}`,
    list(prefs.excludedCompanies) &&
      `Will not work for: ${list(prefs.excludedCompanies)}`,
  ].filter(Boolean);

  return lines.length
    ? lines.join("\n")
    : "(no preferences on file — judge on the facts alone)";
}

export function buildFitPrompt(args: {
  analysis: AnalyzeOutput;
  facts: Fact[];
  prefs?: FitPrefs | null;
  job?: FitJobContext | null;
}): string {
  return sections([
    {
      heading: "Job",
      body: args.job
        ? [
            args.job.title ? `Title: ${args.job.title}` : null,
            args.job.company ? `Company: ${args.job.company}` : null,
            args.job.location ? `Location: ${args.job.location}` : null,
            args.job.remote == null
              ? null
              : `Remote: ${args.job.remote ? "yes" : "no"}`,
          ]
            .filter(Boolean)
            .join("\n")
        : null,
    },
    { heading: "Job analysis", body: renderAnalysis(args.analysis) },
    { heading: "Candidate facts", body: renderFacts(args.facts) },
    { heading: "Candidate preferences", body: renderPrefs(args.prefs) },
  ]);
}

// ---------------------------------------------------------------------------
// Requirement check
// ---------------------------------------------------------------------------

/**
 * Normalise for a loose substring compare: lowercase, collapse whitespace,
 * strip the punctuation a model tends to add/drop when "quoting" ("must have
 * 3+ years" vs "3+ years of experience,"). Deliberately permissive — the goal
 * is only to catch the failure this guards against (a candidate fact
 * standing in for a requirement, e.g. "Python skill"), not to fail a
 * requirement over a trimmed trailing period.
 */
function normalizeRequirementText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,;:!?"'()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Indexes of `output.matched` entries whose `requirement` cannot be traced
 * back to anything `analyze` actually put in `analysis.requirements` — the
 * failure mode fit.v1.md's rules now spell out explicitly but a prompt alone
 * cannot guarantee (same reasoning as `checkCitations()` in
 * `../hallucination.ts`, which verifies fact citations rather than
 * requirement text — this checks a different field, so it lives here next to
 * the step that produces it instead of in that shared module).
 */
export function invalidMatchIndexes(
  output: FitOutput,
  analysis: AnalyzeOutput,
): number[] {
  const posted = analysis.requirements.map((r) => normalizeRequirementText(r.text));
  const invalid: number[] = [];
  output.matched.forEach((match, i) => {
    const claim = normalizeRequirementText(match.requirement);
    const quoted = claim.length > 0 && posted.some((r) => r.includes(claim) || claim.includes(r));
    if (!quoted) invalid.push(i);
  });
  return invalid;
}

/**
 * `output` with every `matched` entry that isn't quoted from the posting's
 * own requirements removed — what actually gets persisted and shown. Mirrors
 * `stripUnsupportedBullets()`/`stripUnsupportedGuideClaims()`: the model's
 * raw reply is still in `generations.output` for anyone who needs to see
 * what it actually said, but nothing that fails this check reaches
 * `job_scores` or the Fit tab.
 */
export function stripInventedMatches(
  output: FitOutput,
  analysis: AnalyzeOutput,
): FitOutput {
  const invalid = new Set(invalidMatchIndexes(output, analysis));
  if (invalid.size === 0) return output;
  return {
    ...output,
    matched: output.matched.filter((_, i) => !invalid.has(i)),
  };
}

export async function runFit(
  db: Db,
  args: RunFitArgs,
): Promise<StepResult<FitOutput>> {
  const result = await runStep(db, "fit", {
    ...args,
    schema: FitOutput,
    prompt: buildFitPrompt(args),
  });

  return { ...result, output: stripInventedMatches(result.output, args.analysis) };
}
