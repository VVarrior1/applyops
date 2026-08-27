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

export async function runFit(
  db: Db,
  args: RunFitArgs,
): Promise<StepResult<FitOutput>> {
  return runStep(db, "fit", {
    ...args,
    schema: FitOutput,
    prompt: buildFitPrompt(args),
  });
}
