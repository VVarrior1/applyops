/**
 * Zod output schemas for every pipeline step — spec §5.
 *
 * Each step is "a versioned prompt file + a zod output schema + a pure
 * `run<Step>()` function". This module owns the middle piece: the schema is
 * what `callStructured()` hands to the AI SDK (`Output.object({schema})`), so
 * a model reply that does not match is a *typed* failure with exactly one
 * repair round trip, never a silently half-populated object.
 *
 * ## One name for the schema and its type
 *
 * Every export below is declared twice on purpose:
 *
 * ```ts
 * export const TailorOutput = z.object({ ... });
 * export type  TailorOutput = z.infer<typeof TailorOutput>;
 * ```
 *
 * A value and a type may share a name in TypeScript (they live in different
 * declaration spaces), which means `TailorOutput.parse(x)` and
 * `const t: TailorOutput` both read naturally, and `src/db/schema.ts` can keep
 * its existing `import type { AnalyzeOutput } from "../pipeline/schemas"` —
 * a type-only import, so the migration/seed bundle still never pulls in zod.
 *
 * ## Why the enums are narrower than the spec table
 *
 * The spec writes `seniority` and `severity` as free strings. They are enums
 * here because downstream code compares them: the ranker filters on seniority
 * bands and the UI colour-codes gap severity. An open string would push that
 * normalisation into every consumer. `work_auth_signal` is an enum because it
 * is written straight into the `work_auth_signal` Postgres enum column, and
 * the two lists must not drift.
 *
 * Nothing here uses `.refine()`: these schemas are converted to JSON Schema
 * for the provider, and a refinement that survives in zod but vanishes in the
 * JSON Schema is a rule the model is never told about. Cross-field rules that
 * matter (every bullet cites a real fact) are enforced mechanically instead —
 * see `src/pipeline/hallucination.ts`.
 */

import { z } from "zod";
import type { Step } from "../db/schema";

// ---------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------

/**
 * Mirrors the `work_auth_signal` Postgres enum (`src/db/schema.ts`). Keep the
 * two lists identical — an analysis is written directly into that column.
 */
export const WORK_AUTH_SIGNALS = [
  "hires_canadians",
  "tn_friendly",
  "needs_us_auth",
  "unclear",
] as const;

export const WorkAuthSignal = z.enum(WORK_AUTH_SIGNALS);
export type WorkAuthSignal = z.infer<typeof WorkAuthSignal>;

/** Seniority bands the ranker can compare against a user's `search_prefs`. */
export const SENIORITY_LEVELS = [
  "intern",
  "new_grad",
  "junior",
  "mid",
  "senior",
  "staff",
  "principal",
  "manager",
  "unclear",
] as const;

export const Seniority = z.enum(SENIORITY_LEVELS);
export type Seniority = z.infer<typeof Seniority>;

/** Matches the `profile_facts.category` values documented in spec §4. */
export const FACT_CATEGORIES = [
  "experience",
  "project",
  "skill",
  "education",
  "other",
] as const;

export const FactCategory = z.enum(FACT_CATEGORIES);
export type FactCategory = z.infer<typeof FactCategory>;

/**
 * A confirmed profile fact as the pipeline sees it. Rendered into prompts as
 * `F-014 | project | Built ...` (see `renderFacts()` in `src/pipeline/steps`),
 * and frozen into `eval_items.profile_snapshot` so an eval run is reproducible
 * even after the user edits their profile.
 */
export const Fact = z.object({
  /** Stable citation label, `F-001`-style. The only thing a model may cite. */
  label: z.string().min(1),
  category: z.string().min(1),
  text: z.string().min(1),
});
export type Fact = z.infer<typeof Fact>;

/** A resume bullet plus the fact labels that back it. */
export const CitedBullet = z.object({
  text: z.string().min(1).describe("One resume bullet, at most 28 words."),
  fact_ids: z
    .array(z.string())
    .describe(
      "Labels of the facts this bullet is drawn from, e.g. ['F-014']. Must be non-empty and every label must appear in the supplied fact list.",
    ),
});
export type CitedBullet = z.infer<typeof CitedBullet>;

// ---------------------------------------------------------------------------
// extract_facts
// ---------------------------------------------------------------------------

export const ExtractFactsOutput = z.object({
  facts: z
    .array(
      z.object({
        category: FactCategory,
        text: z
          .string()
          .min(1)
          .describe(
            "Self-contained sentence, at most 30 words, naming the employer or project it belongs to.",
          ),
        evidence_span: z
          .string()
          .min(1)
          .describe(
            "Verbatim substring of the resume text this fact was taken from.",
          ),
      }),
    )
    .describe("One entry per line item on the resume. Never merge two."),
});
export type ExtractFactsOutput = z.infer<typeof ExtractFactsOutput>;

// ---------------------------------------------------------------------------
// analyze  (per job, cached in jobs.analysis and shared across users)
// ---------------------------------------------------------------------------

