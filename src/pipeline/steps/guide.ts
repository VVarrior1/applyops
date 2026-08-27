/**
 * `guide` — the whole-search outlook: where this candidate stands, what they
 * can realistically target, what is missing, and a 30/60/90 plan.
 *
 * Every other step reasons about one job. This one takes no job at all: its
 * inputs are the user's confirmed facts, the targets they set in `search_prefs`
 * and — once they have applied to anything — their own funnel, so the advice
 * moves as their real results move.
 *
 * It shares `tailor`'s and `suggest`'s citation contract, with one deliberate
 * relaxation: a *strength* is a claim about the candidate and must be cited,
 * but a *plan action* ("apply to eight postings a week") often makes no claim
 * about their history and may cite nothing. Citing a label the user does not
 * have is a fabrication either way. See {@link checkGuideCitations}.
 */

import type { Db } from "../../db/client";
import type { HallucinationReport, UnsupportedClaim } from "../hallucination";
import { GuideOutput, type Fact } from "../schemas";
import { renderPrefs, type FitPrefs } from "./fit";
import {
  factLabels,
  renderFacts,
  runStep,
  sections,
  type StepOptions,
  type StepResult,
} from "./shared";

/**
 * The targets the guide reasons about. A superset of `FitPrefs` — the ranker
 * does not care which countries a user will work in, but an outlook that talks
 * about the Canada→US path very much does. Structurally compatible with the
 * `search_prefs` row, so a caller passes it straight through.
 */
export interface GuidePrefs extends FitPrefs {
  countries?: string[] | null;
}

/** The funnel numbers the guide is allowed to reason from (`deriveFunnel`). */
export interface GuideFunnel {
  applied: number;
  responded: number;
  interviewing: number;
  offers: number;
  rejected: number;
  ghosted: number;
  responseRate: number;
  interviewRate: number;
}

export interface RunGuideArgs extends StepOptions {
  facts: Fact[];
  prefs?: GuidePrefs | null;
  /** All-time funnel row, or `null` when they have not applied to anything. */
  funnel?: GuideFunnel | null;
  /** Injected for testability; defaults to now. */
  today?: Date;
}

