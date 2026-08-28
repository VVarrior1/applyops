/**
 * Reading and writing a user's base resume (`resume_bases`) — the small
 * database/Storage layer around `src/pdf/latex.ts`, which is deliberately
 * pure and knows nothing about either.
 *
 * Two callers: `applyops resume import-latex` writes a row here, and the PDF
 * route + `applyops pdf` read one. Everything else in the app is unaffected —
 * a user with no base resume simply keeps getting react-pdf output.
 */

import { and, desc, eq, isNotNull, ne } from "drizzle-orm";
import type { Db } from "../db/client";
import { resumeBases } from "../db/schema";
import {
  RESUME_BUCKET,
  ensureResumeBucket,
  getStorageAdminClient,
} from "../profile/storage";

export interface LatexBaseRow {
  id: string;
  latex: string;
  transcriptPdfPath: string | null;
  createdAt: Date;
}

/**
 * The user's live base resume: the newest `kind = 'latex'` row that actually
 * has LaTeX in it. Rows are append-only (see `src/db/schema.ts`), so "newest"
 * is the whole selection rule — importing a new resume supersedes the old one
 * without destroying the record of what earlier PDFs were built from.
 *
 * Returns `null` — never throws — when the user has no LaTeX base, because
 * every caller's answer to that is "use the react-pdf renderer instead".
 */
export async function getLatexBase(db: Db, userId: string): Promise<LatexBaseRow | null> {
  // Every condition is in SQL, and the limit is 1. Filtering `kind` in
  // JavaScript over the newest N rows would silently return `null` — falling
  // back to react-pdf, the exact regression this module exists to prevent —
  // for a user who happens to have N newer rows of another kind.
  const [row] = await db
    .select({
      id: resumeBases.id,
      latex: resumeBases.latex,
      transcriptPdfPath: resumeBases.transcriptPdfPath,
      createdAt: resumeBases.createdAt,
    })
    .from(resumeBases)
    .where(
      and(
        eq(resumeBases.userId, userId),
        eq(resumeBases.kind, "latex"),
        isNotNull(resumeBases.latex),
        ne(resumeBases.latex, ""),
      ),
    )
    .orderBy(desc(resumeBases.createdAt))
    .limit(1);

  if (!row?.latex?.trim()) return null;
  return {
    id: row.id,
    latex: row.latex,
    transcriptPdfPath: row.transcriptPdfPath,
    createdAt: row.createdAt,
  };
}

/** Inserts a new base resume row and returns its id. */
export async function insertLatexBase(
  db: Db,
  args: { userId: string; latex: string; transcriptPdfPath?: string | null },
): Promise<string> {
  const [row] = await db
    .insert(resumeBases)
    .values({
      userId: args.userId,
      kind: "latex",
      latex: args.latex,
      transcriptPdfPath: args.transcriptPdfPath ?? null,
    })
    .returning({ id: resumeBases.id });
  return row.id;
}

/**
 * `${userId}/transcript-${ts}.pdf` — the same private `resumes` bucket the
 * uploaded-resume flow uses, and the same `${userId}/` prefix, so
 * `deleteAllResumeObjects()` (`src/profile/storage.ts`) already sweeps
 * transcripts up on "Delete my data" without knowing they exist.
 */
export function transcriptStoragePath(userId: string, at: Date = new Date()): string {
  return `${userId}/transcript-${at.getTime()}.pdf`;
}

/** Uploads a transcript PDF to the private `resumes` bucket. Returns its path. */
export async function uploadTranscript(userId: string, bytes: Buffer): Promise<string> {
  const client = getStorageAdminClient();
  await ensureResumeBucket(client);
  const storagePath = transcriptStoragePath(userId);
  const { error } = await client.storage.from(RESUME_BUCKET).upload(storagePath, bytes, {
    contentType: "application/pdf",
    upsert: false,
  });
  if (error) throw error;
  return storagePath;
}

/**
 * Downloads a transcript by storage path. Returns `null` on any failure — a
 * missing transcript must never cost the user their resume, so callers merge
 * it when it is there and ship the resume alone when it is not.
 */
export async function downloadTranscript(storagePath: string): Promise<Buffer | null> {
  try {
    const client = getStorageAdminClient();
    const { data, error } = await client.storage.from(RESUME_BUCKET).download(storagePath);
    if (error || !data) return null;
    return Buffer.from(await data.arrayBuffer());
  } catch {
    return null;
  }
}