export const AnalyzeOutput = z.object({
  requirements: z
    .array(
      z.object({
        text: z.string().min(1),
        must_have: z
          .boolean()
          .describe(
            "True only when the posting frames it as required, not preferred.",
          ),
      }),
    )
    .describe("4-10 requirements or responsibilities lifted from the posting."),
  nice_to_have: z
    .array(z.string())
    .describe("Phrases the posting explicitly marks as optional."),
  seniority: Seniority,
  years_min: z
    .number()
    .int()
    .min(0)
    .describe("Minimum years of professional experience demanded; 0 if none."),
  work_auth_signal: WorkAuthSignal,
  keywords: z
    .array(z.string())
    .describe("5-15 lowercase technology/domain terms an ATS would key on."),
  summary: z.string().min(1).describe("2-3 sentences about the role."),
});
export type AnalyzeOutput = z.infer<typeof AnalyzeOutput>;

// ---------------------------------------------------------------------------
// fit  (the ranker — per job per user)
// ---------------------------------------------------------------------------

export const FitOutput = z.object({
  score: z.number().int().min(0).max(100),
  matched: z
    .array(
      z.object({
        requirement: z.string().min(1),
        fact_ids: z
          .array(z.string())
          .describe("Labels of the facts that prove this requirement is met."),
      }),
    )
    .describe("One entry per must-have requirement the candidate truly meets."),
  gaps: z
    .array(z.string())
    .describe("What is missing or disqualifying, most important first."),
  rationale: z.string().min(1).describe("2-4 sentences a human can act on."),
});
export type FitOutput = z.infer<typeof FitOutput>;

// ---------------------------------------------------------------------------
// tailor
// ---------------------------------------------------------------------------

export const TailorOutput = z.object({
  summary: z
    .string()
    .min(1)
    .describe("2-3 sentence positioning statement, supported by the facts."),
  skills: z
    .array(z.string())
    .describe("6-10 skills, most relevant first; each backed by a fact."),
  sections: z
    .array(
      z.object({
        heading: z.string().min(1).describe("e.g. Experience, Projects, Education"),
        bullets: z.array(CitedBullet),
      }),
    )
    .describe("2-4 sections ordered by relevance to the posting."),
});
export type TailorOutput = z.infer<typeof TailorOutput>;

// ---------------------------------------------------------------------------
// suggest
// ---------------------------------------------------------------------------

export const GapSeverity = z.enum(["low", "medium", "high"]);
export type GapSeverity = z.infer<typeof GapSeverity>;

export const SuggestOutput = z.object({
  gaps: z
    .array(
      z.object({
        requirement: z.string().min(1),
        severity: GapSeverity,
        how_to_close: z
          .string()
          .min(1)
          .describe("One concrete, time-boxed action. Never 'learn X'."),
      }),
    )
    .describe("Real gaps between the posting's must-haves and the facts."),
  lead_with: z
    .array(
      z.object({
        fact_ids: z
          .array(z.string())
          .describe("Labels of the facts to put in front of the recruiter."),
        why: z.string().min(1).describe("One sentence on why it lands here."),
      }),
    )
    .describe("2-4 entries, strongest first."),
  weekend_build: z
    .object({
      idea: z.string().min(1),
      why: z.string().min(1),
      fact_ids: z
        .array(z.string())
        .describe("Labels of the existing facts this build extends."),
    })
    .describe("One two-day project that closes the highest-severity gap."),
  likely_questions: z
    .array(z.string())
    .describe("3-5 screening questions this posting makes likely."),
  keywords_to_include: z
    .array(z.string())
    .describe("5-10 lowercase terms the candidate can honestly use."),
});
export type SuggestOutput = z.infer<typeof SuggestOutput>;

// ---------------------------------------------------------------------------
// guide  (whole-search outlook — one per user, cached in `guides`)
// ---------------------------------------------------------------------------

/** How long closing a gap realistically takes, so a plan can be sequenced. */
export const GapEffort = z.enum(["days", "weeks", "months"]);
export type GapEffort = z.infer<typeof GapEffort>;

/**
 * One thing to do, why it matters, and the facts it builds on. `fact_ids` may
 * be empty for an action that is not a claim about the candidate's history
 * ("apply to 8 postings a week"); it must never contain a label the user does
 * not have. See `checkGuideCitations()` in `src/pipeline/steps/guide.ts`.
 */
export const GuideAction = z.object({
  action: z
    .string()
    .min(1)
    .describe("One concrete, checkable action. Never 'network more'."),
  why: z.string().min(1).describe("One sentence tying it to this candidate."),
  fact_ids: z
    .array(z.string())
    .describe(
      "Labels of the facts this action builds on, e.g. ['F-014']. Empty only when the action makes no claim about the candidate's history.",
    ),
});
export type GuideAction = z.infer<typeof GuideAction>;

