/**
 * Filling the react-pdf template's entry headers from the user's own base
 * `.tex` resume — the half of v1 parity the LaTeX renderer gets for free.
 *
 * ## Why this module exists
 *
 * The two renderers get their employment history from different places.
 *
 * `src/pdf/latex.ts` splices *two* blocks into the user's real `resume.tex`
 * (Technical Skills and Projects) and leaves everything else as written, so
 * its EXPERIENCE section is the user's own `\resumeSubheading{Mercor}{November
 * 2025 -- Present}{Software Engineering Expert}{Remote}` lines — employer,
 * dates, title and location, exactly as they hand-tuned them.
 *
 * The react-pdf template has no base document. It draws the page from
 * `TailorOutput` alone, so an entry header is only as complete as the model's
 * `organization`/`role`/`location`/`start`/`end`, and those are copied from
 * the user's *confirmed facts*. QA found the gap: the owner's facts read
 * `Mercor AI Training Engineer Remote, selected to train frontier LLMs…` —
 * employer, title and location, but **no dates**. The model did the honest
 * thing and returned `start: ""`, `end: ""` (an invented date on a job
 * application is the exact failure the citation rule exists to prevent), and
 * the fallback PDF came out with an employment history no ATS could date.
 *
 * The dates are not missing from the system, only from the facts: they are
 * sitting in `resume_bases.latex`, written by the user. This module reads
 * them out of there. That is not a new claim about the candidate — it is the
 * candidate's own resume — which is why it can run with no model call.
 *
 * ## What it fixes, in order of how bad it was
 *
 *  1. **A current row has the headers but not the dates**, per the QA finding
 *     above. {@link enrichExperience} fills *only* the fields the model left
 *     empty, and only from a base entry it can actually identify. This is the
 *     case that matters: it is what every "Generate tailored resume" click
 *     produces.
 *  2. **A pre-1.2.0 `tailor` row has no `experience`/`projects` at all**, only
 *     a loose `sections: [{heading: "Experience", bullets}]` list, and
 *     react-pdf rendered it as anonymous bullets under an EXPERIENCE rule —
 *     no company, no title, no dates, half the page blank. Those rows are
 *     still in the database and are re-rendered every time their PDF is
 *     downloaded. {@link deriveExperienceFromSections} puts those bullets back
 *     under the base resume's real employers — but only the ones that name
 *     their employer, and only if *all* of them do. See its comment: guessing
 *     here misattributes work to employers the candidate never did it for.
 *
 * ## The rules it will not break
 *
 * - **Only empty fields are filled.** What the model cited from the facts
 *   always wins; this never overwrites it. A base resume that has gone stale
 *   can therefore add detail but never contradict.
 * - **A base entry is used at most once.** Two tailor entries cannot both
 *   claim "Mercor" and end up sharing one date range — the same rule
 *   `headingFor()` enforces on the LaTeX side, and for the same reason: a
 *   duplicated entry is visibly wrong to a recruiter and nothing downstream
 *   catches it.
 * - **No bullets are invented, moved between employers, or un-stripped.**
 *   The caller runs `stripUnsupportedBullets()` *before* this; enrichment only
 *   ever touches header strings, and a derived entry that ends up with no
 *   bullet is dropped rather than printed as a bare header.
 *
 * Everything here is pure string work over LaTeX the user supplied — no
 * database, no network, no LLM. Unit-tested in `tests/pdf/base-entries.test.ts`.
 */

import {
  deriveProjectsFromSections,
  extractBaseProjects,
  latexToPlain,
  readBalancedGroup,
} from "./latex";
import { isExperienceHeading, isProjectsHeading, soleSection } from "./headings";
import type { CitedBullet, TailorOutput } from "../pipeline/schemas";

/** The most bullets a derived experience entry gets — mirrors the prompt's cap. */
export const MAX_BULLETS_PER_ENTRY = 3;

/** One `\resumeSubheading` block read out of a base `.tex`'s Experience section. */
export interface BaseExperienceEntry {
  /** First argument, plain text: `Mercor`. */
  organization: string;
  /** Third argument, plain text: `Software Engineering Expert`. */
  role: string;
  /** Fourth argument, plain text: `Remote`. */
  location: string;
  /** Left half of the second argument: `November 2025`. */
  start: string;
  /** Right half of the second argument: `Present`. */
  end: string;
}

// ---------------------------------------------------------------------------
// Reading the base resume's Experience section
// ---------------------------------------------------------------------------

