/**
 * The `tailor_edit` overlay — spec: "tailor edits (edited bullets, excluded
 * bullets) persist ... store them as a 'tailor_edit' overlay on the
 * generation" (`generations.user_edits`, a small additive jsonb column).
 *
 * A `tailor` generation's `output` (`TailorOutput`) is immutable — it is
 * exactly what the model returned, and `checkCitations()` re-verifies it
 * against the user's *current* confirmed facts on every read, so it must
 * never be mutated in place. A user's inline edits (retyped bullet text,
 * unchecked bullets) are instead recorded as a small diff against that
 * original output and stored alongside it. This module is the one place
 * that reads/writes that diff — the path convention (`sections[i].bullets[j]`)
 * is the same one `hallucination.ts` uses, so a bullet's identity is stable
 * across both checks.
 *
 * Pure and DB-free, like `hallucination.ts` — unit-tested in
 * `tests/pipeline/tailor-edits.test.ts`.
 */

import type { TailorOutput } from "./schemas";

/**
 * `generations.user_edits` for a `tailor` generation. Both fields are
 * optional/omittable so "no edits yet" serializes as `{}` (or `null`)
 * rather than a payload with two empty containers.
 */
export interface TailorUserEdits {
  /** `path -> replacement bullet text`. `fact_ids` are never touched by an edit. */
  editedText?: Record<string, string>;
  /**
   * Paths the user explicitly unchecked. Never includes a hallucination-
   * blocked bullet — those are excluded because {@link checkCitations}
   * flags them from the *current* facts, not because the user asked to
   * exclude them, so re-deriving that exclusion belongs to the caller that
   * has the hallucination report, not to this stored overlay.
   */
  excludedPaths?: string[];
}

/** Same pointer convention `hallucination.ts`'s `collectClaims()` uses. */
export function tailorBulletPath(sectionIndex: number, bulletIndex: number): string {
  return `sections[${sectionIndex}].bullets[${bulletIndex}]`;
}

function isEmpty(edits: TailorUserEdits | null | undefined): boolean {
  if (!edits) return true;
  const hasText = !!edits.editedText && Object.keys(edits.editedText).length > 0;
  const hasExclusions = !!edits.excludedPaths && edits.excludedPaths.length > 0;
  return !hasText && !hasExclusions;
}

/**
 * Applies a persisted overlay to the original `tailor` output: substitutes
 * edited bullet text (in place — a bullet's `fact_ids` and position are
 * untouched by an edit) and drops every explicitly-excluded bullet, the same
 * way {@link stripUnsupportedBullets} drops hallucination-blocked ones.
 * Sections left with no bullets are dropped too. Returns `output` unchanged
 * (same reference) when there is nothing to apply, so callers can call this
 * unconditionally without an extra null check.
 *
 * This is what a refreshed page reconstructs and what a PDF built from the
 * stored generation (rather than a live in-browser edit) would render.
 */
export function applyTailorEdits(
  output: TailorOutput,
  edits: TailorUserEdits | null | undefined,
): TailorOutput {
  if (isEmpty(edits)) return output;
  const editedText = edits!.editedText ?? {};
  const excluded = new Set(edits!.excludedPaths ?? []);

  const sections = output.sections
    .map((section, s) => ({
      ...section,
      bullets: section.bullets
        .map((bullet, b) => ({ bullet, path: tailorBulletPath(s, b) }))
        .filter(({ path }) => !excluded.has(path))
        .map(({ bullet, path }) => {
          const text = editedText[path];
          return text === undefined ? bullet : { ...bullet, text };
        }),
    }))
    .filter((section) => section.bullets.length > 0);

  return { ...output, sections };
}
