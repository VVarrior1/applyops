import {
  pgTable,
  pgEnum,
  uuid,
  text,
  boolean,
  timestamp,
  jsonb,
  integer,
  numeric,
  date,
  primaryKey,
  uniqueIndex,
  index,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type {
  AnalyzeOutput,
  FitOutput,
  Fact,
} from "../pipeline/schemas";

/**
 * Drizzle schema for ApplyOps — spec §4 ("Data model").
 *
 * All user-owned rows carry `user_id`; the app enforces per-user access via
 * the server-side Supabase session (the app itself connects with the
 * service-role/`postgres` connection). RLS with owner-only policies is added
 * on top as defense in depth (see drizzle/0001_rls.sql).
 *
 * Table order below is chosen to avoid forward-reference foreign keys where
 * possible. `jobs.analysis_generation_id` and `generations.job_id` form a
 * genuine cycle (each table references a row in the other), but that's just
 * a forward reference at the TypeScript level, not a problem for Postgres:
 * drizzle-kit emits every foreign key as its own `ALTER TABLE ... ADD
 * CONSTRAINT` statement after all `CREATE TABLE`s run, so both directions of
 * the cycle are expressible. Both columns use the `(): AnyPgColumn => ...`
 * thunk idiom to reference a table declared later in this file.
 *
 * `profiles.user_id` is NOT declared with a drizzle `.references()` to
 * Supabase's `auth.users` table: `auth.users` is managed by Supabase Auth
 * (already exists in the database) and drizzle-kit has no way to express
 * "this table already exists, don't try to CREATE it" — a direct reference
 * would make `drizzle-kit generate` emit `CREATE TABLE "auth"."users" (...)`,
 * which fails against a real Supabase project. The FK is instead added by
 * raw SQL in drizzle/0001_rls.sql (`references auth.users(id)`), so
 * referential integrity is still enforced in Postgres.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const stepEnum = pgEnum("step", [
  "analyze",
  "fit",
  "tailor",
  "suggest",
  "judge",
  "extract_facts",
]);

/**
 * The pipeline step union, derived from the DB enum so there is exactly one
 * source of truth. Added by Task 4 (the LLM layer keys `DEFAULT_MODEL_BY_STEP`
 * and `callStructured({step})` off it); Task 5's step modules use it too.
 */
export type Step = (typeof stepEnum.enumValues)[number];

export const atsVendorEnum = pgEnum("ats_vendor", [
  "greenhouse",
  "lever",
  "ashby",
  "recruitee",
  "personio",
  "smartrecruiters",
  "yc",
  "other",
]);

export const outcomeTypeEnum = pgEnum("outcome_type", [
  "applied",
  "viewed",
  "response",
  "oa",
  "phone_screen",
  "interview",
  "offer",
  "rejected",
  "ghosted",
  "withdrawn",
]);

export const applicationStatusEnum = pgEnum("application_status", [
  "draft",
  "applied",
  "responded",
  "interviewing",
  "offer",
  "rejected",
  "ghosted",
  "withdrawn",
]);

export const workAuthSignalEnum = pgEnum("work_auth_signal", [
  "hires_canadians",
  "tn_friendly",
  "needs_us_auth",
  "unclear",
]);

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export const profiles = pgTable("profiles", {
  // Equals the corresponding auth.users.id (set by ensureProfile(), Task 3) —
  // no defaultRandom(): this PK is assigned, never generated. See file
  // header for why the FK to auth.users is added via raw SQL, not here.
  userId: uuid("user_id").primaryKey(),
  displayName: text("display_name"),
  isOwner: boolean("is_owner").notNull().default(false),
  dailyBudgetUsd: numeric("daily_budget_usd", { precision: 10, scale: 2 })
    .notNull()
    .default("1.00"),
  contact: jsonb("contact").$type<{ name?: string; email?: string; phone?: string; links?: string[] }>(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const allowedEmails = pgTable("allowed_emails", {
  email: text("email").primaryKey(),
  addedBy: text("added_by"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const profileFacts = pgTable(
  "profile_facts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.userId),
    label: text("label").notNull(),
    // 'experience' | 'project' | 'skill' | 'education' | 'other'
    category: text("category").notNull(),
    text: text("text").notNull(),
    // 'resume_upload' | 'manual'
    source: text("source").notNull().default("manual"),
    confirmed: boolean("confirmed").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("profile_facts_user_label_uq").on(t.userId, t.label)],
);

export const searchPrefs = pgTable("search_prefs", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => profiles.userId),
  roles: text("roles").array(),
  locations: text("locations").array(),
  // 'any' | 'remote' | 'hybrid' | 'onsite'
  remote: text("remote").notNull().default("any"),
  seniority: text("seniority").array(),
  // 'canada' | 'us_citizen_pr' | 'needs_sponsorship' | 'tn_eligible'
  workAuth: text("work_auth"),
  keywords: text("keywords").array(),
  excludedCompanies: text("excluded_companies").array(),
  // ISO-3166 alpha-2 codes the user will work in; jobs with unknown country always pass
  countries: text("countries").array().default(["CA", "US"]),
});

export const companies = pgTable(
  "companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    atsVendor: atsVendorEnum("ats_vendor").notNull(),
    atsSlug: text("ats_slug"),
    careersUrl: text("careers_url"),
    // 'v1_allowlist' | 'openjobs' | 'manual'
    source: text("source").notNull(),
    active: boolean("active").notNull().default(true),
  },
  (t) => [
    uniqueIndex("companies_vendor_slug_uq").on(t.atsVendor, t.atsSlug),
    // (ats_vendor, ats_slug) constrains nothing for rows with a null slug
    // (Postgres treats NULLs as distinct) — which is every company the v1
    // seed creates. This second index is what actually makes company
    // upserts idempotent for those rows; see upsertCompanyByName in
    // src/db/seed-v1.ts.
    uniqueIndex("companies_name_lower_uq").on(sql`lower(${t.name})`),
  ],
);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").references(() => companies.id),
    externalId: text("external_id"),
    url: text("url").notNull(),
    title: text("title").notNull(),
    location: text("location"),
    remote: boolean("remote"),
    description: text("description"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    scrapedAt: timestamp("scraped_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    // ISO-3166 alpha-2 codes detected from the location (null = not yet detected, [] = unknown/anywhere)
    countries: text("countries").array(),
    // Set false by `runFinders` for postings no board has listed for 30 days
    // (spec §6). Rows are never deleted — an application may point at a job
    // that has since been taken down, and the funnel still has to explain it.
    active: boolean("active").notNull().default(true),
    isEntryLevel: boolean("is_entry_level"),
    isRelevantRole: boolean("is_relevant_role"),
    workAuthSignal: workAuthSignalEnum("work_auth_signal"),
    analysis: jsonb("analysis").$type<AnalyzeOutput>(),
    analysisGenerationId: uuid("analysis_generation_id").references(
      (): AnyPgColumn => generations.id,
    ),
  },
  (t) => [
    uniqueIndex("jobs_url_uq").on(t.url),
    index("jobs_company_id_idx").on(t.companyId),
    index("jobs_posted_at_idx").on(t.postedAt),
  ],
);

export const promptVersions = pgTable(
  "prompt_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    step: stepEnum("step").notNull(),
    version: text("version").notNull(),
    sha256: text("sha256").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("prompt_versions_step_version_uq").on(t.step, t.version)],
);

export const generations = pgTable(
  "generations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Nullable: owner CLI/eval calls run with userId null (budget bypass).
    userId: uuid("user_id").references(() => profiles.userId),
    jobId: uuid("job_id").references((): AnyPgColumn => jobs.id),
    step: stepEnum("step").notNull(),
    promptVersionId: uuid("prompt_version_id").references(
      () => promptVersions.id,
    ),
    modelId: text("model_id").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 }),
    latencyMs: integer("latency_ms"),
    output: jsonb("output").$type<unknown>(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("generations_user_created_idx").on(t.userId, t.createdAt)],
);

