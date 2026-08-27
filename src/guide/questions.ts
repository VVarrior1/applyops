/**
 * The six suggested-question chips under the chat box.
 *
 * A blank chat box is the reason most people never use a coach. The chips are
 * the cheapest fix: six questions that are already about *this* user's
 * situation. When a guide exists they are drawn from it — its biggest gap, its
 * top target market, its 30-day plan — so clicking one continues a
 * conversation the guide already started. With no guide yet, a static set
 * covers the questions a Canadian new-grad CS job seeker actually has.
 *
 * Pure and dependency-free so the wording is unit-tested rather than eyeballed.
 */

import type { GuideOutput } from "../pipeline/schemas";

export const SUGGESTED_QUESTION_COUNT = 6;

/**
 * The fallback set. Also the tail the guide-derived questions are topped up
 * from, so the chip row is always full even for a sparse guide.
 */
export const DEFAULT_SUGGESTED_QUESTIONS: readonly string[] = [
  "Should I apply to US roles as a Canadian — how does TN actually work?",
  "What should I build or finish before December to close my biggest gap?",
  "Is a 3.5 GPA a problem, and should it be on my resume?",
  "Which of my projects should I lead with for backend roles?",
  "How many applications per week is realistic, and how do I avoid burning out?",
  "What will my first 3 months of interviews look like — what should I prepare first?",
];

/** Trim, collapse whitespace, and drop anything that ended up empty. */
function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Lowercase the first letter of a phrase so it reads inside a sentence. */
function inline(text: string): string {
  const trimmed = clean(text).replace(/[.?!]+$/, "");
  // Leave acronyms and proper-looking names alone: "TN status" must not
  // become "tN status".
  if (/^[A-Z]{2,}/.test(trimmed)) return trimmed;
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
}

/**
 * Six questions for this user, guide-derived where possible.
 *
 * Order is deliberate: the gap they most need to hear about first, then the
 * market question, then the plan, then whatever the defaults still add. Each
 * question is de-duplicated case-insensitively so a guide that repeats itself
 * cannot fill the row with one idea.
 */
export function buildSuggestedQuestions(
  guide: GuideOutput | null | undefined,
  defaults: readonly string[] = DEFAULT_SUGGESTED_QUESTIONS,
): string[] {
  const questions: string[] = [];
  const seen = new Set<string>();

  const push = (question: string | null | undefined) => {
    if (!question) return;
    const text = clean(question);
    if (!text) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    questions.push(text);
  };

  if (guide) {
    const [topGap, secondGap] = guide.gaps;
    if (topGap) {
      push(`How do I actually close this gap: ${inline(topGap.gap)}?`);
    }

    const geography = guide.realistic_targets.geographies[0];
    if (geography) {
      push(
        `Is ${clean(geography.region)} realistic for me, and what does the work authorization actually involve?`,
      );
    }

    const firstAction = guide.plan_30_60_90.days_30[0];
    if (firstAction) {
      push(`Walk me through the first step: ${inline(firstAction.action)}?`);
    }

    const role = guide.realistic_targets.role_types[0];
    if (role) {
      push(`Am I actually competitive for ${inline(role)} roles right now?`);
    }

    if (guide.application_cadence.per_week > 0) {
      push(
        `Why ${guide.application_cadence.per_week} applications a week — how do I hit that without burning out?`,
      );
    }

    const prep = guide.interview_prep_focus[0];
    if (prep) {
      push(`How should I prepare ${inline(prep.topic)} before my first interview?`);
    }

    if (secondGap) {
      push(`What does "${inline(secondGap.gap)}" cost me in a screen?`);
    }
  }

  // Top up from the defaults so the row is always full, even with no guide or
  // a guide that produced very little.
  for (const question of defaults) {
    if (questions.length >= SUGGESTED_QUESTION_COUNT) break;
    push(question);
  }

  return questions.slice(0, SUGGESTED_QUESTION_COUNT);
}
