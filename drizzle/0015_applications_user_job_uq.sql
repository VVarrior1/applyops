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

-- `approvals.application_id` is also a NOT NULL FK onto `applications.id`
-- (src/db/schema.ts), same as outcome_events above — re-point it off any
-- duplicate onto the survivor for the same reason, otherwise the DELETE
-- below aborts on FK violation the moment a duplicate has an approvals row.
WITH survivors AS (
  SELECT DISTINCT ON (user_id, job_id) id, user_id, job_id
  FROM "applications"
  ORDER BY user_id, job_id, created_at ASC, id ASC
)
UPDATE "approvals" ap
SET application_id = s.id
FROM "applications" a
JOIN survivors s ON s.user_id = a.user_id AND s.job_id = a.job_id
WHERE ap.application_id = a.id
  AND a.id <> s.id;--> statement-breakpoint

-- The survivor (earliest-created duplicate) is not necessarily the one that
-- carries `tailor_generation_id` / `resume_pdf_path` — a later regeneration
-- row often does. Backfill those two fields onto the survivor from the most
-- recent duplicate that has a value, before the dropped rows (and whatever
-- they point to) are gone for good. Known-lossy either way: if more than
-- one duplicate has a value, only the newest one's is kept — acceptable
-- here since these are cosmetic/attribution fields, not outcome history.
WITH survivors AS (
  SELECT DISTINCT ON (user_id, job_id) id, user_id, job_id
  FROM "applications"
  ORDER BY user_id, job_id, created_at ASC, id ASC
), newest_with_value AS (
  SELECT DISTINCT ON (a.user_id, a.job_id)
    a.user_id, a.job_id, a.tailor_generation_id, a.resume_pdf_path
  FROM "applications" a
  WHERE a.tailor_generation_id IS NOT NULL OR a.resume_pdf_path IS NOT NULL
  ORDER BY a.user_id, a.job_id, a.created_at DESC, a.id DESC
)
UPDATE "applications" s
SET tailor_generation_id = COALESCE(s.tailor_generation_id, n.tailor_generation_id),
    resume_pdf_path = COALESCE(s.resume_pdf_path, n.resume_pdf_path)
FROM survivors sv
JOIN newest_with_value n ON n.user_id = sv.user_id AND n.job_id = sv.job_id
WHERE s.id = sv.id;--> statement-breakpoint

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
