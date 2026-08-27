CREATE TYPE "public"."application_status" AS ENUM('draft', 'applied', 'responded', 'interviewing', 'offer', 'rejected', 'ghosted', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."ats_vendor" AS ENUM('greenhouse', 'lever', 'ashby', 'recruitee', 'personio', 'smartrecruiters', 'yc', 'other');--> statement-breakpoint
CREATE TYPE "public"."outcome_type" AS ENUM('applied', 'viewed', 'response', 'oa', 'phone_screen', 'interview', 'offer', 'rejected', 'ghosted', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."step" AS ENUM('analyze', 'fit', 'tailor', 'suggest', 'judge', 'extract_facts');--> statement-breakpoint
CREATE TYPE "public"."work_auth_signal" AS ENUM('hires_canadians', 'tn_friendly', 'needs_us_auth', 'unclear');--> statement-breakpoint
CREATE TABLE "allowed_emails" (
	"email" text PRIMARY KEY NOT NULL,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"tailor_generation_id" uuid,
	"resume_pdf_path" text,
	"status" "application_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"screenshot_path" text,
	"summary" text,
	"decision" text DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"ats_vendor" "ats_vendor" NOT NULL,
	"ats_slug" text,
	"careers_url" text,
	"source" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid,
	"profile_snapshot" jsonb,
	"step" "step" NOT NULL,
	"human_grades" jsonb,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "eval_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"item_id" uuid,
	"generation_id" uuid,
	"judge_scores" jsonb,
	"hallucination_count" integer,
	"unsupported_claims" jsonb,
	"cost_usd" numeric(10, 6),
	"latency_ms" integer
);
--> statement-breakpoint
CREATE TABLE "eval_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"step" "step" NOT NULL,
	"model_id" text NOT NULL,
	"prompt_version_id" uuid,
	"git_sha" text,
	"item_count" integer,
	"metrics" jsonb,
	"baseline" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"job_id" uuid,
	"step" "step" NOT NULL,
	"prompt_version_id" uuid,
	"model_id" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" numeric(10, 6),
	"latency_ms" integer,
	"output" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"ranker_version" text NOT NULL,
	"score" integer NOT NULL,
	"matched" jsonb,
	"gaps" jsonb,
	"rationale" text,
	"generation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"external_id" text,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"location" text,
	"remote" boolean,
	"description" text,
	"posted_at" timestamp with time zone,
	"scraped_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"is_entry_level" boolean,
	"is_relevant_role" boolean,
	"work_auth_signal" "work_auth_signal",
	"analysis" jsonb,
	"analysis_generation_id" uuid
);
--> statement-breakpoint
CREATE TABLE "outcome_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"type" "outcome_type" NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "profile_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"label" text NOT NULL,
	"category" text NOT NULL,
	"text" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"confirmed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"display_name" text,
	"is_owner" boolean DEFAULT false NOT NULL,
	"daily_budget_usd" numeric(10, 2) DEFAULT '1.00' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompt_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"step" "step" NOT NULL,
	"version" text NOT NULL,
	"sha256" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_prefs" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"roles" text[],
	"locations" text[],
	"remote" text DEFAULT 'any' NOT NULL,
	"seniority" text[],
	"work_auth" text,
	"keywords" text[],
	"excluded_companies" text[]
);
--> statement-breakpoint
CREATE TABLE "usage_daily" (
	"user_id" uuid NOT NULL,
	"date" date NOT NULL,
	"cost_usd" numeric(10, 6) DEFAULT '0' NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_daily_user_id_date_pk" PRIMARY KEY("user_id","date")
);
--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_user_id_profiles_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_tailor_generation_id_generations_id_fk" FOREIGN KEY ("tailor_generation_id") REFERENCES "public"."generations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_items" ADD CONSTRAINT "eval_items_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_run_id_eval_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."eval_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_item_id_eval_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."eval_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_generation_id_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."generations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_prompt_version_id_prompt_versions_id_fk" FOREIGN KEY ("prompt_version_id") REFERENCES "public"."prompt_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_user_id_profiles_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_prompt_version_id_prompt_versions_id_fk" FOREIGN KEY ("prompt_version_id") REFERENCES "public"."prompt_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_scores" ADD CONSTRAINT "job_scores_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_scores" ADD CONSTRAINT "job_scores_user_id_profiles_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_scores" ADD CONSTRAINT "job_scores_generation_id_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."generations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_events" ADD CONSTRAINT "outcome_events_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_facts" ADD CONSTRAINT "profile_facts_user_id_profiles_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_prefs" ADD CONSTRAINT "search_prefs_user_id_profiles_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_daily" ADD CONSTRAINT "usage_daily_user_id_profiles_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "companies_vendor_slug_uq" ON "companies" USING btree ("ats_vendor","ats_slug");--> statement-breakpoint
CREATE INDEX "generations_user_created_idx" ON "generations" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "job_scores_job_user_ranker_uq" ON "job_scores" USING btree ("job_id","user_id","ranker_version");--> statement-breakpoint
CREATE INDEX "job_scores_user_score_idx" ON "job_scores" USING btree ("user_id","score");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_url_uq" ON "jobs" USING btree ("url");--> statement-breakpoint
CREATE INDEX "jobs_company_id_idx" ON "jobs" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "jobs_posted_at_idx" ON "jobs" USING btree ("posted_at");--> statement-breakpoint
CREATE INDEX "outcome_events_application_id_idx" ON "outcome_events" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_facts_user_label_uq" ON "profile_facts" USING btree ("user_id","label");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_versions_step_version_uq" ON "prompt_versions" USING btree ("step","version");