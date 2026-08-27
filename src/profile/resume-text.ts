/**
 * Resume text extraction — the first move of onboarding (spec §9:
 * "/onboarding: upload PDF → facts review → prefs").
 *
 * Pure I/O, nothing persisted here and nothing inspected for content: takes
 * a PDF's raw bytes, hands back its plain text for `runExtractFacts`
 * (src/pipeline/steps/extract-facts.ts) to read. That prompt is the one told
 * to skip contact details, so no PII from a resume ever becomes a stored
 * `profile_facts` row — this module doesn't need to know or care what the
 * text contains.
 */

import { PDFParse } from "pdf-parse";

/** Thrown when the bytes handed in aren't a PDF `PDFParse` can open at all. */
export class ResumeTextExtractionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ResumeTextExtractionError";
  }
}

/**
 * Extracts plain text from a PDF's raw bytes.
 *
 * Returns `""` — never throws — for a PDF that parses fine but has no text
 * layer (a scanned/image-only resume): "we couldn't read any text from that
 * file" is a caller-facing UX decision (the upload route turns it into a
 * 422), not something this extraction layer should decide by throwing.
 *
 * Throws {@link ResumeTextExtractionError} only when the bytes aren't a
 * parseable PDF at all (corrupt file, wrong file type slipped past the
 * caller's content-type check, password-protected with no password, etc.).
 */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  let parser: PDFParse;
  try {
    parser = new PDFParse({ data: buffer });
  } catch (err) {
    throw new ResumeTextExtractionError(
      err instanceof Error ? err.message : "Could not open that file as a PDF",
      { cause: err },
    );
  }

  try {
    const result = await parser.getText();
    return result.text.trim();
  } catch (err) {
    throw new ResumeTextExtractionError(
      err instanceof Error ? err.message : "Could not parse that PDF",
      { cause: err },
    );
  } finally {
    await parser.destroy();
  }
}
