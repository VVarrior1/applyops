/**
 * Profile data access — confirmed facts, search prefs, and full account
 * deletion. Everything downstream (`fit`, `tailor`, `suggest`, the eval
 * harness) treats `getConfirmedFacts()`'s output as the *only* evidence a
 * model may cite (see `src/pipeline/steps/shared.ts:renderFacts`), so this
 * module — not the onboarding/settings UI — is the one place that decides
 * what "confirmed" means and how `F-###` labels are assigned.
 *
 * Nothing here talks to an LLM or reads a PDF; callers (the API routes)
 * bring already-extracted/edited fact text and this module just persists it.
 */

import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  applications,
  approvals,
  generations,
  jobScores,
  jobs,
  outcomeEvents,
  profileFacts,
  profiles,
  searchPrefs,
  usageDaily,
} from "../db/schema";
import type { Fact } from "../pipeline/schemas";
import { deleteAllResumeObjects } from "./storage";

// ---------------------------------------------------------------------------
// Labeling
// ---------------------------------------------------------------------------

/** Zero-padded `F-###` label — the exact shape every pipeline prompt cites. */
export function formatFactLabel(n: number): string {
  return `F-${String(n).padStart(3, "0")}`;
}

/**
 * The highest numeric suffix among `F-###`-style labels, or 0 if none parse.
 * Labels that don't match the pattern (there shouldn't be any, but this is
 * user-adjacent data) are ignored rather than thrown on.
 */
export function maxFactLabelNumber(labels: readonly string[]): number {
  let max = 0;
  for (const label of labels) {
    const match = /^F-(\d+)$/.exec(label.trim());
    if (!match) continue;
    const n = Number(match[1]);
    if (n > max) max = n;
  }
  return max;
}

export interface LabelableFact {
  text: string;
  [key: string]: unknown;
}

/**
 * Assigns fresh, sequential `F-###` labels to a batch of not-yet-labeled
 * facts, continuing on from `existingMax`. Pure — the caller looks up
 * `existingMax` itself (see `upsertFacts` below), which is what makes this
 * testable with no database.
 */
export function labelFacts<T extends LabelableFact>(
  existingMax: number,
  facts: readonly T[],
): (T & { label: string })[] {
  return facts.map((fact, i) => ({
    ...fact,
    label: formatFactLabel(existingMax + i + 1),
  }));
}

// ---------------------------------------------------------------------------
// profile_facts
// ---------------------------------------------------------------------------

export interface UpsertFactInput {
  /** Present to update an existing fact in place; absent to create a new one. */
  label?: string;
  category: string;
  text: string;
  /** 'resume_upload' | 'manual' — defaults to 'manual'. */
  source?: string;
}

export interface ProfileFactRecord {
  label: string;
  category: string;
  text: string;
  source: string;
  confirmed: boolean;
}

/**
 * Saves a batch of facts for one user. Entries that already carry a `label`
 * are upserted onto that exact row (edits from the settings facts editor);
 * entries without one are new (a fresh upload's confirmed proposals, or a
 * manually added fact) and get the next `F-###` labels, continuing on from
 * whatever this user's highest-numbered label already is. Every saved row
 * comes back `confirmed: true` — nothing reaches this function that hasn't
 * already been reviewed by the user (see plan Task 6 Step 3: "POST
 * /api/profile/facts saves with confirmed=true").
 *
 * New labels are computed once up front from a single `SELECT`, so a batch
 * of N new facts costs one read, not N.
 */
