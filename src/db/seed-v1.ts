import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Papa from "papaparse";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { and, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { getDirectDb } from "./client";
import { applications, jobs, outcomeEvents, profiles } from "./schema";
import type * as schema from "./schema";

/**
 * Imports v1's CSV "database" (`Job_Auto_Apply/data/{jobs,applications}.csv`)
 * into the new Postgres schema. Idempotent — safe to re-run.
 *
 * Scope, matching plan Task 2 Step 4 exactly:
 *  - companies: upserted by name (ats_vendor 'other', source 'v1_allowlist').
 *  - jobs: upserted by url. v1's `status` / `priority_score` / `notes` /
 *    `applied_at` columns live on the job row, not ours — they only matter
 *    for the 7 jobs that have a matching applications.csv row (handled
 *    below); the other ~200 jobs get no application/outcome rows.
 *  - v1's `analysis` JSON ({summary, key_requirements, top_skills_needed,
 *    role_type, experience_level, key_pointers, match_score}) does NOT match
 *    our pipeline's AnalyzeOutput shape (spec §5: requirements[], keywords[],
 *    work_auth_signal, ...). We deliberately do not force it into
 *    jobs.analysis — that column, plus is_entry_level / is_relevant_role /
 *    work_auth_signal, stay null until the real pipeline (Task 5) and
 *    filters (Task 7) run on these jobs.
 *  - applications: one row per applications.csv row, owned by OWNER_EMAIL
 *    (profile created if missing, is_owner=true), with an `applied`
 *    outcome_event at the row's created_at; an extra outcome_event
 *    (`interview`, `rejected`, or `response` for v1 status `reviewing`) is
 *    added when that application's v1 job has that status.
 */

// Resolve `.env.local` relative to the repo root (not `process.cwd()`), so
// this script works when invoked from anywhere, not just the repo root.
dotenv.config({
  path: path.resolve(fileURLToPath(import.meta.url), "../../..", ".env.local"),
  quiet: true,
});

// v1's data directory lives only on the machine that ran v1 — override with
// V1_DATA_DIR for CI or any other machine. If it's absent, skip the seed
// with a clear message instead of an opaque ENOENT.
const V1_DATA_DIR = process.env.V1_DATA_DIR ?? "/Users/abdu/Job_Auto_Apply/data";
const V1_JOBS_CSV = path.join(V1_DATA_DIR, "jobs.csv");
const V1_APPLICATIONS_CSV = path.join(V1_DATA_DIR, "applications.csv");

export interface V1JobRow {
  id: string;
  url: string;
  title: string;
  company: string;
  location: string;
  remote: string;
  description: string;
  source: string;
  scraped_at: string;
  posted_at: string;
  priority_score: string;
  status: string;
  applied_at: string;
  notes: string;
  analysis: string;
}

export interface V1ApplicationRow {
  id: string;
  job_id: string;
  tailored_summary: string;
  tailored_skills: string;
  created_at: string;
  pdf_path: string;
}

function readCsv<T>(filePath: string): T[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const result = Papa.parse<T>(content, { header: true, skipEmptyLines: true });
  if (result.errors.length > 0) {
    console.warn(
      `[seed-v1] ${result.errors.length} CSV parse warning(s) in ${filePath} (first: ${result.errors[0].message} @ row ${result.errors[0].row})`,
    );
  }
  return result.data;
}

function toDate(value: string | undefined | null): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function toBool(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  return value === "true" || value === "TRUE" || value === "1";
}

export type Db = PostgresJsDatabase<typeof schema>;

/** Upsert a company by name, case-insensitively, in a single atomic
 * statement — relies on the `companies_name_lower_uq` unique index on
 * `lower(name)` (see src/db/schema.ts). Drizzle's typed `onConflictDoUpdate`
 * only accepts column targets, not expression-index targets, so this uses a
 * raw `on conflict (lower(name))` upsert. Safe under concurrent callers
 * (this seed script and Task 7's importV1Allowlists() both call this),
 * unlike the previous select-then-insert version. */
async function upsertCompanyByName(
  db: Db,
  cache: Map<string, string>,
  name: string,
): Promise<string> {
  const key = name.trim();
  const cached = cache.get(key);
  if (cached) return cached;

  const rows = (await db.execute(sql`
    insert into companies (name, ats_vendor, source, active)
    values (${key}, 'other', 'v1_allowlist', true)
    on conflict (lower(name)) do update set name = excluded.name
    returning id
  `)) as unknown as Array<{ id: string }>;
  const id = rows[0].id;
  cache.set(key, id);
  return id;
}

async function upsertJobByUrl(
  db: Db,
  url: string,
  values: Omit<typeof jobs.$inferInsert, "url">,
): Promise<string> {
  const [row] = await db
    .insert(jobs)
    .values({ url, ...values })
    .onConflictDoUpdate({ target: jobs.url, set: values })
    .returning({ id: jobs.id });
  return row.id;
}

/** Look up (or create) the Supabase auth user for an email via the admin
 * API — needed because profiles.user_id has a hard FK to auth.users, and at
 * seed time (before Task 3's login flow exists) the owner has likely never
 * signed in. Idempotent: reuses the real user once they do sign in later. */
async function ensureAuthUser(admin: SupabaseClient, email: string): Promise<string> {
  const created = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (!created.error && created.data.user) return created.data.user.id;

  const list = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (list.error) {
    throw new Error(
      `Could not create (${created.error?.message}) or list (${list.error.message}) auth user for ${email}`,
    );
  }
  const match = list.data.users.find(
    (u) => u.email?.toLowerCase() === email.toLowerCase(),
  );
  if (!match) {
    throw new Error(
      `createUser failed (${created.error?.message}) and no existing auth user matches ${email}`,
    );
  }
  return match.id;
}

async function ensureOwnerProfile(db: Db, userId: string): Promise<void> {
  const existing = await db
    .select({ userId: profiles.userId, isOwner: profiles.isOwner })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);
  if (existing.length > 0) {
    if (!existing[0].isOwner) {
      await db.update(profiles).set({ isOwner: true }).where(eq(profiles.userId, userId));
    }
    return;
  }
  await db.insert(profiles).values({ userId, isOwner: true });
}

