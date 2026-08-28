/**
 * Mechanical hallucination check — spec §5, "no LLM".
 *
 * The tailoring and suggestion prompts promise that every claim carries at
 * least one `fact_ids` label drawn from the user's confirmed facts. Prompts
 * are not a guarantee, so this module *verifies* it after the fact, with plain
 * set membership and no second model call:
 *
 *   - a claim citing no fact at all → unsupported (`badIds: []`);
 *   - a claim citing a label the user does not have → unsupported, with the
 *     invented labels listed in `badIds`.
 *
 * `rate = unsupported / totalClaims` is the number the eval gate fails on
 * (spec §7: `hallucination_rate > 0.02`), and `path` is a pointer into the
 * step's own output shape so the PDF renderer can drop exactly the offending
 * bullets (spec §5: "blocked from the PDF and shown to the user for manual
 * fix") and the UI can highlight them.
 *
 * Deliberately pure and dependency-free: it takes an already-parsed step
 * output and a set of labels, touches no database, and is unit-tested in
 * `tests/pipeline/hallucination.test.ts`.
 */

import type { SuggestOutput, TailorOutput } from "./schemas";

/** One claim that cannot be traced back to a confirmed fact. */
export interface UnsupportedClaim {
  /**
   * Pointer into the step output, e.g. `sections[0].bullets[1]`,
   * `lead_with[1]`, `weekend_build`. Stable enough to render against.
   */
  path: string;
  /** The claim's own text, so a report is readable without the output. */
  text: string;
  /**
   * Cited labels that are not confirmed facts. Empty when the claim cited
   * nothing at all — which is just as unsupported, and worth distinguishing
   * because the fix differs (add a citation vs. remove an invention).
   */
  badIds: string[];
}

export interface HallucinationReport {
  /** Every citable claim in the output, supported or not. */
  totalClaims: number;
  unsupported: UnsupportedClaim[];
  /** `unsupported / totalClaims`, or 0 when there are no claims. */
  rate: number;
}

/** One citable unit of a step's output. */
interface Claim {
  path: string;
  text: string;
  factIds: string[];
}

/**
 * Labels are compared case-insensitively and whitespace-trimmed. A model that
 * writes `f-014` or ` F-014 ` meant the fact it was shown; treating that as a
 * hallucination would inflate the rate the eval gate keys on and block a
 * perfectly grounded bullet from the user's PDF.
 */
function normalizeLabel(label: string): string {
  return label.trim().toUpperCase();
}

function isTailor(
  output: TailorOutput | SuggestOutput,
): output is TailorOutput {
  return "sections" in output;
}

/**
 * Flatten a step output into the claims that must be cited. For `tailor` that
 * is every bullet — in `sections`, in `experience` *and* in `projects`; for
 * `suggest` it is every `lead_with` entry plus the `weekend_build` (the `gaps`
 * describe the *job*, not the candidate, so they carry no citations and are
 * not claims).
 *
 * `experience[i].bullets[j]` and `projects[i].bullets[j]` are checked for the
 * same reason `sections` is: both renderers write the Experience and Projects
 * blocks from those arrays, so a bullet that escaped this check would reach a
 * PDF uncited. (The entry *headers* — organization, role, dates — carry no
 * `fact_ids` and so cannot be checked here; the prompt is what constrains
 * them, and they are copied from facts the extract step already confirmed.)
 */