export interface GuideResult extends StepResult<GuideOutput> {
  hallucination: HallucinationReport;
  /** {@link GuideResult.output} with unsupported claims removed — what is stored and rendered. */
  checked: GuideOutput;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/**
 * The funnel, rendered with its own sample size front and centre. A model
 * shown "0% response rate" without "out of 3 applications" will happily build
 * a whole strategy on noise.
 */
export function renderFunnel(funnel: GuideFunnel | null | undefined): string | null {
  if (!funnel || funnel.applied === 0) {
    return "(no applications logged yet — there is no funnel to read into)";
  }
  const lines = [
    `Applications sent: ${funnel.applied}`,
    `Responded: ${funnel.responded} (${pct(funnel.responseRate)})`,
    `Reached an interview: ${funnel.interviewing} (${pct(funnel.interviewRate)})`,
    `Offers: ${funnel.offers}`,
    `Rejected: ${funnel.rejected}`,
    `Ghosted: ${funnel.ghosted}`,
  ];
  if (funnel.applied < 15) {
    lines.push(
      `Note: ${funnel.applied} applications is too small a sample to conclude much. Say so rather than over-reading it.`,
    );
  }
  return lines.join("\n");
}

/** Prefs plus the fields `renderPrefs` (built for the ranker) does not carry. */
function renderGuidePrefs(prefs: GuidePrefs | null | undefined): string {
  const base = renderPrefs(prefs);
  const countries = prefs?.countries?.length
    ? `Will work in (ISO country codes): ${prefs.countries.join(", ")}`
    : null;
  return countries ? `${base}\n${countries}` : base;
}

export function buildGuidePrompt(args: {
  facts: Fact[];
  prefs?: GuidePrefs | null;
  funnel?: GuideFunnel | null;
  today?: Date;
}): string {
  const today = (args.today ?? new Date()).toISOString().slice(0, 10);
  return sections([
    { heading: "Today's date", body: today },
    { heading: "Candidate facts", body: renderFacts(args.facts) },
    { heading: "Candidate targets", body: renderGuidePrefs(args.prefs) },
    { heading: "Their application funnel so far", body: renderFunnel(args.funnel) },
  ]);
}

// ---------------------------------------------------------------------------
// Citation check
// ---------------------------------------------------------------------------

/**
 * Same normalisation as `checkCitations()`: a model that writes `f-014` meant
 * the fact it was shown, and treating that as a fabrication would delete a
 * perfectly grounded strength.
 */
function normalizeLabel(label: string): string {
  return label.trim().toUpperCase();
}

interface GuideClaim {
  path: string;
  text: string;
  factIds: string[];
  /** False for plan actions, which need not be claims about the candidate. */
  requiresCitation: boolean;
}

const PLAN_PHASES = ["days_30", "days_60", "days_90"] as const;

function collectGuideClaims(output: GuideOutput): GuideClaim[] {
  const claims: GuideClaim[] = output.strengths.map((strength, i) => ({
    path: `strengths[${i}]`,
    text: strength.text,
    factIds: strength.fact_ids ?? [],
    requiresCitation: true,
  }));

  for (const phase of PLAN_PHASES) {
    output.plan_30_60_90[phase].forEach((item, i) => {
      claims.push({
        path: `plan_30_60_90.${phase}[${i}]`,
        text: item.action,
        factIds: item.fact_ids ?? [],
        requiresCitation: false,
      });
    });
  }

  return claims;
}

/**
 * Check a `guide` output against the user's confirmed fact labels.
 *
 * `src/pipeline/hallucination.ts`'s `checkCitations()` is shaped around
 * `tailor`/`suggest`'s output types and their "every claim must cite"
 * contract, neither of which fits here — so this is a local check that reuses
 * that module's report types (so the UI renders one report shape) and its
 * label normalisation, and nothing else.
 */
export function checkGuideCitations(
  output: GuideOutput,
  validLabels: Set<string>,
): HallucinationReport {
  const valid = new Set([...validLabels].map(normalizeLabel));
  const claims = collectGuideClaims(output);
  const unsupported: UnsupportedClaim[] = [];

  for (const claim of claims) {
    const badIds = claim.factIds.filter((id) => !valid.has(normalizeLabel(id)));
    if (badIds.length > 0 || (claim.requiresCitation && claim.factIds.length === 0)) {
      unsupported.push({ path: claim.path, text: claim.text, badIds });
    }
  }

  return {
    totalClaims: claims.length,
    unsupported,
    rate: claims.length === 0 ? 0 : unsupported.length / claims.length,
  };
}

/**
 * The guide with every unsupported claim removed — what gets stored in
 * `guides.output` and rendered. Mirrors `stripUnsupportedBullets()` for
 * `tailor`: the user never sees a claim the system could not trace back to
 * one of their own facts, and the unfiltered reply is still in
 * `generations.output` if anyone needs to see what the model actually said.
 */
export function stripUnsupportedGuideClaims(
  output: GuideOutput,
  report: HallucinationReport,
): GuideOutput {
  const blocked = new Set(report.unsupported.map((claim) => claim.path));
  if (blocked.size === 0) return output;

  return {
    ...output,
    strengths: output.strengths.filter((_, i) => !blocked.has(`strengths[${i}]`)),
    plan_30_60_90: {
      days_30: output.plan_30_60_90.days_30.filter(
        (_, i) => !blocked.has(`plan_30_60_90.days_30[${i}]`),
      ),
      days_60: output.plan_30_60_90.days_60.filter(
        (_, i) => !blocked.has(`plan_30_60_90.days_60[${i}]`),
      ),
      days_90: output.plan_30_60_90.days_90.filter(
        (_, i) => !blocked.has(`plan_30_60_90.days_90[${i}]`),
      ),
    },
  };
}

// ---------------------------------------------------------------------------
// Step
// ---------------------------------------------------------------------------

export async function runGuide(db: Db, args: RunGuideArgs): Promise<GuideResult> {
  const result = await runStep(db, "guide", {
    ...args,
    schema: GuideOutput,
    prompt: buildGuidePrompt(args),
  });

  const hallucination = checkGuideCitations(result.output, factLabels(args.facts));

  return {
    ...result,
    hallucination,
    checked: stripUnsupportedGuideClaims(result.output, hallucination),
  };
}
