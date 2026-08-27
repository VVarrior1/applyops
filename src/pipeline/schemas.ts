/**
 * STUB — Task 2 placeholder.
 *
 * Task 5 replaces this file with zod schemas (spec §5) and derives these same
 * type names via `z.infer<typeof ...>`. The shapes below are hand-written to
 * match spec §5 exactly so that `src/db/schema.ts`'s `jsonb().$type<...>()`
 * columns compile now and keep compiling once Task 5 lands (structural
 * typing — no import sites need to change).
 *
 * Do not add runtime logic here; this file is types-only on purpose so it can
 * be imported `import type { ... }` from db/schema.ts without pulling zod
 * into the migration/seed bundle.
 */

export type WorkAuthSignal =
  | "hires_canadians"
  | "tn_friendly"
  | "needs_us_auth"
  | "unclear";

export interface AnalyzeOutput {
  requirements: { text: string; must_have: boolean }[];
  nice_to_have: string[];
  seniority: string;
  years_min: number;
  work_auth_signal: WorkAuthSignal;
  keywords: string[];
  summary: string;
}

export interface FitOutput {
  score: number;
  matched: { requirement: string; fact_ids: string[] }[];
  gaps: string[];
  rationale: string;
}

export interface TailorOutput {
  summary: string;
  skills: string[];
  sections: {
    heading: string;
    bullets: { text: string; fact_ids: string[] }[];
  }[];
}

export interface SuggestOutput {
  gaps: { requirement: string; severity: string; how_to_close: string }[];
  lead_with: { fact_ids: string[]; why: string }[];
  weekend_build: { idea: string; why: string; fact_ids: string[] };
  likely_questions: string[];
  keywords_to_include: string[];
}

export interface JudgeOutput {
  grounding: number;
  coverage: number;
  specificity: number;
  stuffing_penalty: number;
  rationale: string;
}

export interface ExtractFactsOutput {
  facts: { category: string; text: string; evidence_span: string }[];
}

/** Confirmed profile fact as rendered into prompts, e.g. "F-014 | project | Built ...". */
export interface Fact {
  label: string;
  category: string;
  text: string;
}
