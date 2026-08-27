import { describe, it, expect } from "vitest";
import {
  DEFAULT_SUGGESTED_QUESTIONS,
  SUGGESTED_QUESTION_COUNT,
  buildSuggestedQuestions,
} from "../../src/guide/questions";
import type { GuideOutput } from "../../src/pipeline/schemas";

function guide(overrides: Partial<GuideOutput> = {}): GuideOutput {
  return {
    where_you_stand: "You are a credible new-grad backend candidate.",
    strengths: [{ text: "Shipped a real service.", fact_ids: ["F-014"] }],
    realistic_targets: {
      role_types: ["Backend Engineer, New Grad", "Software Engineer I"],
      company_types: ["Series B fintech"],
      geographies: [
        {
          region: "US remote",
          why: "Matches your stack.",
          notes_for_canadians: "TN is not sponsorship.",
        },
      ],
    },
    gaps: [
      {
        gap: "No distributed systems work on the profile",
        why_it_matters: "It is the first thing a platform screen asks about.",
        how_to_close: "Add a queue-backed worker over two weekends.",
        effort: "weeks",
      },
      {
        gap: "No internship",
        why_it_matters: "Some screens filter on it.",
        how_to_close: "Lean on the shipped project instead.",
        effort: "months",
      },
    ],
    plan_30_60_90: {
      days_30: [
        {
          action: "Rewrite the resume around the booking platform's numbers",
          why: "It is your strongest asset.",
          fact_ids: ["F-014"],
        },
      ],
      days_60: [],
      days_90: [],
    },
    interview_prep_focus: [
      {
        topic: "Systems design at one-service scale",
        why: "Every target screens on it.",
        resources_hint: "Whiteboard your own service.",
      },
    ],
    positioning_tips: ["Move the project above coursework."],
    application_cadence: { per_week: 8, rationale: "One hour each, still in classes." },
    market_notes: ["Calgary backend skews fintech."],
    caveats: ["Assumes a December graduation."],
    ...overrides,
  };
}

describe("buildSuggestedQuestions", () => {
  it("returns the static set when there is no guide", () => {
    expect(buildSuggestedQuestions(null)).toEqual([...DEFAULT_SUGGESTED_QUESTIONS]);
  });

  it("always returns exactly six questions", () => {
    for (const input of [null, undefined, guide(), guide({ gaps: [] })]) {
      expect(buildSuggestedQuestions(input)).toHaveLength(SUGGESTED_QUESTION_COUNT);
    }
  });

  it("leads with the biggest gap and names it", () => {
    const [first] = buildSuggestedQuestions(guide());
    // The gap is inlined into the sentence, so its leading capital is dropped.
    expect(first).toContain("no distributed systems work on the profile");
    expect(first.endsWith("?")).toBe(true);
  });

  it("asks about the top market and the cadence the guide chose", () => {
    const questions = buildSuggestedQuestions(guide());
    expect(questions.some((q) => q.includes("US remote"))).toBe(true);
    expect(questions.some((q) => q.includes("8 applications a week"))).toBe(true);
  });

  it("tops up from the defaults when the guide is sparse", () => {
    const sparse = guide({
      gaps: [],
      realistic_targets: {
        role_types: [],
        company_types: [],
        geographies: [],
      },
      plan_30_60_90: { days_30: [], days_60: [], days_90: [] },
      interview_prep_focus: [],
    });
    const questions = buildSuggestedQuestions(sparse);
    expect(questions).toHaveLength(SUGGESTED_QUESTION_COUNT);
    // The cadence question is the only guide-derived one left; the rest are defaults.
    expect(questions.filter((q) => DEFAULT_SUGGESTED_QUESTIONS.includes(q))).toHaveLength(5);
  });

  it("never repeats a question", () => {
    const repeated = guide({
      gaps: [
        {
          gap: "No internship",
          why_it_matters: "x",
          how_to_close: "y",
          effort: "months",
        },
        {
          gap: "No internship",
          why_it_matters: "x",
          how_to_close: "y",
          effort: "months",
        },
      ],
    });
    const questions = buildSuggestedQuestions(repeated);
    expect(new Set(questions).size).toBe(questions.length);
  });

  it("does not lowercase an acronym at the start of a phrase", () => {
    const acronym = guide({
      gaps: [
        {
          gap: "SQL fundamentals are thin",
          why_it_matters: "x",
          how_to_close: "y",
          effort: "days",
        },
      ],
    });
    expect(buildSuggestedQuestions(acronym)[0]).toContain("SQL fundamentals are thin");
  });
});
