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
  GuideOutput,
} from "../pipeline/schemas";
import type { TailorUserEdits } from "../pipeline/tailor-edits";

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
  // Added by the Guide feature. `guide` is the whole-search outlook generated
  // once per user and cached in `guides`; `chat` is one turn of the grounded
  // career-coach conversation on `/guide`. Both go through the same
  // prompt-version + generations + budget machinery as the job-level steps, so
  // their cost shows up in `usage_daily` and `/benchmark` alongside the rest.
  "guide",
  "chat",
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
  "workday",
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

/** Who wrote a `chat_messages` row. Only these two roles are persisted — the
 * system prompt is rebuilt from live profile data on every request rather than
 * stored, so a fact the user edits is reflected in the next turn. */
export const chatRoleEnum = pgEnum("chat_role", ["user", "assistant"]);

/**
 * How a user's base resume is stored (see `resumeBases`).
 *
 * `latex` — the real `.tex` document the user actually applies with (v1's
 * `resume.tex`). Tailoring splices new Technical Skills / Projects blocks
 * into it and compiles with `pdflatex`, so everything the user hand-tuned
 * (heading, education, experience, spacing) survives byte-for-byte.
 * `structured` — a JSON resume for users who have no LaTeX of their own;
 * rendered by the react-pdf template instead. Reserved for that path.
 */
export const resumeBaseKindEnum = pgEnum("resume_base_kind", [
  "latex",
  "structured",
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
    // True only for the synthetic `v1-orphan://…` rows `src/db/seed-v1.ts`
    // creates when an applications.csv row references a job_id missing from
    // jobs.csv — there is no real posting behind them (no title, company,
    // or URL worth showing). Real jobs are never placeholders. Consumers
    // that list jobs/applications for a human (product UI, the public
    // `/results` page) filter these out rather than render "Unknown
    // position (v1 job …)".
    isPlaceholder: boolean("is_placeholder").notNull().default(false),
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
    // Additive, nullable overlay on a `tailor` generation's `output` — the
    // user's retyped bullet text and explicitly-unchecked bullets (spec:
    // "store them as a 'tailor_edit' overlay on the generation"). Never set
    // for any other step. `output` itself stays exactly what the model
    // returned; apply this via `applyTailorEdits()` (src/pipeline/tailor-edits.ts)
    // to get what the user actually sees/downloads.
    userEdits: jsonb("user_edits").$type<TailorUserEdits>(),
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

export const applications = pgTable(
  "applications",
  {
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
  },
  (t) => [
    // At most one application per (user, job): re-applying to the same
    // posting is a status update on the existing row, not a new row — see
    // drizzle/0015_applications_user_job_uq.sql, which also merges/removes
    // the pre-existing duplicates (six identical `seed-v1` rows for one
    // Databricks job were the bug this closes).
    uniqueIndex("applications_user_job_uq").on(t.userId, t.jobId),
  ],
);

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

// ---------------------------------------------------------------------------
// Guide (personalized outlook + grounded chat)
// ---------------------------------------------------------------------------

/**
 * Cache of `guide` step outputs. The `/guide` page renders the newest row for
 * the user and "Regenerate" appends another, so the history is kept: an
 * outlook written in September is the record of what the advice was then, and
 * comparing it against a December one is the point.
 *
 * `output` holds the *checked* guide — claims whose `fact_ids` could not be
 * traced back to a confirmed fact are stripped before it is stored (same rule
 * as `tailor`'s PDF, spec §5). The unfiltered model reply is still in
 * `generations.output` via `generation_id` for debugging.
 */
export const guides = pgTable(
  "guides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // `onDelete` matters here in a way it does not for the older tables:
    // `deleteUserData()` (src/profile/facts.ts) deletes a user's rows table by
    // table in a fixed order and knows nothing about these three. Cascading
    // from `profiles` — and nulling the generation link, since that user's
    // `generations` rows are deleted in the same transaction — is what keeps
    // "Delete my data" working without that function having to enumerate every
    // table added after it.
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.userId, { onDelete: "cascade" }),
    generationId: uuid("generation_id").references(() => generations.id, {
      onDelete: "set null",
    }),
    output: jsonb("output").$type<GuideOutput>().notNull(),
    modelId: text("model_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("guides_user_created_idx").on(t.userId, t.createdAt)],
);

/**
 * A chat conversation. v1 gives each user exactly one thread (created on their
 * first message), but the schema is thread-based so "new conversation" is a
 * later insert rather than a later migration. `model_id` is the model the user
 * last picked in the model select, so their choice survives a reload.
 */
export const chatThreads = pgTable(
  "chat_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.userId, { onDelete: "cascade" }),
    title: text("title"),
    modelId: text("model_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("chat_threads_user_created_idx").on(t.userId, t.createdAt)],
);

/**
 * One turn. Token counts and cost are denormalized onto the assistant rows (a
 * user row has none) so the per-message cost hint in the UI is a plain read
 * rather than a join back through `generations`.
 */
export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    role: chatRoleEnum("role").notNull(),
    content: text("content").notNull(),
    modelId: text("model_id"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("chat_messages_thread_created_idx").on(t.threadId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Base resume (v1 parity — the real document tailoring starts from)
// ---------------------------------------------------------------------------

/**
 * A user's *base* resume: the document a tailored PDF is derived from, rather
 * than generated from scratch.
 *
 * v1's whole resume pipeline was "take the candidate's real `resume.tex`,
 * replace two blocks, run `pdflatex`" — so the education, experience,
 * heading, and typography the owner spent years tuning came out byte-identical
 * every time and only the parts that *should* change per posting did. v2's
 * first cut instead re-drew the page with react-pdf from the tailor step's
 * output alone, which is why the owner reported v2's PDFs as worse than v1's.
 * This table restores the v1 model: `latex` holds that `.tex` source, and
 * `src/pdf/latex.ts` splices into it.
 *
 * Rows are append-only — importing a new resume adds a row, and the newest
 * row for a user is the live base — so a tailored PDF produced last month can
 * still be explained by the base that existed then.
 *
 * `transcript_pdf_path` is a Supabase Storage path in the private `resumes`
 * bucket (`src/profile/storage.ts`), not a public URL: v1 optionally
 * Ghostscript-merged the candidate's transcript onto the end of the resume
 * for postings that ask for one.
 *
 * `onDelete: "cascade"` from `profiles` for the same reason `guides` has it —
 * `deleteUserData()` (src/profile/facts.ts) deletes `profiles` last and knows
 * nothing about tables added after it was written.
 */
export const resumeBases = pgTable(
  "resume_bases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.userId, { onDelete: "cascade" }),
    kind: resumeBaseKindEnum("kind").notNull().default("latex"),
    /** The full `.tex` source. Non-null exactly when `kind = 'latex'`. */
    latex: text("latex"),
    /** A JSON resume. Non-null exactly when `kind = 'structured'`. */
    structured: jsonb("structured").$type<unknown>(),
    /** `${userId}/transcript-<ts>.pdf` in the private `resumes` bucket. */
    transcriptPdfPath: text("transcript_pdf_path"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("resume_bases_user_created_idx").on(t.userId, t.createdAt)],
);

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
