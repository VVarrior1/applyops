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
import { flattenSkillGroups, type SkillGroup } from "../../pdf/skills-groups";
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
  /**
   * The skill categories of the user's base `.tex` resume
   * (`parseSkillGroups()`, `src/pdf/skills-groups.ts`). When supplied, the
   * prompt names them and the model must answer with those labels, in that
   * order — the tailored PDF then keeps the author's own categories instead
   * of v1's Proficient/Familiar pair.
   *
   * Omitted (or empty) for a user with no LaTeX base, which is the pre-1.3.0
   * behaviour: the model returns a flat `skills` list and the splice writes
   * v1's two-line block.
   */
  skillGroups?: readonly SkillGroup[] | null;
}

export interface TailorResult extends StepResult<TailorOutput> {
  /** Verified citations. `rate > 0` means bullets are blocked from the PDF. */
  hallucination: HallucinationReport;
}

/**
 * The base resume's skill categories, as the numbered list the prompt's
 * `skill_groups` rule refers to.
 *
 * Rendered here rather than in the prompt file because the labels are *this
 * user's*, not a constant: the prompt file states the rule, this supplies the
 * data it applies to. Returns `null` when there is nothing to say, which
 * {@link sections} then drops entirely — a heading followed by nothing is an
 * invitation to invent categories.
 */
export function renderSkillGroupsPrompt(
  groups?: readonly SkillGroup[] | null,
): string | null {
  if (!groups || groups.length === 0) return null;
  const lines = groups.map(
    (group, i) => `${i + 1}. ${group.label} — ${group.items.join(", ")}`,
  );
  return [
    "Return `skill_groups` using EXACTLY these labels in this order:",
    ...lines,
    "",
    "Within each group you may reorder items to lead with what the posting asks",
    "for, drop items that are irrelevant, and add items only if a confirmed fact",
    "supports them. Never invent a group, never move an item to another group.",
    "Set `skills` to your `skill_groups` items, flattened in the same order.",
  ].join("\n");
}

export function buildTailorPrompt(args: {
  analysis: AnalyzeOutput;
  facts: Fact[];
  fit?: FitOutput | null;
  skillGroups?: readonly SkillGroup[] | null;
}): string {
  return sections([
    { heading: "Job analysis", body: renderAnalysis(args.analysis) },
    { heading: "Candidate facts", body: renderFacts(args.facts) },
    {
      heading: "Fit assessment",
      body: args.fit ? renderFit(args.fit) : null,
    },
    {
      heading: "Base resume skill categories",
      body: renderSkillGroupsPrompt(args.skillGroups),
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

  // `skills` and `skill_groups` must never disagree: `skills` is what the
  // Tailor tab's chips, the react-pdf fallback and the eval reports read, and
  // `skill_groups` is what the LaTeX splice writes. Deriving one from the
  // other here — rather than trusting the model to keep two fields in sync —
  // makes that structural.
  const output =
    result.output.skill_groups && result.output.skill_groups.length > 0
      ? { ...result.output, skills: flattenSkillGroups(result.output.skill_groups) }
      : result.output;

  return {
    ...result,
    output,
    hallucination: checkCitations(output, factLabels(args.facts)),
  };
}
