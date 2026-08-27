/**
 * The chat's system prompt: the versioned coach instructions from
 * `src/pipeline/prompts/chat.v1.md` plus everything the model needs to know
 * about *this* user.
 *
 * The context is rebuilt from live data on every turn rather than stored on
 * the thread, so a fact the user edits in Settings, a target they change, or a
 * guide they regenerate is reflected in the very next message instead of
 * whenever the conversation happens to be restarted.
 *
 * Pure: it takes already-loaded data and returns a string.
 */

import type { GuideOutput } from "../pipeline/schemas";
import type { Fact } from "../pipeline/schemas";
import { renderPrefs } from "../pipeline/steps/fit";
import {
  renderFunnel,
  type GuideFunnel,
  type GuidePrefs,
} from "../pipeline/steps/guide";
import { renderFacts, sections } from "../pipeline/steps/shared";

/** Cap on how much of a long guide is replayed into every turn's context. */
const MAX_LIST_ITEMS = 5;

function bullets(items: readonly string[]): string[] {
  return items.slice(0, MAX_LIST_ITEMS).map((item) => `- ${item}`);
}

/**
 * The guide, compressed to the parts a follow-up question is likely to be
 * about. The full object is on the page next to the chat; replaying all of it
 * into every turn would triple the input cost of a one-line question.
 */
export function renderGuide(guide: GuideOutput | null | undefined): string | null {
  if (!guide) return null;

  const lines: string[] = [`Where they stand: ${guide.where_you_stand}`];

  if (guide.strengths.length) {
    lines.push(
      "",
      "Strengths (with the facts backing them):",
      ...guide.strengths
        .slice(0, MAX_LIST_ITEMS)
        .map((s) => `- ${s.text} [${s.fact_ids.join(", ") || "uncited"}]`),
    );
  }

  const targets = guide.realistic_targets;
  if (targets.role_types.length) {
    lines.push("", `Target roles: ${targets.role_types.join(", ")}`);
  }
  if (targets.company_types.length) {
    lines.push(`Target company types: ${targets.company_types.join(", ")}`);
  }
  if (targets.geographies.length) {
    lines.push(
      "Markets:",
      ...targets.geographies
        .slice(0, MAX_LIST_ITEMS)
        .map((g) => `- ${g.region}: ${g.why} (${g.notes_for_canadians})`),
    );
  }

  if (guide.gaps.length) {
    lines.push(
      "",
      "Gaps:",
      ...guide.gaps
        .slice(0, MAX_LIST_ITEMS)
        .map((g) => `- ${g.gap} (${g.effort}) — ${g.how_to_close}`),
    );
  }

  const plan = guide.plan_30_60_90;
  const phase = (label: string, items: readonly { action: string }[]) =>
    items.length
      ? [`${label}:`, ...bullets(items.map((item) => item.action))]
      : [];
  lines.push(
    "",
    "Plan:",
    ...phase("Days 1-30", plan.days_30),
    ...phase("Days 31-60", plan.days_60),
    ...phase("Days 61-90", plan.days_90),
  );

  if (guide.interview_prep_focus.length) {
    lines.push(
      "",
      "Interview prep focus:",
      ...bullets(guide.interview_prep_focus.map((p) => `${p.topic} — ${p.why}`)),
    );
  }

  lines.push(
    "",
    `Suggested cadence: ${guide.application_cadence.per_week}/week — ${guide.application_cadence.rationale}`,
  );

  if (guide.caveats.length) {
    lines.push("", "Caveats the guide already gave them:", ...bullets(guide.caveats));
  }

  return lines.join("\n");
}

export interface ChatContext {
  /** Body of `src/pipeline/prompts/chat.v1.md`. */
  basePrompt: string;
  facts: Fact[];
  prefs?: GuidePrefs | null;
  guide?: GuideOutput | null;
  funnel?: GuideFunnel | null;
  today?: Date;
}

/**
 * The full system message for one chat turn: the versioned instructions, then
 * the labelled context blocks the instructions refer to.
 */
export function buildChatSystemPrompt(context: ChatContext): string {
  const today = (context.today ?? new Date()).toISOString().slice(0, 10);

  const body = sections([
    { heading: "Today's date", body: today },
    { heading: "Facts (the only true statements about this person)", body: renderFacts(context.facts) },
    { heading: "Their targets", body: renderPrefs(context.prefs) },
    { heading: "The outlook already generated for them", body: renderGuide(context.guide) },
    { heading: "Their application funnel", body: renderFunnel(context.funnel) },
  ]);

  return `${context.basePrompt.trim()}\n\n---\n\n# This user\n\n${body}`;
}