export interface SeedApplicationsInput {
  ownerId: string;
  appRows: readonly V1ApplicationRow[];
  /** v1 job_id -> its jobs.csv row (status, applied_at, ...). */
  v1JobIdToRow: Map<string, V1JobRow>;
  /** v1 job_id -> the DB job id it resolved to; mutated in place as orphan placeholders are created. */
  v1JobIdToDbId: Map<string, string>;
  companyCache: Map<string, string>;
}

export interface SeedApplicationsResult {
  applicationsCreated: number;
  orphanedPlaceholderJobs: number;
}

/**
 * Inserts one `applications` row (+ its `outcome_events`) per v1 CSV
 * (user, job) pair — pulled out of `main()` so
 * `tests/db/seed-v1.test.ts` can pin the dedupe rule against a fake `Db`
 * without a live Postgres connection: v1 logged one `applications.csv` row
 * per resume *regeneration*, not per real application (one real Databricks
 * application had 6 byte-identical rows in production), and the DB-backed
 * `existing.length > 0` check below — keyed on (userId, jobId) only, not
 * createdAt — keeps just the first (earliest, since `appRows` is processed
 * in CSV order) and skips the rest, matching the `applications_user_job_uq`
 * constraint (drizzle/0015) exactly one row per (user, job) enforces.
 */
export async function seedApplications(
  db: Db,
  { ownerId, appRows, v1JobIdToRow, v1JobIdToDbId, companyCache }: SeedApplicationsInput,
): Promise<SeedApplicationsResult> {
  let applicationsCreated = 0;
  let orphanedPlaceholderJobs = 0;

  for (const app of appRows) {
    if (!app.id || !app.job_id) {
      console.warn(`[seed-v1] skipping application row missing id/job_id: ${app.id ?? "(no id)"}`);
      continue;
    }

    let jobDbId = v1JobIdToDbId.get(app.job_id);
    if (!jobDbId) {
      // v1's own data has orphaned references: applications.csv points at a
      // job_id no longer present in jobs.csv. Create a minimal placeholder
      // job (not counted in "jobs upserted") so the FK holds and the
      // application's history isn't silently dropped. Check for an existing
      // placeholder first so re-runs don't log/count a "new" one every time
      // (upsertJobByUrl always upserts, so it alone can't tell us that).
      const placeholderUrl = `v1-orphan://${app.job_id}`;
      const existingPlaceholder = await db
        .select({ id: jobs.id })
        .from(jobs)
        .where(eq(jobs.url, placeholderUrl))
        .limit(1);
      if (existingPlaceholder.length > 0) {
        jobDbId = existingPlaceholder[0].id;
      } else {
        const placeholderCompanyId = await upsertCompanyByName(
          db,
          companyCache,
          "Unknown (v1 orphaned job)",
        );
        jobDbId = await upsertJobByUrl(db, placeholderUrl, {
          companyId: placeholderCompanyId,
          title: `Unknown position (v1 job ${app.job_id})`,
          isPlaceholder: true,
        });
        orphanedPlaceholderJobs++;
        console.warn(
          `[seed-v1] application ${app.id} references job_id ${app.job_id}, not present in jobs.csv; created a placeholder job.`,
        );
      }
      v1JobIdToDbId.set(app.job_id, jobDbId);
    }

    const createdAt = toDate(app.created_at) ?? new Date();

    // Keyed on (userId, jobId) only — not createdAt — and matching the
    // `applications_user_job_uq` DB constraint (drizzle/0015): at most one
    // application per (user, job). v1's own applications.csv can have
    // several rows for the same job_id (one per resume regeneration, not
    // per real application — e.g. 6 rows for one real Databricks
    // application), so this keeps only the first (earliest, since appRows
    // are processed in CSV order) and skips the rest, rather than creating
    // a duplicate row per regeneration the way an createdAt-keyed check
    // would.
    const existing = await db
      .select({ id: applications.id })
      .from(applications)
      .where(and(eq(applications.userId, ownerId), eq(applications.jobId, jobDbId)))
      .limit(1);
    if (existing.length > 0) continue; // already seeded an application for this (user, job)

    const v1Job = v1JobIdToRow.get(app.job_id);
    const status: (typeof applications.$inferInsert)["status"] =
      v1Job?.status === "interview"
        ? "interviewing"
        : v1Job?.status === "rejected"
          ? "rejected"
          : v1Job?.status === "reviewing"
            ? "responded"
            : "applied";

    const [createdApp] = await db
      .insert(applications)
      .values({
        userId: ownerId,
        jobId: jobDbId,
        resumePdfPath: app.pdf_path || null,
        status,
        createdAt,
      })
      .returning({ id: applications.id });
    applicationsCreated++;

    await db.insert(outcomeEvents).values({
      applicationId: createdApp.id,
      type: "applied",
      occurredAt: createdAt,
    });

    if (
      v1Job?.status === "interview" ||
      v1Job?.status === "rejected" ||
      v1Job?.status === "reviewing"
    ) {
      const secondaryAt = toDate(v1Job.applied_at) ?? createdAt;
      const secondaryType =
        v1Job.status === "interview"
          ? "interview"
          : v1Job.status === "rejected"
            ? "rejected"
            : "response";
      await db.insert(outcomeEvents).values({
        applicationId: createdApp.id,
        type: secondaryType,
        occurredAt: secondaryAt,
      });
    }
  }

  return { applicationsCreated, orphanedPlaceholderJobs };
}