function collectClaims(output: TailorOutput | SuggestOutput): Claim[] {
  if (isTailor(output)) {
    return [
      ...output.sections.flatMap((section, s) =>
        section.bullets.map((bullet, b) => ({
          path: `sections[${s}].bullets[${b}]`,
          text: bullet.text,
          factIds: bullet.fact_ids ?? [],
        })),
      ),
      ...(output.experience ?? []).flatMap((entry, e) =>
        entry.bullets.map((bullet, b) => ({
          path: `experience[${e}].bullets[${b}]`,
          text: bullet.text,
          factIds: bullet.fact_ids ?? [],
        })),
      ),
      ...(output.projects ?? []).flatMap((project, p) =>
        project.bullets.map((bullet, b) => ({
          path: `projects[${p}].bullets[${b}]`,
          text: bullet.text,
          factIds: bullet.fact_ids ?? [],
        })),
      ),
    ];
  }

  const claims: Claim[] = output.lead_with.map((entry, i) => ({
    path: `lead_with[${i}]`,
    text: entry.why,
    factIds: entry.fact_ids ?? [],
  }));

  if (output.weekend_build) {
    claims.push({
      path: "weekend_build",
      text: output.weekend_build.idea,
      factIds: output.weekend_build.fact_ids ?? [],
    });
  }

  return claims;
}

/**
 * Check a `tailor` or `suggest` output against the user's confirmed fact
 * labels.
 *
 * @param validLabels labels of the user's confirmed facts (e.g. from
 *   `getConfirmedFacts()` or a frozen `eval_items.profile_snapshot`).
 */
export function checkCitations(
  output: TailorOutput | SuggestOutput,
  validLabels: Set<string>,
): HallucinationReport {
  const valid = new Set([...validLabels].map(normalizeLabel));
  const claims = collectClaims(output);
  const unsupported: UnsupportedClaim[] = [];

  for (const claim of claims) {
    const badIds = claim.factIds.filter(
      (id) => !valid.has(normalizeLabel(id)),
    );
    // Unsupported when nothing was cited, or when *any* cited label is
    // invented: one fabricated citation next to a real one is still a
    // fabrication, and the bullet cannot be trusted into the PDF.
    if (claim.factIds.length === 0 || badIds.length > 0) {
      unsupported.push({ path: claim.path, text: claim.text, badIds });
    }
  }

  return {
    totalClaims: claims.length,
    unsupported,
    rate: claims.length === 0 ? 0 : unsupported.length / claims.length,
  };
}

/**
 * The output paths a renderer must drop (spec §5). Kept next to the checker so
 * the PDF template and the UI agree on what "blocked" means.
 */
export function blockedPaths(report: HallucinationReport): string[] {
  return report.unsupported.map((claim) => claim.path);
}

/**
 * A `tailor` output with every unsupported bullet removed — what actually goes
 * into the PDF. Sections left with no bullets are dropped too, and so are
 * `experience`/`projects` entries left with none: an employer or project
 * heading with no bullet under it is just an unevidenced claim that the
 * candidate worked there or built the thing.
 */
export function stripUnsupportedBullets(
  output: TailorOutput,
  report: HallucinationReport,
): TailorOutput {
  const blocked = new Set(blockedPaths(report));
  const stripped: TailorOutput = {
    ...output,
    sections: output.sections
      .map((section, s) => ({
        ...section,
        bullets: section.bullets.filter(
          (_, b) => !blocked.has(`sections[${s}].bullets[${b}]`),
        ),
      }))
      .filter((section) => section.bullets.length > 0),
  };

  // `undefined` is preserved rather than normalised to `[]`: a legacy
  // generation that never had these fields must round-trip through here
  // unchanged, so a renderer can still tell "no entries" from "this run
  // predates entries" and fall back to the loose `sections` bullets.
  if (output.experience) {
    stripped.experience = output.experience
      .map((entry, e) => ({
        ...entry,
        bullets: entry.bullets.filter(
          (_, b) => !blocked.has(`experience[${e}].bullets[${b}]`),
        ),
      }))
      .filter((entry) => entry.bullets.length > 0);
  }

  if (output.projects) {
    stripped.projects = output.projects
      .map((project, p) => ({
        ...project,
        bullets: project.bullets.filter(
          (_, b) => !blocked.has(`projects[${p}].bullets[${b}]`),
        ),
      }))
      .filter((project) => project.bullets.length > 0);
  }

  return stripped;
}
