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
 * Removes every resume object a user has ever uploaded — the storage half of
 * `deleteUserData` (`src/profile/facts.ts`). Treats "bucket doesn't exist"
 * and "user has no folder" both as "nothing to delete", not errors: a user
 * who deletes their data without ever uploading a resume should not see
 * this fail.
 */
export async function deleteAllResumeObjects(userId: string): Promise<void> {
  const client = getStorageAdminClient();

  const { data, error } = await client.storage.from(RESUME_BUCKET).list(userId);
  if (error || !data || data.length === 0) return;

  const paths = data.map((f) => `${userId}/${f.name}`);
  const { error: removeError } = await client.storage.from(RESUME_BUCKET).remove(paths);
  if (removeError) throw removeError;
}
