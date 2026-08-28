ALTER TABLE "jobs" ADD COLUMN "is_placeholder" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- Mark `src/db/seed-v1.ts`'s synthetic `v1-orphan://…` jobs (created when an
-- applications.csv row pointed at a job_id missing from jobs.csv) as
-- placeholders — there is no real posting behind them, so product UI and
-- the public `/results` page filter them out instead of rendering
-- "Unknown position (v1 job …)".
UPDATE "jobs" SET "is_placeholder" = true WHERE "url" LIKE 'v1-orphan://%';--> statement-breakpoint

-- One-time cleanup for the exact bug the unique index below now prevents:
-- `seed-v1.ts` created one `applications` row per v1 applications.csv row,
-- but v1 logged one row per resume *regeneration*, not per real
-- application — e.g. one real Databricks application had 6 byte-identical
-- rows in production. Pick a single canonical row per (user_id, job_id) —
-- the earliest created (ties broken by id), i.e. the row the CSV-order
-- import loop would have created first — and re-point every outcome_event
-- from a duplicate onto that survivor first, so no logged outcome
-- (including one a real user clicked through the UI on a duplicate row) is
-- lost, before dropping the duplicate applications.
WITH survivors AS (
  SELECT DISTINCT ON (user_id, job_id) id, user_id, job_id
  FROM "applications"
  ORDER BY user_id, job_id, created_at ASC, id ASC
)
UPDATE "outcome_events" oe
SET application_id = s.id
FROM "applications" a
JOIN survivors s ON s.user_id = a.user_id AND s.job_id = a.job_id
WHERE oe.application_id = a.id
  AND a.id <> s.id;--> statement-breakpoint

WITH survivors AS (
  SELECT DISTINCT ON (user_id, job_id) id, user_id, job_id
  FROM "applications"
  ORDER BY user_id, job_id, created_at ASC, id ASC
)
DELETE FROM "applications" a
USING survivors s
WHERE a.user_id = s.user_id
  AND a.job_id = s.job_id
  AND a.id <> s.id;--> statement-breakpoint

CREATE UNIQUE INDEX "applications_user_job_uq" ON "applications" USING btree ("user_id","job_id");
