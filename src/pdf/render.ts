/**
 * `renderResumePdf()` — the one entry point the rest of the app uses to turn
 * a tailored resume into bytes (plan Task 9 — Interfaces Produces).
 *
 * Plain `.ts` (not `.tsx`) on purpose: this file is the boundary between
 * "data in" and "PDF bytes out" and has no JSX of its own — the template
 * lives in `./ResumeDocument.tsx`, built here with `React.createElement` so
 * this module needs no JSX transform.
 */

import { renderToBuffer } from "@react-pdf/renderer";
import { ResumeDocument, type RenderResumeInput } from "./ResumeDocument";

export type { RenderResumeInput, ResumeProfile } from "./ResumeDocument";

/**
 * Renders the tailored resume to a PDF `Buffer` (starts with `%PDF`).
 *
 * `ResumeDocument(input)` is called directly as a plain function rather than
 * instantiated via `createElement`/JSX — it has no hooks, so that's safe —
 * because doing so returns the `<Document>` element it produces typed as the
 * loose `JSX.Element` react-pdf's own `renderToBuffer()` expects
 * (`ReactElement<DocumentProps>`); going through `createElement(ResumeDocument,
 * input)` instead types the result as `ReactElement<RenderResumeInput>`,
 * which `renderToBuffer` correctly rejects (`RenderResumeInput` is not
 * `DocumentProps` — the wrapper's own props, not the `<Document>` it renders).
 */
export async function renderResumePdf(input: RenderResumeInput): Promise<Buffer> {
  return renderToBuffer(ResumeDocument(input));
}