export const jobScores = pgTable(
  "job_scores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.userId),
    rankerVersion: text("ranker_version").notNull(),
    score: integer("score").notNull(),
    matched: jsonb("matched").$type<FitOutput["matched"]>(),
    gaps: jsonb("gaps").$type<FitOutput["gaps"]>(),
    rationale: text("rationale"),
    generationId: uuid("generation_id").references(() => generations.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("job_scores_job_user_ranker_uq").on(
      t.jobId,
      t.userId,
      t.rankerVersion,
    ),
    index("job_scores_user_score_idx").on(t.userId, t.score),
  ],
);

export const applications = pgTable("applications", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => profiles.userId),
  jobId: uuid("job_id")
    .notNull()
    .references(() => jobs.id),
  tailorGenerationId: uuid("tailor_generation_id").references(
    () => generations.id,
  ),
  resumePdfPath: text("resume_pdf_path"),
  status: applicationStatusEnum("status").notNull().default("draft"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const outcomeEvents = pgTable(
  "outcome_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id),
    type: outcomeTypeEnum("type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    notes: text("notes"),
  },
  (t) => [index("outcome_events_application_id_idx").on(t.applicationId)],
);

export const approvals = pgTable("approvals", {
  id: uuid("id").primaryKey().defaultRandom(),
  applicationId: uuid("application_id")
    .notNull()
    .references(() => applications.id),
  screenshotPath: text("screenshot_path"),
  summary: text("summary"),
  // 'pending' | 'approved' | 'declined'
  decision: text("decision").notNull().default("pending"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
});

export const evalItems = pgTable("eval_items", {
  sampleGenerationId: uuid("sample_generation_id"),
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").references(() => jobs.id),
  profileSnapshot: jsonb("profile_snapshot").$type<Fact[]>(),
  step: stepEnum("step").notNull(),
  humanGrades: jsonb("human_grades").$type<{
    grounding: number;
    coverage: number;
    specificity: number;
    stuffing_penalty: number;
    grader: string;
    graded_at: string;
  }>(),
  notes: text("notes"),
});

export const evalRuns = pgTable("eval_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  step: stepEnum("step").notNull(),
  modelId: text("model_id").notNull(),
  promptVersionId: uuid("prompt_version_id").references(
    () => promptVersions.id,
  ),
  gitSha: text("git_sha"),
  itemCount: integer("item_count"),
  metrics: jsonb("metrics").$type<{
    mean_score: number;
    hallucination_rate: number;
    kappa: number;
    cost_usd: number;
    p50_ms: number;
    p95_ms: number;
    ci95: Record<string, unknown>;
  }>(),
  baseline: boolean("baseline").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const evalResults = pgTable("eval_results", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id")
    .notNull()
    .references(() => evalRuns.id),
  itemId: uuid("item_id").references(() => evalItems.id),
  generationId: uuid("generation_id").references(() => generations.id),
  judgeScores: jsonb("judge_scores").$type<{
    grounding: number;
    coverage: number;
    specificity: number;
    stuffing_penalty: number;
  }>(),
  hallucinationCount: integer("hallucination_count"),
  unsupportedClaims: jsonb("unsupported_claims").$type<unknown>(),
  costUsd: numeric("cost_usd", { precision: 10, scale: 6 }),
  latencyMs: integer("latency_ms"),
});

export const usageDaily = pgTable(
  "usage_daily",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.userId),
    date: date("date").notNull(),
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 })
      .notNull()
      .default("0"),
    calls: integer("calls").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.date] })],
);