export const GuideOutput = z.object({
  where_you_stand: z
    .string()
    .min(1)
    .describe(
      "3-5 sentences: an honest read of this candidate's position in this market right now, grounded in their facts.",
    ),
  strengths: z
    .array(
      z.object({
        text: z
          .string()
          .min(1)
          .describe("One strength, phrased as what it lets them apply to."),
        fact_ids: z
          .array(z.string())
          .describe("Labels of the facts that evidence it. Never empty."),
      }),
    )
    .describe("3-6 strengths, each cited. Strongest first."),
  realistic_targets: z.object({
    role_types: z
      .array(z.string())
      .describe("3-6 role titles they can realistically land, most likely first."),
    company_types: z
      .array(z.string())
      .describe("3-5 kinds of employer where those roles actually exist for them."),
    geographies: z
      .array(
        z.object({
          region: z.string().min(1).describe("e.g. Calgary, Toronto, US remote"),
          why: z.string().min(1).describe("Why this market fits this candidate."),
          notes_for_canadians: z
            .string()
            .min(1)
            .describe(
              "The work-authorization reality for a Canadian citizen in this market: TN, H-1B lottery, Canada-based remote, or 'not applicable — this is Canada'.",
            ),
        }),
      )
      .describe("2-4 markets, best first."),
  }),
  gaps: z
    .array(
      z.object({
        gap: z.string().min(1),
        why_it_matters: z
          .string()
          .min(1)
          .describe("What it costs them in screens or interviews."),
        how_to_close: z
          .string()
          .min(1)
          .describe("One concrete, time-boxed action. Never 'learn X'."),
        effort: GapEffort,
      }),
    )
    .describe("3-5 real gaps against their stated targets, most damaging first."),
  plan_30_60_90: z
    .object({
      days_30: z.array(GuideAction).describe("3-5 actions for the first 30 days."),
      days_60: z.array(GuideAction).describe("2-4 actions for days 31-60."),
      days_90: z.array(GuideAction).describe("2-4 actions for days 61-90."),
    })
    .describe("A sequenced plan; later phases build on earlier ones."),
  interview_prep_focus: z
    .array(
      z.object({
        topic: z.string().min(1),
        why: z
          .string()
          .min(1)
          .describe("Why this topic, for these targets and these facts."),
        resources_hint: z
          .string()
          .min(1)
          .describe("A kind of resource or drill, not a URL."),
      }),
    )
    .describe("3-5 topics, in the order they should be studied."),
  positioning_tips: z
    .array(z.string())
    .describe("3-6 specific things to change in how they present themselves."),
  application_cadence: z.object({
    per_week: z
      .number()
      .int()
      .min(1)
      .max(50)
      .describe("Applications per week this candidate can sustain at quality."),
    rationale: z
      .string()
      .min(1)
      .describe("Why that number, given their time and the tailoring effort."),
  }),
  market_notes: z
    .array(z.string())
    .describe("3-5 things about the current market that change their strategy."),
  caveats: z
    .array(z.string())
    .describe(
      "2-4 honest limits on this advice: what it is guessing at, and what would change it.",
    ),
});
export type GuideOutput = z.infer<typeof GuideOutput>;

// ---------------------------------------------------------------------------
// chat  (one turn of the grounded career-coach conversation on /guide)
// ---------------------------------------------------------------------------

/**
 * `chat` is the one step that streams free text rather than a structured
 * object, so it never goes through `callStructured()`/`Output.object()`. This
 * schema exists because every step has one: it is the shape of the
 * `generations.output` row the chat route writes after a turn finishes, which
 * is what keeps the step's cost and history readable by the same tooling as
 * everything else.
 */
export const ChatOutput = z.object({
  text: z.string().describe("The assistant's reply, as sent to the user."),
});
export type ChatOutput = z.infer<typeof ChatOutput>;

// ---------------------------------------------------------------------------
// judge  (fixed model; grades a tailor output — spec §7)
// ---------------------------------------------------------------------------

const rubricScore = z.number().int().min(1).max(5);

export const JudgeOutput = z.object({
  grounding: rubricScore.describe("Is every claim supported by a cited fact?"),
  coverage: rubricScore.describe("Are the posting's must-haves addressed?"),
  specificity: rubricScore.describe("Concrete and quantified, not duties?"),
  stuffing_penalty: rubricScore.describe(
    "5 = no keyword stuffing; 1 = egregious stuffing.",
  ),
  rationale: z.string().min(1).describe("2-4 sentences naming the worst problem."),
});
export type JudgeOutput = z.infer<typeof JudgeOutput>;

/** The four axes, in the order the grading UI and the eval report show them. */
export const JUDGE_AXES = [
  "grounding",
  "coverage",
  "specificity",
  "stuffing_penalty",
] as const;
export type JudgeAxis = (typeof JUDGE_AXES)[number];

// ---------------------------------------------------------------------------
// Step → schema
// ---------------------------------------------------------------------------

/**
 * Lets generic machinery (the eval runner, the benchmark, the CLI) validate a
 * stored `generations.output` for an arbitrary step without a switch.
 */
export const SCHEMA_BY_STEP = {
  analyze: AnalyzeOutput,
  fit: FitOutput,
  tailor: TailorOutput,
  suggest: SuggestOutput,
  judge: JudgeOutput,
  extract_facts: ExtractFactsOutput,
  guide: GuideOutput,
  chat: ChatOutput,
} as const satisfies Record<Step, z.ZodType>;

/** The output type of each step, keyed by step name. */
export type OutputByStep = {
  [K in keyof typeof SCHEMA_BY_STEP]: z.infer<(typeof SCHEMA_BY_STEP)[K]>;
};