export async function upsertFacts(
  db: Db,
  userId: string,
  facts: readonly UpsertFactInput[],
): Promise<ProfileFactRecord[]> {
  if (facts.length === 0) return [];

  const existing = await db
    .select({ label: profileFacts.label })
    .from(profileFacts)
    .where(eq(profileFacts.userId, userId));
  const existingMax = maxFactLabelNumber(existing.map((r) => r.label));

  let nextOffset = 0;
  const toSave = facts.map((fact) => {
    if (fact.label) return fact as UpsertFactInput & { label: string };
    nextOffset += 1;
    return { ...fact, label: formatFactLabel(existingMax + nextOffset) };
  });

  const saved: ProfileFactRecord[] = [];
  for (const fact of toSave) {
    const values = {
      userId,
      label: fact.label,
      category: fact.category,
      text: fact.text,
      source: fact.source ?? "manual",
      confirmed: true,
      updatedAt: new Date(),
    };
    const [row] = await db
      .insert(profileFacts)
      .values(values)
      .onConflictDoUpdate({
        target: [profileFacts.userId, profileFacts.label],
        set: {
          category: values.category,
          text: values.text,
          source: values.source,
          confirmed: values.confirmed,
          updatedAt: values.updatedAt,
        },
      })
      .returning({
        label: profileFacts.label,
        category: profileFacts.category,
        text: profileFacts.text,
        source: profileFacts.source,
        confirmed: profileFacts.confirmed,
      });
    saved.push(row);
  }

  return saved;
}

/** Deletes one fact by label. Returns whether a row was actually removed. */
export async function deleteFact(db: Db, userId: string, label: string): Promise<boolean> {
  const deleted = await db
    .delete(profileFacts)
    .where(and(eq(profileFacts.userId, userId), eq(profileFacts.label, label)))
    .returning({ label: profileFacts.label });
  return deleted.length > 0;
}

/**
 * Every confirmed fact for a user, in `Fact[]` shape — exactly what every
 * pipeline step (`renderFacts`, `checkCitations`) expects. Ordered by label
 * so the numbering a user sees in the UI matches what a generated bullet's
 * `fact_ids` refers to.
 */
export async function getConfirmedFacts(db: Db, userId: string): Promise<Fact[]> {
  return db
    .select({
      label: profileFacts.label,
      category: profileFacts.category,
      text: profileFacts.text,
    })
    .from(profileFacts)
    .where(and(eq(profileFacts.userId, userId), eq(profileFacts.confirmed, true)))
    .orderBy(profileFacts.label);
}

/**
 * Every confirmed fact for a user, with `source` included — what the
 * Settings facts editor renders (it shows "from resume" vs. "manual", which
 * plain `Fact` doesn't carry). Same rows as {@link getConfirmedFacts}, wider
 * shape.
 */
export async function listFactRecords(db: Db, userId: string): Promise<ProfileFactRecord[]> {
  return db
    .select({
      label: profileFacts.label,
      category: profileFacts.category,
      text: profileFacts.text,
      source: profileFacts.source,
      confirmed: profileFacts.confirmed,
    })
    .from(profileFacts)
    .where(and(eq(profileFacts.userId, userId), eq(profileFacts.confirmed, true)))
    .orderBy(profileFacts.label);
}

// ---------------------------------------------------------------------------
// search_prefs
// ---------------------------------------------------------------------------

export type SearchPrefsRow = typeof searchPrefs.$inferSelect;

export interface SavePrefsInput {
  roles?: string[];
  locations?: string[];
  /** 'any' | 'remote' | 'hybrid' | 'onsite' */
  remote?: string;
  seniority?: string[];
  /** 'canada' | 'us_citizen_pr' | 'needs_sponsorship' | 'tn_eligible' | null */
  workAuth?: string | null;
  keywords?: string[];
  excludedCompanies?: string[];
}

/** The user's search prefs row, or `null` if they haven't saved any yet. */
export async function getPrefs(db: Db, userId: string): Promise<SearchPrefsRow | null> {
  const [row] = await db
    .select()
    .from(searchPrefs)
    .where(eq(searchPrefs.userId, userId))
    .limit(1);
  return row ?? null;
}

/** Upserts the single `search_prefs` row for a user (it's a `user_id` PK, so there's ever only one). */
export async function upsertPrefs(
  db: Db,
  userId: string,
  prefs: SavePrefsInput,
): Promise<SearchPrefsRow> {
  const values = {
    userId,
    roles: prefs.roles ?? [],
    locations: prefs.locations ?? [],
    remote: prefs.remote ?? "any",
    seniority: prefs.seniority ?? [],
    workAuth: prefs.workAuth ?? null,
    keywords: prefs.keywords ?? [],
    excludedCompanies: prefs.excludedCompanies ?? [],
  };
  const [row] = await db
    .insert(searchPrefs)
    .values(values)
    .onConflictDoUpdate({ target: searchPrefs.userId, set: values })
    .returning();
  return row;
}