/**
 * The heading that opens the base's employment history.
 *
 * The qualifiers are not decoration: a resume headed `\section{Work
 * Experience}` used to yield `experienceRegion() === null`, so
 * `extractBaseExperience()` returned `[]` and the whole enrichment silently
 * did nothing — no dates on the PDF and no diagnostic anywhere. Kept in step
 * with {@link isExperienceHeading}, which accepts the same qualifiers on the
 * *tailor* side.
 */
const EXPERIENCE_SECTION_REGEX =
  /\\section\s*\{\s*(?:work\s+|professional\s+|employment\s+)?Experience\s*\}/i;
const LIST_START = "\\resumeSubHeadingListStart";
const LIST_END = "\\resumeSubHeadingListEnd";
const SUBHEADING = "\\resumeSubheading";

/**
 * The body of the base's Experience list, or `null` to read nothing from it.
 *
 * Bounded to that one section on purpose. Jake's template uses the same
 * `\resumeSubheading` macro in Education with the arguments in a *different*
 * order — `{University Of Calgary}{Calgary, AB}{Bachelor of Science}{Dec
 * 2026}`, where the second argument is a city, not a date range — so a
 * document-wide scan would confidently read "Calgary, AB" as an employment
 * start date. (`isDateRange()` would reject that one anyway; the bound is
 * what stops a degree being printed as a job.)
 *
 * A `\section{` inside the region means the list was never closed and the
 * forward search has run into the next section, so this gives up rather than
 * read another section's entries as jobs — the same "leave it alone rather
 * than corrupt it" stance `findProjectsBlock()` takes in `./latex.ts`.
 */
export function experienceRegion(latex: string): string | null {
  const heading = EXPERIENCE_SECTION_REGEX.exec(latex);
  if (!heading || heading.index === undefined) return null;

  const start = latex.indexOf(LIST_START, heading.index);
  if (start === -1) return null;

  const end = latex.indexOf(LIST_END, start + LIST_START.length);
  if (end === -1) return null;

  const body = latex.slice(start + LIST_START.length, end);
  return /\\section\s*\{/.test(body) ? null : body;
}

/** Skips whitespace and `% …` comments, returning the next content index. */
function skipFiller(src: string, from: number): number {
  let i = from;
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] !== "%") return i;
    const newline = src.indexOf("\n", i);
    if (newline === -1) return src.length;
    i = newline + 1;
  }
}

/** A date-range argument has a year in it, or says the role is current. */
function isDateRange(raw: string): boolean {
  return /\d{4}/.test(raw) || /\b(present|current|ongoing)\b/i.test(raw);
}

/**
 * `November 2025 -- Present` → `{start: "November 2025", end: "Present"}`.
 *
 * Anything that does not look like a date range at all (Jake's template puts
 * a city in this argument under Education) yields two empty strings, so a
 * misread argument produces *nothing* rather than a wrong start date.
 */
export function splitDateRange(raw: string): { start: string; end: string } {
  const text = latexToPlain(raw);
  if (!isDateRange(text)) return { start: "", end: "" };

  // en/em dash, LaTeX's `--`/`---`, or a hyphen with space around it. A bare
  // hyphen is not a separator: it also spells `2024-2025`… which is why the
  // hyphen branch requires the surrounding spaces and `--` is listed first.
  const parts = text.split(/\s*(?:---|--|[–—])\s*|\s+-\s+/);
  if (parts.length >= 2) {
    return { start: parts[0].trim(), end: parts.slice(1).join(" ").trim() };
  }
  return { start: text.trim(), end: "" };
}

/**
 * Every `\resumeSubheading{org}{dates}{role}{location}` in the base's
 * Experience section, in the order the user wrote them.
 *
 * Brace-balanced via `readBalancedGroup()` rather than regex-matched, for the
 * same reason `extractBaseProjects()` is: a real argument nests
 * (`{GenLabs Inc. (\href{https://genlabs.ca}{genlabs.ca})}`) and `\{[^}]*\}`
 * stops at the first `}`.
 */
