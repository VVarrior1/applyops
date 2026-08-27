/**
 * Supabase Storage access for uploaded resume PDFs.
 *
 * The `resumes` bucket is private (never a public URL), so every read/write
 * goes through the service-role client built here — the same pattern
 * `src/db/seed-v1.ts` already uses for the Auth admin API, and the one
 * Task 3's notes call out as the right move for anything needing elevated
 * Storage access (`src/auth/server.ts`/`browser.ts` are anon-key,
 * user-session clients only, not this).
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const RESUME_BUCKET = "resumes";
export const MAX_RESUME_BYTES = 5 * 1024 * 1024; // 5 MB, per plan Task 6 Step 2.

let cachedClient: SupabaseClient | undefined;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** A fresh-enough (cached) service-role client — bypasses RLS entirely. */
export function getStorageAdminClient(): SupabaseClient {
  if (!cachedClient) {
    cachedClient = createClient(
      requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
  }
  return cachedClient;
}

/**
 * Creates the `resumes` bucket if it doesn't exist yet (plan Task 6 Step 2:
 * "create bucket via service client if missing"). Safe to call on every
 * upload — cheap when the bucket already exists, and tolerant of a
 * concurrent creator winning the race.
 */
export async function ensureResumeBucket(
  client: SupabaseClient = getStorageAdminClient(),
): Promise<void> {
  const { data: buckets, error } = await client.storage.listBuckets();
  if (error) throw error;
  if (buckets?.some((b) => b.name === RESUME_BUCKET)) return;

  const { error: createError } = await client.storage.createBucket(RESUME_BUCKET, {
    public: false,
    fileSizeLimit: MAX_RESUME_BYTES,
  });
  // A concurrent request may have created it a moment ago — that's success,
  // not a failure, for an "ensure" function.
  if (createError && !/already exists/i.test(createError.message)) {
    throw createError;
  }
}

/** `${userId}/${ts}.pdf`, per plan Task 6 Step 2. */
export function resumeStoragePath(userId: string, uploadedAt: Date = new Date()): string {
  return `${userId}/${uploadedAt.getTime()}.pdf`;
}

/** Uploads one resume PDF, creating the bucket first if needed. Returns its storage path. */
export async function uploadResumePdf(userId: string, bytes: Buffer): Promise<string> {
  const client = getStorageAdminClient();
  await ensureResumeBucket(client);

  const path = resumeStoragePath(userId);
  const { error } = await client.storage.from(RESUME_BUCKET).upload(path, bytes, {
    contentType: "application/pdf",
    upsert: false,
  });
  if (error) throw error;
  return path;
}

/**
 * Page size for {@link deleteAllResumeObjects}'s `list()` calls. Exported so
 * a test can build exactly this many fake objects to exercise the
 * "keep paginating" branch without hand-picking a number that happens to
 * match a hardcoded literal.
 */
export const RESUME_LIST_PAGE_SIZE = 1000;

/**
 * Removes every resume object a user has ever uploaded — the storage half of
 * `deleteUserData` (`src/profile/facts.ts`).
 *
 * Paginates with `{limit, offset}` rather than relying on `list()`'s default
 * `limit: 100` (a user past 100 uploads would otherwise keep every object
 * beyond the first page forever, since nothing else prunes old uploads).
 *
 * A genuine failure (bad service key, network, permissions) is rethrown
 * rather than swallowed: verified live against this project's own `resumes`
 * bucket that Supabase Storage's `list()` returns `{data: [], error: null}`
 * — not an error — for both a prefix with no objects AND a bucket that
 * doesn't exist at all, so any non-null `error` here is a real failure, not
 * a "nothing to delete" case, and letting it through silently (the previous
 * behavior) could leave a user's resume PDFs in Storage after "Delete my
 * data" reports success.
 */
export async function deleteAllResumeObjects(
  userId: string,
  client: SupabaseClient = getStorageAdminClient(),
): Promise<void> {
  let offset = 0;

  for (;;) {
    const { data, error } = await client.storage
      .from(RESUME_BUCKET)
      .list(userId, { limit: RESUME_LIST_PAGE_SIZE, offset });
    if (error) throw error;
    if (!data || data.length === 0) return;

    const paths = data.map((f) => `${userId}/${f.name}`);
    const { error: removeError } = await client.storage.from(RESUME_BUCKET).remove(paths);
    if (removeError) throw removeError;

    if (data.length < RESUME_LIST_PAGE_SIZE) return;
    offset += RESUME_LIST_PAGE_SIZE;
  }
}