async function main() {
  if (!fs.existsSync(V1_DATA_DIR)) {
    console.log(
      `[seed-v1] V1_DATA_DIR (${V1_DATA_DIR}) does not exist on this machine; skipping v1 seed. ` +
        `Set V1_DATA_DIR to point at a checkout of Job_Auto_Apply/data to run it.`,
    );
    process.exit(0);
  }

  const db = getDirectDb();

  const ownerEmail = process.env.OWNER_EMAIL;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!ownerEmail) throw new Error("OWNER_EMAIL is not set (check .env.local)");
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set (check .env.local)",
    );
  }

  console.log(`[seed-v1] Reading ${V1_JOBS_CSV} and ${V1_APPLICATIONS_CSV} ...`);
  const jobRows = readCsv<V1JobRow>(V1_JOBS_CSV);
  const appRows = readCsv<V1ApplicationRow>(V1_APPLICATIONS_CSV);
  console.log(
    `[seed-v1] ${jobRows.length} v1 job rows, ${appRows.length} v1 application rows.`,
  );

  // --- Jobs + companies ------------------------------------------------
  const companyCache = new Map<string, string>();
  const v1JobIdToDbId = new Map<string, string>();
  const v1JobIdToRow = new Map<string, V1JobRow>();
  const upsertedUrls = new Set<string>();

  for (const row of jobRows) {
    if (!row.id || !row.url || !row.title || !row.company) {
      console.warn(`[seed-v1] skipping job row missing id/url/title/company: ${row.id ?? "(no id)"}`);
      continue;
    }
    v1JobIdToRow.set(row.id, row);

    const companyId = await upsertCompanyByName(db, companyCache, row.company);
    const dbId = await upsertJobByUrl(db, row.url, {
      companyId,
      title: row.title,
      location: row.location || null,
      remote: toBool(row.remote),
      description: row.description || null,
      postedAt: toDate(row.posted_at),
      scrapedAt: toDate(row.scraped_at),
      lastSeenAt: toDate(row.scraped_at),
    });
    v1JobIdToDbId.set(row.id, dbId);
    upsertedUrls.add(row.url);
  }

  // --- Owner profile -----------------------------------------------------
  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const ownerId = await ensureAuthUser(supabaseAdmin, ownerEmail);
  await ensureOwnerProfile(db, ownerId);

  // --- Applications + outcome events -------------------------------------
  const { applicationsCreated, orphanedPlaceholderJobs } = await seedApplications(db, {
    ownerId,
    appRows,
    v1JobIdToRow,
    v1JobIdToDbId,
    companyCache,
  });

  if (orphanedPlaceholderJobs > 0) {
    console.log(
      `[seed-v1] created ${orphanedPlaceholderJobs} placeholder job(s) for orphaned v1 application->job references.`,
    );
  }

  console.log(`jobs upserted: ${upsertedUrls.size}, applications: ${applicationsCreated}`);
  process.exit(0);
}

// Only run `main()` (which can call `process.exit()`) when this file is
// executed directly (`tsx src/db/seed-v1.ts`) — not when
// `tests/db/seed-v1.test.ts` imports `seedApplications` from it, which
// would otherwise kill the whole test process the moment this module loads.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("[seed-v1] failed:", err);
    process.exit(1);
  });
}
