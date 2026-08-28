/**
 * The loose-section headings the derivation and the renderer must agree about.
 *
 * A legacy `tailor` row carries its content as a flat `sections: [{heading,
 * bullets}]` list. Two independent pieces of code read that list and they have
 * to make the *same* call about every heading:
 *
 *  - `deriveExperienceFromSections()` / `deriveProjectsForTemplate()` in
 *    `./base-entries.ts` **consume** a section — its bullets move into the
 *    structured `experience` / `projects` arrays;
 *  - `extraSections()` in `./ResumeDocument.tsx` **suppresses** a section once
 *    those arrays are populated, so the same bullets are not printed twice.
 *
 * When the two predicates disagree, one of two things happens, and both are
 * shipped bugs. If the derivation is the broader one, a heading like "Relevant
 * Projects" is consumed *and* kept, printing every bullet twice (QA reproduced
 * exactly that: the derivation matched on `/project/i` while `extraSections()`
 * compared for equality against `"projects"`). If the renderer is the broader
 * one, a section is suppressed that nothing consumed, and its bullets vanish
 * from the PDF.
 *
 * So the predicates live here, once, and both sides import them. Deliberately
 * narrow: only a heading that is *entirely* about experience or projects
 * counts, so "Project Management Certifications" stays a section of its own
 * rather than being read as a list of the candidate's projects.
 */

/** `Experience`, `Work Experience`, `Professional Experience`, `Employment Experience`. */
const EXPERIENCE_HEADING = /^(?:work|professional|employment)?\s*experience$/i;

/** `Projects`, `Selected Projects`, `Relevant Projects`, `Personal Projects`… */
const PROJECTS_HEADING = /^(?:[a-z]+\s+)*projects?$/i;

/** True when this loose section is the row's employment history. */
export function isExperienceHeading(heading: string): boolean {
  return EXPERIENCE_HEADING.test(heading.trim());
}

/** True when this loose section is the row's project list. */
export function isProjectsHeading(heading: string): boolean {
  return PROJECTS_HEADING.test(heading.trim());
}

/**
 * The single section a derivation may consume, or `null`.
 *
 * `null` when nothing matches (nothing to derive) *and* when more than one
 * section does: `extraSections()` would suppress **all** of them once the
 * structured array is populated, while the derivation only ever reads one, so
 * the others' bullets would be deleted from the page. Refusing to derive
 * leaves every one of them printed exactly as the row stored it.
 */
export function soleSection<T extends { heading: string }>(
  sections: readonly T[],
  matches: (heading: string) => boolean,
): T | null {
  const found = sections.filter((section) => matches(section.heading));
  return found.length === 1 ? found[0] : null;
}