export function extractBaseExperience(latex: string): BaseExperienceEntry[] {
  const body = experienceRegion(latex);
  if (!body) return [];

  const entries: BaseExperienceEntry[] = [];
  let cursor = 0;
  for (;;) {
    const at = body.indexOf(SUBHEADING, cursor);
    if (at === -1) break;
    cursor = at + SUBHEADING.length;

    const args: string[] = [];
    let i = cursor;
    for (let n = 0; n < 4; n++) {
      i = skipFiller(body, i);
      const group = readBalancedGroup(body, i);
      if (!group) break;
      args.push(group.value);
      i = group.end;
    }
    if (args.length < 4) continue;
    cursor = i;

    const { start, end } = splitDateRange(args[1]);
    entries.push({
      organization: latexToPlain(args[0]),
      role: latexToPlain(args[2]),
      location: latexToPlain(args[3]),
      start,
      end,
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Matching a tailored entry to a base entry
// ---------------------------------------------------------------------------

/**
 * Words too common in an employer or job title to identify one. "Software
 * Engineer at Google" and "Software Engineer at Meta" must not match on
 * `software`/`engineer`.
 */
const ORG_STOPWORDS = new Set([
  "inc", "llc", "ltd", "corp", "corporation", "company", "co", "the", "and",
  "of", "at", "for", "group", "team", "technologies", "technology", "tech",
  "solutions", "systems", "services", "labs", "software", "engineer",
  "engineering", "developer", "development", "intern", "internship", "student",
  "senior", "junior", "lead", "staff", "program", "programs", "project",
  "projects", "full", "stack", "fullstack", "remote", "contract", "part",
  "time", "assistant", "associate", "analyst", "consultant", "manager",
]);

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Distinctive lowercase tokens of an employer/title, for fuzzy matching. */
function orgTokens(text: string): string[] {
  return [
    ...new Set(
      normalize(text)
        .split(" ")
        .filter((token) => token.length >= 3 && !ORG_STOPWORDS.has(token)),
    ),
  ];
}

/** Both names normalize to the same string — the same employer, written twice. */
const EXACT_SCORE = 1000;
/** One whole name contains the other: `Google` ⊂ `Google Innovate Program…`. */
const CONTAINMENT_SCORE = 500;
/** Per distinctive word the two names share. */
const TOKEN_SCORE = 100;

/**
 * The weakest evidence {@link pairWithBase} will pair on: a whole-name
 * containment, or **two** distinct shared words. One shared word is not
 * evidence of an employer.
 *
 * QA reproduced the damage against the owner's real base resume: it holds a
 * `City of Calgary` row, and a tailored entry for a different employer whose
 * name happens to contain the same city — `Calgary Co-op`, or `University of
 * Calgary` — scored 100 on the single token `calgary`, which the old `score >
 * 0` test accepted. The PDF then printed *Calgary Co-op · Calgary, AB ·
 * September 2025 – Present*: the City of Calgary's dates and office against a
 * company the candidate never worked for. Every string on the page is real,
 * which is precisely why nothing downstream catches it.
 */
export const MIN_MATCH_SCORE = 2 * TOKEN_SCORE;

/**
 * Whole-word containment over normalized (space-separated) names.
 *
 * A plain `includes()` has no word boundaries, so a short organization name
 * matches inside an unrelated one — `Ada` inside `Canada Post`, `Ibm` inside
 * `Wasabi Mbank`. Padding both sides with a space turns the substring test
 * into a word-boundary test for free, and names shorter than
 * {@link MIN_CONTAINMENT_LENGTH} are refused outright: a two-letter token is
 * an initialism collision waiting to happen.
 */
const MIN_CONTAINMENT_LENGTH = 3;

function containsAsWords(hay: string, needle: string): boolean {
  if (needle.length < MIN_CONTAINMENT_LENGTH) return false;
  return ` ${hay} `.includes(` ${needle} `);
}

/**
 * How strongly a tailored entry and a base entry describe the same job.
 * `0` means "no evidence at all", and anything below
 * {@link MIN_MATCH_SCORE} never matches.
 *
 * ## Only the organization can establish a match
 *
 * The candidate's `organization` is compared against *both* of the base
 * entry's name slots, because Jake's template does not fix which of employer
 * and title goes in the first argument — the owner's own resume writes one
 * entry as `{Co-Founder}{…}{GenLabs Inc.}{…}`, the two swapped — and a strict
 * field-to-field comparison would miss it.
 *
 * The candidate's `role` is only ever a **tie-breaker**, and contributes
 * nothing at all when the organization matched nothing (`0` short-circuits
 * before the bonus). A job title on its own is far too weak to identify an
 * employer, and treating it as evidence produced exactly the bug this guard
 * exists for: "Launch Loom / Founder & Full-Stack Engineer" matched the base's
 * "Co-Founder / GenLabs Inc." on the single word *founder*, and the resume
 * came out claiming the candidate worked at Launch Loom from June 2025 to
 * September 2025 — GenLabs' dates, on a different company. Dates copied onto
 * the wrong employer are a false statement about the candidate's history, and
 * no downstream check catches it, because every individual string on the page
 * is real.
 */
export function scoreEntryMatch(
  candidate: { organization: string; role?: string },
  base: BaseExperienceEntry,
): number {
  const org = normalize(candidate.organization);
  const baseOrg = normalize(base.organization);
  const baseRole = normalize(base.role);
  if (!org) return 0;

  if (org === baseOrg || org === baseRole) return EXACT_SCORE;

  let score = 0;
  for (const hay of [baseOrg, baseRole]) {
    if (!hay) continue;
    if (containsAsWords(org, hay) || containsAsWords(hay, org)) {
      score = Math.max(score, CONTAINMENT_SCORE);
    }
  }

  const baseHay = orgTokens(`${base.organization} ${base.role}`);
  score += orgTokens(candidate.organization).filter((t) => baseHay.includes(t)).length * TOKEN_SCORE;

  // No organization evidence, no match — the title never gets a vote of its own.
  if (score === 0) return 0;

  return score + orgTokens(candidate.role ?? "").filter((t) => baseHay.includes(t)).length;
}

/**
 * Greedily pairs tailored entries with base entries, best match first, each
 * base entry claimed at most once. Returns tailor-index → base entry.
 *
 * Global rather than per-entry ("for each tailored entry, take its best base
 * entry") because per-entry is order-dependent: a weak first entry can claim
 * the base row a later entry matches exactly, and the exact match is then left
 * with nothing.
 *
 * Only scores of at least {@link MIN_MATCH_SCORE} are pairs at all — see that
 * constant for the wrong-employer bug a `> 0` test shipped. The role
 * tie-breaker cannot lift a one-token match over the bar: it adds a single
 * point per shared title word, so a lone shared organization word tops out at
 * 100-and-change against a threshold of 200.
 */
function pairWithBase(
  candidates: readonly { organization: string; role?: string }[],
  base: readonly BaseExperienceEntry[],
): Map<number, BaseExperienceEntry> {
  const pairs: { candidate: number; base: number; score: number }[] = [];
  candidates.forEach((candidate, ci) => {
    base.forEach((entry, bi) => {
      const score = scoreEntryMatch(candidate, entry);
      if (score >= MIN_MATCH_SCORE) pairs.push({ candidate: ci, base: bi, score });
    });
  });
  pairs.sort(
    (a, b) => b.score - a.score || a.candidate - b.candidate || a.base - b.base,
  );

  const matched = new Map<number, BaseExperienceEntry>();
  const usedBase = new Set<number>();
  for (const pair of pairs) {
    if (matched.has(pair.candidate) || usedBase.has(pair.base)) continue;
    matched.set(pair.candidate, base[pair.base]);
    usedBase.add(pair.base);
  }
  return matched;
}

// ---------------------------------------------------------------------------
// Enriching / deriving
// ---------------------------------------------------------------------------

function blank(value: string | undefined | null): boolean {
  return !(value ?? "").trim();
}

/**
 * Fills the empty header fields of each tailored experience entry from the
 * base resume entry it matches. Never overwrites a non-empty field, never
 * touches bullets, and returns the entries in the tailor's own order (which
 * is "most relevant to this posting first", not chronological).
 */
export function enrichExperience(
  entries: NonNullable<TailorOutput["experience"]>,
  base: readonly BaseExperienceEntry[],
): NonNullable<TailorOutput["experience"]> {
  if (entries.length === 0 || base.length === 0) return entries;
  const matched = pairWithBase(entries, base);

  return entries.map((entry, i) => {
    const from = matched.get(i);
    if (!from) return entry;
    return {
      ...entry,
      role: blank(entry.role) ? from.role : entry.role,
      location: blank(entry.location) ? from.location : entry.location,
      start: blank(entry.start) ? from.start : entry.start,
      end: blank(entry.end) ? from.end : entry.end,
    };
  });
}

/**
 * Rebuilds an employment history for a legacy tailor row — one with a loose
 * `sections: [{heading: "Experience", …}]` list and no `experience` field.
 *
 * A bullet is attached to an employer **only when the bullet names that
 * employer**: score every (bullet, base entry) pair by how many distinctive
 * words of the employer and title appear in the bullet ("At Mercor, performed
 * comparative evaluations…" → the `Mercor` entry), take the highest-scoring
 * pairs first, at most {@link MAX_BULLETS_PER_ENTRY} to an entry, and drop
 * base entries that ended up with nothing so the page never shows a header
 * with no bullet under it.
 *
 * ## Why this stops where `deriveProjectsFromSections()` keeps going
 *
 * Its projects twin has a second pass: bullets that named nothing recognisable
 * are dealt out to whichever base projects are still empty. Applied to
 * employers that pass is not a heuristic, it is a fabrication. Run against the
 * owner's own legacy row it put the City of Calgary's GHG data pipeline under
 * **Mercor**, Google's BigQuery work under **City of Calgary**, and Mercor's
 * LLM evaluations under **GenLabs** — four employers, four wrong attributions,
 * every one of them a false statement about where the candidate worked, on a
 * document that goes to employers. An anonymous bullet is merely unhelpful;
 * this is the failure the whole citation architecture exists to prevent, and
 * a bullet's `fact_ids` cannot catch it because the facts are real — only the
 * employer they are filed under is invented. (A project bullet dealt to the
 * wrong project is wrong too, but it misstates *what a personal project did*,
 * not *who employed the candidate*, and that pass is what the shipped LaTeX
 * renderer already does — diverging here would make the two renderers
 * disagree about the same generation.)
 *
 * So this is **all or nothing**: unless every bullet names an employer, it
 * returns `[]` and the caller leaves the loose section exactly where it was.
 * The page then reads as it did before — anonymous bullets under EXPERIENCE,
 * which is all a pre-1.2.0 generation ever actually knew — and one click on
 * "Generate tailored resume" produces a row with real entries. Partial
 * derivation is not an option either: the matched bullets would move into
 * `experience` and `extraSections()` would then drop the loose section that
 * still held the unmatched ones, silently deleting them from the resume.
 *
 * Output order is the tailor's bullet order, preserving "most relevant first".
 */
export function deriveExperienceFromSections(
  tailor: TailorOutput,
  base: readonly BaseExperienceEntry[],
): NonNullable<TailorOutput["experience"]> {
  const section = soleSection(tailor.sections, isExperienceHeading);
  const bullets = section?.bullets ?? [];
  if (bullets.length === 0 || base.length === 0) return [];

  const assigned: { index: number; bullet: CitedBullet }[][] = base.map(() => []);
  const claimed = new Set<number>();

  // The employer's *name* only — never the job title. A title's words are
  // generic enough to match anything: scoring "Data Intern" too let the bullet
  // "Built an automated data pipeline." claim that employer on the word
  // "data", which is exactly the wrong-employer attribution this function
  // refuses to make.
  const pairs: { bullet: number; entry: number; score: number }[] = [];
  bullets.forEach((bullet, bi) => {
    base.forEach((entry, ei) => {
      const haystack = bullet.text.toLowerCase();
      const score = orgTokens(entry.organization).filter((token) =>
        haystack.includes(token),
      ).length;
      if (score > 0) pairs.push({ bullet: bi, entry: ei, score });
    });
  });
  pairs.sort((a, b) => b.score - a.score || a.bullet - b.bullet || a.entry - b.entry);

  for (const pair of pairs) {
    if (claimed.has(pair.bullet)) continue;
    if (assigned[pair.entry].length >= MAX_BULLETS_PER_ENTRY) continue;
    assigned[pair.entry].push({ index: pair.bullet, bullet: bullets[pair.bullet] });
    claimed.add(pair.bullet);
  }

  // One unplaceable bullet forfeits the whole derivation — see above.
  if (claimed.size !== bullets.length) return [];

  return assigned
    .map((items, entryIndex) => ({ entryIndex, items }))
    .filter((entry) => entry.items.length > 0)
    .sort(
      (a, b) =>
        Math.min(...a.items.map((i) => i.index)) - Math.min(...b.items.map((i) => i.index)),
    )
    .map(({ entryIndex, items }) => ({
      organization: base[entryIndex].organization,
      role: base[entryIndex].role,
      location: base[entryIndex].location,
      start: base[entryIndex].start,
      end: base[entryIndex].end,
      bullets: items.sort((a, b) => a.index - b.index).map((i) => i.bullet),
    }));
}

/**
 * The same job for Projects: names a legacy row's loose "Projects" bullets
 * after the base resume's real projects.
 *
 * Delegates the assignment to `./latex.ts`'s `deriveProjectsFromSections()` so
 * the two renderers cannot disagree about which bullet belongs to which
 * project, then converts its LaTeX heading back to the plain
 * `name` / `technologies` pair the react-pdf template wants —
 * `latexToPlain()` reduces `\textbf{\href{…}{\textcolor{myblue}{CYD Soccer}}}
 * $|$ \emph{Next.js, Supabase}` to `CYD Soccer $|$ Next.js, Supabase`, and
 * `$|$` is the template's own separator, untouched by that reduction.
 *
 * ## All or nothing, exactly as the experience side is
 *
 * `deriveProjectsFromSections()` places what it can and lets the rest fall on
 * the floor: leftover bullets are dealt only to base projects that are *still
 * empty*, so a row with more loose bullets than the base has projects (or more
 * than `MAX_BULLETS_PER_PROJECT` for one of them) ends up with bullets
 * assigned nowhere. That is harmless in the LaTeX renderer, which keeps the
 * base's own Projects block either way — but here the returned array populates
 * `tailor.projects`, and `extraSections()` then drops the loose "Projects"
 * section that still held the strays. QA reproduced six loose bullets going in
 * and four coming out of the react-pdf page, with two silently deleted.
 *
 * So if a single bullet is unplaced, this returns `[]`, the loose section
 * stays exactly where it was, and every bullet the generation produced is
 * still on the page — the same rule, and the same reasoning, as
 * {@link deriveExperienceFromSections}.
 */
export function deriveProjectsForTemplate(
  tailor: TailorOutput,
  baseLatex: string,
): NonNullable<TailorOutput["projects"]> {
  const baseProjects = extractBaseProjects(baseLatex);
  if (baseProjects.length === 0) return [];

  const section = soleSection(tailor.sections, isProjectsHeading);
  if (!section || section.bullets.length === 0) return [];

  // `deriveProjectsFromSections` works in bullet *text*; re-attach each
  // bullet's `fact_ids` by looking the text back up, so the citations that
  // survived `stripUnsupportedBullets()` reach the page intact.
  const byText = new Map(section.bullets.map((b) => [b.text, b] as const));

  const projects = deriveProjectsFromSectionsPlain(tailor, baseProjects).map((project) => ({
    name: project.name,
    technologies: project.technologies,
    bullets: project.bullets.map(
      (text) => byText.get(text) ?? { text, fact_ids: [] as string[] },
    ),
  }));

  // One dropped bullet forfeits the whole derivation — see above.
  const placed = projects.reduce((total, project) => total + project.bullets.length, 0);
  if (placed !== section.bullets.length) return [];

  return projects;
}

function deriveProjectsFromSectionsPlain(
  tailor: TailorOutput,
  baseProjects: ReturnType<typeof extractBaseProjects>,
): { name: string; technologies: string; bullets: string[] }[] {
  return deriveProjectsFromSections(tailor, baseProjects).map((resolved) => {
    const [namePart, techPart] = latexToPlain(resolved.headingRaw).split("$|$");
    return {
      name: (namePart ?? "").trim(),
      technologies: (techPart ?? "").trim(),
      bullets: resolved.bullets,
    };
  });
}

/**
 * The one call the PDF route makes: returns a `TailorOutput` whose entry
 * headers are as complete as the user's own base resume can make them.
 *
 * A no-op — the input object, unchanged — when there is no base resume, which
 * is the honest answer for a user who has never imported one: an empty date is
 * better than a guessed one.
 */
export function enrichTailorFromBase(
  tailor: TailorOutput,
  baseLatex: string | null | undefined,
): TailorOutput {
  if (!baseLatex?.trim()) return tailor;

  const baseExperience = extractBaseExperience(baseLatex);
  const current = tailor.experience ?? [];
  const experience =
    current.length > 0
      ? enrichExperience(current, baseExperience)
      : deriveExperienceFromSections(tailor, baseExperience);

  const projects =
    (tailor.projects ?? []).length > 0
      ? tailor.projects
      : deriveProjectsForTemplate(tailor, baseLatex);

  return {
    ...tailor,
    ...(experience.length > 0 ? { experience } : {}),
    ...((projects ?? []).length > 0 ? { projects } : {}),
  };
}