// ---------------------------------------------------------------------------
// Delete my data
// ---------------------------------------------------------------------------

export interface DeleteUserDataOptions {
  /**
   * Test seam — defaults to the real Supabase Storage cleanup
   * (`deleteAllResumeObjects`). Mirrors the `_internal` convention already
   * used by `callStructured`/`runStep` so this stays testable with no
   * network call and no live credentials.
   */
  _internal?: { deleteResumeObjects?: (userId: string) => Promise<void> };
}

/**
 * Permanently deletes everything this app knows about one user: every row
 * in every table that carries their `user_id`, plus their resume objects in
 * Storage. Used by the Settings "Delete my data" flow (plan Task 6 Step 4:
 * "confirm dialog → deleteUserData → sign out" — the sign-out itself is the
 * caller's job, client-side, after this resolves).
 *
 * Deletes in dependency order (children before parents) so nothing here
 * trips a foreign-key violation:
 *   1. `approvals` / `outcome_events` for this user's applications
 *   2. `applications`
 *   3. `job_scores`, `usage_daily`
 *   4. `jobs.analysis_generation_id` is nulled for any of this user's
 *      `generations` rows before those rows are deleted — `analyze` results
 *      are cached and *shared* across users (a job's `jobs.analysis` jsonb
 *      column keeps the actual cached output independently), so one user's
 *      account deletion must not fail merely because they were the one who
 *      happened to trigger that job's cached analysis. This does NOT touch
 *      `eval_results.generation_id`: the eval harness (a later task) always
 *      runs against the owner's frozen `profile_snapshot` with a null
 *      `generations.user_id`, so a regular user's own generations should
 *      never be referenced there in practice — worth re-checking once
 *      Task 11 exists.
 *   5. `generations`
 *   6. `profile_facts`, `search_prefs`
 *   7. `profiles` itself (the identity row — every FK above points at it)
 *
 * Does NOT delete the underlying Supabase Auth user: signing back in after
 * this simply re-creates a fresh `profiles` row (via `ensureProfile`) with
 * defaults, same as any new sign-in. "Delete my data" ≠ "delete my account".
 */
export async function deleteUserData(
  db: Db,
  userId: string,
  options: DeleteUserDataOptions = {},
): Promise<void> {
  const apps = await db
    .select({ id: applications.id })
    .from(applications)
    .where(eq(applications.userId, userId));
  const applicationIds = apps.map((a) => a.id);

  if (applicationIds.length > 0) {
    await db.delete(approvals).where(inArray(approvals.applicationId, applicationIds));
    await db.delete(outcomeEvents).where(inArray(outcomeEvents.applicationId, applicationIds));
    await db.delete(applications).where(eq(applications.userId, userId));
  }

  await db.delete(jobScores).where(eq(jobScores.userId, userId));
  await db.delete(usageDaily).where(eq(usageDaily.userId, userId));

  const gens = await db
    .select({ id: generations.id })
    .from(generations)
    .where(eq(generations.userId, userId));
  const generationIds = gens.map((g) => g.id);

  if (generationIds.length > 0) {
    await db
      .update(jobs)
      .set({ analysisGenerationId: null })
      .where(inArray(jobs.analysisGenerationId, generationIds));
  }
  await db.delete(generations).where(eq(generations.userId, userId));

  await db.delete(profileFacts).where(eq(profileFacts.userId, userId));
  await db.delete(searchPrefs).where(eq(searchPrefs.userId, userId));
  await db.delete(profiles).where(eq(profiles.userId, userId));

  const deleteResumeObjects = options._internal?.deleteResumeObjects ?? deleteAllResumeObjects;
  await deleteResumeObjects(userId).catch((err) => {
    console.error(
      `[deleteUserData] resume storage cleanup failed for user ${userId}:`,
      err instanceof Error ? err.message : err,
    );
  });
}
