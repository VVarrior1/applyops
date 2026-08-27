import { NextResponse } from "next/server";
import { requireUser } from "@/src/auth/require";
import { getDb } from "@/src/db/client";
import { LlmError } from "@/src/llm/model-id";
import { runExtractFacts } from "@/src/pipeline/steps";
import { extractPdfText, ResumeTextExtractionError } from "@/src/profile/resume-text";
import { MAX_RESUME_BYTES, uploadResumePdf } from "@/src/profile/storage";

// pdf-parse (pdfjs-dist) and the Storage admin client both need Node APIs
// (Buffer, etc.) — the App Router default runtime already is Node, but this
// is pinned explicitly since this route is the one place in Task 6 that
// genuinely depends on it.
export const runtime = "nodejs";

/**
 * `POST /api/profile/upload` — plan Task 6 Step 2.
 *
 * Accepts a PDF resume (multipart form field `resume`, ≤5 MB), archives it
 * to the private `resumes` Storage bucket, extracts its text, and runs
 * `extract_facts`. Returns the model's *proposed* facts — nothing is saved
 * to `profile_facts` here; the user reviews/edits them client-side and only
 * confirming (`POST /api/profile/facts`) persists anything.
 */
export async function POST(request: Request) {
  const user = await requireUser();

  const form = await request.formData().catch(() => null);
  const file = form?.get("resume");
  if (!file || !(file instanceof Blob)) {
    return NextResponse.json({ error: "Attach a PDF file as 'resume'." }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "That file is empty." }, { status: 400 });
  }
  if (file.size > MAX_RESUME_BYTES) {
    return NextResponse.json(
      { error: `Resume must be ${MAX_RESUME_BYTES / (1024 * 1024)} MB or smaller.` },
      { status: 400 },
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const looksLikePdf = bytes.subarray(0, 5).toString("latin1") === "%PDF-";
  if (!looksLikePdf && file.type && file.type !== "application/pdf") {
    return NextResponse.json({ error: "Only PDF resumes are supported." }, { status: 400 });
  }
  if (!looksLikePdf) {
    return NextResponse.json({ error: "That file doesn't look like a PDF." }, { status: 400 });
  }

  let resumeText: string;
  try {
    resumeText = await extractPdfText(bytes);
  } catch (err) {
    if (err instanceof ResumeTextExtractionError) {
      return NextResponse.json(
        { error: `Couldn't read that PDF: ${err.message}` },
        { status: 422 },
      );
    }
    throw err;
  }

  if (resumeText.length < 20) {
    return NextResponse.json(
      {
        error:
          "Couldn't find any text in that PDF (it may be a scanned image). Try a text-based export instead.",
      },
      { status: 422 },
    );
  }

  let storagePath: string;
  try {
    storagePath = await uploadResumePdf(user.id, bytes);
  } catch (err) {
    console.error("[profile/upload] Storage write failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Could not save the uploaded file. Try again." }, { status: 502 });
  }

  const db = getDb();
  try {
    const { output } = await runExtractFacts(db, { resumeText, userId: user.id });
    return NextResponse.json({ path: storagePath, facts: output.facts });
  } catch (err) {
    if (err instanceof LlmError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status ?? 500 });
    }
    throw err;
  }
}
