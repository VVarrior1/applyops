/**
 * The one place job-text heuristics live (spec §6).
 *
 * v1 carried three near-identical copies of `isEntryLevel` / `isRelevantRole`
 * / `isPreferredLocation` (scrape-apis.ts, scrape-builtin.ts, scrape-otta.ts)
 * that had already drifted apart. This module is the single source, and it is
 * deliberately pure: no network, no DB, no LLM, no `console.log` — which is
 * what makes it unit-testable (`tests/finders/filters.test.ts`) and cheap to
 * run over thousands of postings inside `runFinders`.
 *
 * Two deliberate departures from the v1 port:
 *
 * 1. **Word boundaries instead of `String.includes`.** v1 rejected any job
 *    whose *title + description* contained the substring "lead", which killed
 *    every posting mentioning "leadership" or "misleading". Seniority is now
 *    judged from the **title** (where it is actually stated), and only hard
 *    evidence — an explicit years-of-experience requirement, a PhD, senior
 *    context phrases — is read out of the description.
 * 2. **Graduation years need a graduation context.** v1 accepted any text
 *    containing "2026", which in 2026 matches every copyright footer. The
 *    year now has to sit next to "class of" / "graduat…".
 *
 * These functions are advisory: `runFinders` stores their verdicts on the job
 * row (`is_entry_level`, `is_relevant_role`, `work_auth_signal`) rather than
 * dropping the posting, so a bad heuristic loses ranking signal instead of
 * silently losing jobs.
 */
import type { WorkAuthSignal } from "./types";

// ---------------------------------------------------------------------------
// Entry level
// ---------------------------------------------------------------------------

/** Seniority read off the *title*. Word-anchored (see file header). */
const SENIORITY_TITLE = [
  /\bsenior\b/,
  /\bsnr\b/,
  /\bsr\b/,
  /\bstaff\b/,
  /\bprincipal\b/,
  /\blead\b/,
  /\bleads\b/,
  /\bmanager\b/,
  /\bmanagement\b/,
  /\bdirector\b/,
  /\bvp\b/,
  /\bvice[- ]president\b/,
  /\bhead\s+of\b/,
  /\bchief\b/,
  /\barchitect\b/,
  /\bdistinguished\b/,
  /\bexpert\b/,
  /\bexperienced\b/,
  /\bveteran\b/,
  /\bii\b/,
  /\biii\b/,
  /\biv\b/,
];

/**
 * Spelled-out counts → digits, so one regex family covers both "5 years" and
 * "five years". Postings write the requirement either way ("a minimum of five
 * (5) years"), and before this, half of them read as entry level.
 *
 * Applied only to the copy of the text used for the years checks
 * ({@link yearsText}) — never to the copy the entry-level/senior-context
 * signals read — so turning the very common word "one" into "1" cannot
 * change any other verdict.
 */
const NUMBER_WORDS: Record<string, string> = {
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
};
const NUMBER_WORD_RE = new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join("|")})\\b`, "g");

/**
 * "3+ years", "5 yrs", "4-6 years", "10 years", "five years", "five+ years",
 * "minimum of 5 years", "5 or more years", "at least five years", "5+ yrs" —
 * anything at or above three years. Two-or-fewer-years mentions are left
 * alone on purpose: "0-2 years" and "1-2 years" are entry-level phrasing.
 *
 * The optional "or more"/"plus" clause is what catches "3 or more years",
 * which the bare `3\s*\+?\s*years` shape misses; the "at least"/"minimum of"
 * lead-ins are already covered because the number still sits before the unit
 * ("minimum of 5 years" contains "5 years"), and {@link YEARS_LEAD_IN} picks
 * up the looser variants that put a word in between ("at least 5 full years").
 */
const YEARS_AT_LEAST_THREE =
  /\b(?:[3-9]|[1-9]\d)\s*\+?\s*(?:(?:or (?:more|greater|above)|plus)\s+)?(?:years?|yrs?)\b/;

/** "at least 5 full years", "a minimum of four relevant years". */
const YEARS_LEAD_IN =
  /\b(?:at least|minimum(?:\s+of)?|min\.?(?:\s+of)?|no less than|not less than|over|more than)\s+(?:[3-9]|[1-9]\d)\s*\+?\s*(?:[a-z]+\s+){0,2}(?:years?|yrs?)\b/;
/** Any years-of-experience mention at all (the strict late-stage check). */
const ANY_YEARS = /\b\d+\s*\+?\s*(?:years?|yrs?)\b/;
const ADVANCED_DEGREE = /\b(?:ph\.?\s?d|doctorate|postdoc)\b/;

/** Phrases that only appear in senior job ads. */
const SENIOR_CONTEXT = [
  /\bextensive experience\b/,
  /\bproven track record\b/,
  /\bdeep expertise\b/,
  /\bexpert in\b/,
  /\bmastery of\b/,
  /\bthought leader\b/,
  /\bindustry veteran\b/,
];

/** Positive entry-level evidence; one hit is enough. */
const ENTRY_LEVEL_SIGNALS = [
  /\bnew\s?grad(?:uate)?s?\b/,
  /\brecent (?:college |university )?grad(?:uate)?s?\b/,
  /\bjunior\b/,
  /\bjr\b/,
  /\bentry[- ]level\b/,
  /\bintern(?:ship)?s?\b/,
  /\bassociate\b/,
  /\bearly[- ]career\b/,
  /\bapprentice(?:ship)?\b/,
  /\bco-?op\b/,
  /\bcampus hire\b/,
  /\buniversity (?:grad|recruit|program)\w*\b/,
  /\bcollege grad\w*\b/,
  /\bgraduating\b/,
  /\bnew grads? (?:ok|welcome)\b/,
  /\b0\s*[-–]\s*[123]\s*(?:years?|yrs?)\b/,
  /\b1\s*[-–]\s*2\s*(?:years?|yrs?)\b/,
  // A graduation year, but only in a graduation context (see file header).
  /\b(?:class of|graduat\w*)\b[^.]{0,30}\b20(?:2[5-9]|3\d)\b/,
  /\b20(?:2[5-9]|3\d)\b[^.]{0,25}\bgrad\w*\b/,
];

/**
 * Titles that are generic enough to be plausibly entry level on their own.
 * Only an *exact* match counts — "Staff Software Engineer" must not sneak in
 * through "software engineer".
 */
const EXACT_GENERIC_TITLES = new Set([
  "software engineer",
  "software developer",
  "software development engineer",
  "full stack engineer",
  "full stack developer",
  "fullstack engineer",
  "fullstack developer",
  "backend engineer",
  "backend developer",
  "back end engineer",
  "frontend engineer",
  "frontend developer",
  "front end engineer",
  "web developer",
  "programmer",
]);

/**
 * True when the posting reads as new-grad / junior / intern level.
 *
 * Order matters and mirrors v1: hard rejections first (title seniority,
 * years-of-experience, advanced degree, senior context), then positive
 * signals, then the "exactly generic title with no experience mentioned at
 * all" fallback, then reject.
 */
export function isEntryLevel(title: string, description: string): boolean {
  const titleLower = (title ?? "").toLowerCase().trim();
  const text = `${title ?? ""} ${description ?? ""}`.toLowerCase();

  if (SENIORITY_TITLE.some((re) => re.test(titleLower))) return false;
  // Ranges are judged by their LOWER bound: "1-3 years" / "0 to 2 years" are
  // new-grad territory even though "3 years" appears in the text. Ranges whose
  // lower bound is ≤1 are stripped before the ≥3-years check runs.
  if (wantsThreePlusYears(text)) return false;
  if (ADVANCED_DEGREE.test(text)) return false;
  if (SENIOR_CONTEXT.some((re) => re.test(text))) return false;

  if (ENTRY_LEVEL_SIGNALS.some((re) => re.test(text))) return true;

  // No explicit entry-level wording. Since 2026-08-27 this is ALLOWED: most
  // Canadian postings say plain "Software Engineer" with no seniority word,
  // and requiring "new grad"/"junior" threw away ~90% of them (22 of 227
  // non-senior Canadian engineering titles). Everything that signals
  // seniority — senior/staff/lead titles, "3+ years", advanced degrees,
  // "extensive experience" — was already rejected above; the fit score and
  // the verdict handle the rest per user. "1-2 years" style asks stay in.
  void ANY_YEARS;
  void EXACT_GENERIC_TITLES;
  return true;
}

/**
 * The text the years-of-experience checks run against: year *ranges* whose
 * lower bound is 0 or 1 removed entirely, optionally after resolving spelled
 * -out counts to digits.
 *
 * The range strip is what makes ranges judged by their LOWER bound: "1-3
 * years" and "one to three years" are new-grad asks even though "3 years"
 * appears in the text, while "3-5 years" keeps its "5 years" and is rejected.
 * A parenthesised restatement of the same count ("five (5) years") is folded
 * away in between, so it cannot split the count from its unit.
 */
function yearsText(text: string, spellOut: boolean): string {
  const withDigits = spellOut ? text.replace(NUMBER_WORD_RE, (m) => NUMBER_WORDS[m]) : text;
  return withDigits
    // "five (5) years" — after the word→digit pass that reads "5 (5) years",
    // and the parenthetical would otherwise sit between the count and the
    // unit and defeat every pattern below. Boilerplate-common in ATS text.
    .replace(/(\d)\s*\(\s*\d+\s*\)/g, "$1")
    .replace(/\b[01]\s*(?:-|–|—|to)\s*\d{1,2}\s*\+?\s*(?:years?|yrs?)\b/g, " ");
}

/**
 * Words that make a nearby "N years" an actual *requirement* rather than
 * prose. Only spelled-out counts are held to this (see
 * {@link wantsThreePlusYears}).
 */
const YEARS_REQUIREMENT_CONTEXT =
  /\b(?:experience|exp|background|professional|industry|hands[- ]?on|track record|expertise|relevant|related|minimum|min|at least|required?|requires|requirement|qualifications?|working|worked|practice|practicing|proven|equivalent|prior)\b/;

/**
 * True when the text demands three or more years of experience.
 *
 * Digits and spelled-out counts are held to deliberately different bars:
 *
 * - **Digits** ("5+ years", "4-6 years") are matched anywhere. A posting that
 *   prints a number next to "years" is nearly always stating a requirement.
 * - **Number words** ("five years") must sit within 60 characters of a
 *   requirement word. Spelled-out counts show up in ordinary prose far more
 *   often than digits do, and two of the owner's real postings proved it:
 *   "Associate Product Engineer (College Grad 2027)" reads "you'll grow
 *   faster here in one year than you would in three years at a big tech
 *   company" — a recruiting flourish, not an ask. Requiring the context word
 *   keeps "at least five years of experience" (a real ask, same corpus)
 *   rejected while leaving those two alone. An explicitly open-ended spelled
 *   -out count ("five+ years", "five or more years") skips the context test:
 *   prose does not write that.
 */
function wantsThreePlusYears(text: string): boolean {
  const digits = yearsText(text, false);
  if (YEARS_AT_LEAST_THREE.test(digits) || YEARS_LEAD_IN.test(digits)) return true;

  const spelled = yearsText(text, true);
  for (const re of [YEARS_AT_LEAST_THREE, YEARS_LEAD_IN]) {
    const global = new RegExp(re.source, "g");
    for (const m of spelled.matchAll(global)) {
      const start = m.index ?? 0;
      // "three+ years" / "five or more years": nobody writes that in prose —
      // an explicit open-ended count IS the requirement, context or not.
      if (/\+|or more|or greater|or above|plus/.test(m[0])) return true;
      const before = spelled.slice(Math.max(0, start - 60), start);
      const after = spelled.slice(start + m[0].length, start + m[0].length + 60);
      if (YEARS_REQUIREMENT_CONTEXT.test(before) || YEARS_REQUIREMENT_CONTEXT.test(after)) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Unknown vs. false: descriptions the finders never fetched
// ---------------------------------------------------------------------------

/**
 * Minimum length for a description to count as a real posting body. Measured
 * against the live corpus: the finders' *synthesised* fallbacks (the title
 * alone, or a title plus two "Department: …" lines) all land well under this,
 * while the shortest genuine posting bodies are several hundred characters.
 */
export const MIN_USABLE_DESCRIPTION_CHARS = 200;

/**
 * True when `description` is an actual posting body rather than the
 * placeholder a finder stores when it never fetched the detail endpoint.
 *
 * This exists because of a real miss (Aug 2026): Workday and SmartRecruiters
 * capped their per-company detail fetches, so 48 of the owner's 139 visible
 * "entry level" postings had nothing but their title stored — and with no
 * text to read, `isEntryLevel` fell through to its permissive default and
 * called every one of them entry level. Several were "5+ years" roles.
 */
export function hasUsableDescription(description: string | null, title: string): boolean {
  const text = (description ?? "").trim();
  if (!text) return false;
  if (text.length < MIN_USABLE_DESCRIPTION_CHARS) return false;
  if (text.toLowerCase() === (title ?? "").trim().toLowerCase()) return false;
  return true;
}

/**
 * Entry-level evidence carried by the *title alone* — enough to call a
 * posting entry level even with no description at all, since no amount of
 * missing body text makes "Software Engineer Intern" a senior role.
 *
 * "Engineer I" / "Level 1" are the numbered-ladder bottom rung. The `i`
 * alternative cannot match "engineer ii": `\b` requires a non-word character
 * after the `i`, and there is none between the two `i`s.
 */
const TITLE_ENTRY_SIGNALS = [
  /\bjunior\b/,
  /\bjr\.?\b/,
  /\bnew\s?grad(?:uate)?s?\b/,
  /\bgrad(?:uate)?\b/,
  /\bintern(?:ship)?s?\b/,
  /\bco-?op\b/,
  /\bassociate\b/,
  /\bentry[- ]level\b/,
  /\bearly[- ]career\b/,
  /\bapprentice(?:ship)?\b/,
  /\bcampus\b/,
  /\b(?:engineer|developer|programmer|analyst|scientist)\s+(?:i|1)\b/,
  /\blevel\s*(?:1|i)\b/,
];

/** See {@link TITLE_ENTRY_SIGNALS}. */
export function titleEntrySignal(title: string): boolean {
  const titleLower = (title ?? "").toLowerCase().trim();
  if (!titleLower) return false;
  return TITLE_ENTRY_SIGNALS.some((re) => re.test(titleLower));
}

/**
 * Three-valued entry-level verdict — `true` / `false` / `null` ("unknown").
 *
 * `isEntryLevel` has to answer yes-or-no, and its default for text it cannot
 * read is `true` (deliberately: see its own comment — requiring explicit
 * "new grad" wording threw away ~90% of real Canadian postings). That default
 * is right when there IS a description and it simply says nothing about
 * seniority; it is wrong when there is no description at all, because then
 * "no seniority evidence" means "we never looked", not "we looked and found
 * none". This function is the one that tells those two cases apart, and it is
 * what `runFinders`, `jobs backfill-flags` and the ranker store.
 *
 *   - description usable → `isEntryLevel`'s verdict, unchanged.
 *   - no usable description and a title that is itself disqualifying
 *     (senior/staff/lead/manager/…) → `false`. That is a real "no", not an
 *     unknown; the missing body cannot rehabilitate "Senior Software
 *     Engineer", and it is checked first so "Associate Director" reads as
 *     senior rather than as the entry-level word "associate".
 *   - no usable description, but the title says junior/intern/new grad/… →
 *     `true`. The title alone is sufficient evidence.
 *   - otherwise → `null`. The posting is not hidden — `/jobs` can still show
 *     it under `level=unknown`, and the verdict carries a soft "check the
 *     experience requirement on the posting" caveat — but it no longer
 *     masquerades as a confirmed entry-level match.
 */
export function classifyEntryLevel(
  title: string,
  description: string | null,
): boolean | null {
  if (hasUsableDescription(description, title)) {
    return isEntryLevel(title, description ?? "");
  }
  // Re-run the yes/no filter against the title alone FIRST: everything it can
  // still reject there (title seniority, "10 years" in the title itself) is a
  // fact about the title, not something the missing description could change
  // — and a title carrying both signals ("Associate Director, Engineering",
  // "Senior Engineer, Intern Mentor") is senior, not entry.
  if (!isEntryLevel(title, "")) return false;
  if (titleEntrySignal(title)) return true;
  return null;
}

/** "Software Engineer, New Grad (Remote)" → "software engineer, new grad". */
function normalizeTitle(titleLower: string): string {
  return titleLower
    .replace(/\((?:[^()]*)\)/g, " ")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Relevant role
// ---------------------------------------------------------------------------

/**
 * Non-technical titles. Ported from v1 with word boundaries (v1's substring
 * test excluded "Hardware Design Engineer" via "design"… among others) plus
 * the categories the OpenJobs gaming dataset floods the table with (artists,
 * animators, writers, QA-adjacent production roles).
 */
const EXCLUDED_ROLE_WORDS = [
  // Non-software engineering disciplines (energy/construction boards are full of these)
  /\b(?:pipeline|mechanical|electrical|civil|structural|chemical|process|petroleum|reservoir|drilling|completions|geotechnical|hydraulic|piping|rotating equipment|turbomachinery|hvac|facilities|materials|corrosion|integrity|environmental|mining|industrial|manufacturing|field|project|contact|maintenance|instrumentation|controls?|metallurg\w*|welding|survey\w*|geolog\w*|geophys\w*|nuclear|aerospace|automotive|biomedical|plant|commissioning|construction|estimat\w*) engineer/,
  /(?<!site )\breliability engineer\b/,
  /\bengineer(?:ing)?(?:,| -| –)? (?:technologist|technician)\b/,
  /\bp\.?eng\b/,
  /\beit\b/,
  // IT operations / admin roles that say "engineer" but are not software development
  /\b(?:windows|linux|network|desktop|help ?desk|service desk|systems? administrator|sysadmin|it support|noc|telecom\w*|voip|end[- ]user)\b/,
  /\bparalegal\b/,
  /\blegal\b/,
  /\bcounsel\b/,
  /\bcompliance\b/,
  /\bcustomer (?:support|success|service|experience)\b/,
  /\b(?:technical|it|product|client|user|player|member|desktop) support\b/,
  /\bsupport (?:associate|specialist|agent|representative|advocate|analyst|administrator)\b/,
  /\bservice desk\b/,
  /\bhelp ?desk\b/,
  /\boperations\b/,
  /\brecruit(?:er|ing|ment)\b/,
  /\btalent\b/,
  /\bsales\b/,
  /\baccount\b/,
  /\baccountant\b/,
  /\baccounting\b/,
  /\bmarketing\b/,
  /\bdesigner\b/,
  /\bproduct manager\b/,
  /\bprogram manager\b/,
  /\bproject manager\b/,
  /\bpm\b/,
  /\banalyst\b/,
  /\bcoordinator\b/,
  /\bassistant\b/,
  /\bhuman resources\b/,
  /\bpeople (?:ops|operations|partner)\b/,
  /\bfinance\b/,
  /\bcontroller\b/,
  /\bartist\b/,
  /\banimator\b/,
  /\banimation\b/,
  /\bwriter\b/,
  /\bnarrative\b/,
  /\beditor\b/,
  /\btranslator\b/,
  /\blocalization\b/,
  /\bcommunity\b/,
  /\bsocial media\b/,
  /\bpartnerships?\b/,
  /\bbusiness development\b/,
  /\bnurse\b/,
  /\bteacher\b/,
  /\bintern(?:ship)? coordinator\b/,
];

/**
 * The positive half of the test: the title has to name a software/technical
 * discipline.
 *
 * v1's filter was exclusion-only, which worked against a hand-picked list of
 * 146 tech companies. Against the ~1.3k companies `companies import` now
 * produces it does not: "Seasonal Warehouse Associate", "Food Safety
 * Associate" and "Internship (Facilities)" all contain an entry-level signal,
 * none of them contains an excluded word, and all three came back as relevant
 * engineering roles in an audit of 4,000 scraped postings. Requiring a
 * technical noun is what makes the filter mean what spec §6 says it means
 * ("engineering/technical roles only").
 */
const TECHNICAL_ROLE_WORDS = [
  /\bengineer(?:ing|s)?\b/,
  /\bdeveloper\b/,
  /\bprogrammer\b/,
  /\bswe\b/,
  /\bsde\b/,
  /\bsre\b/,
  /\bdevops\b/,
  /\bsoftware\b/,
  /\bscientist\b/,
  /\bfull[- ]?stack\b/,
  /\bback[- ]?end\b/,
  /\bfront[- ]?end\b/,
  /\bfirmware\b/,
  /\bembedded\b/,
  /\bcompiler\b/,
  /\bmachine learning\b/,
  /\bdata (?:science|engineering|platform)\b/,
  /\bcybersecurity\b/,
  /\bweb dev\w*\b/,
  /\bsite reliability\b/,
  /\bqa automation\b/,
];

/**
 * True when the title looks like an engineering/technical individual role:
 * it names a technical discipline and carries none of the excluded words.
 */
export function isRelevantRole(title: string): boolean {
  const titleLower = (title ?? "").toLowerCase();
  if (!titleLower.trim()) return false;
  if (EXCLUDED_ROLE_WORDS.some((re) => re.test(titleLower))) return false;
  return TECHNICAL_ROLE_WORDS.some((re) => re.test(titleLower));
}

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

const PLACEHOLDER_LOCATIONS = new Set([
  "unknown",
  "n/a",
  "na",
  "-",
  "tbd",
  "various",
  "multiple locations",
]);

/**
 * Lower-cased, whitespace-collapsed location, or null when the board gave us
 * nothing usable. Callers store the *original* string on the job row; this is
 * only for matching.
 */
export function normalizeLocation(location: string | null): string | null {
  if (!location) return null;
  const norm = location.replace(/\s+/g, " ").trim().toLowerCase();
  if (!norm || PLACEHOLDER_LOCATIONS.has(norm)) return null;
  return norm;
}

/**
 * Default allow-list: Canada + the US (the owner is a Calgary-based student
 * with TN eligibility, spec §1). Ported verbatim from v1 and then widened
 * with the bare province/state abbreviations the ATS boards actually emit.
 */
const PREFERRED_LOCATION_REGEX =
  /\b(?:calgary|edmonton|alberta|toronto|ottawa|waterloo|kitchener|mississauga|hamilton|london ont|vancouver|victoria|burnaby|montreal|montréal|quebec|québec|winnipeg|halifax|saskatoon|regina|british columbia|saskatchewan|manitoba|ontario|nova scotia|canada|canadian|\bab\b|\bbc\b|\bon\b|\bqc\b|usa|u\.s\.a|united states|u\.s\.?|\bus\b|america|americas|north america|seattle|san francisco|bay area|new york|nyc|boston|austin|denver|chicago|los angeles|san diego|atlanta|portland|texas|california|washington|colorado|massachusetts|illinois|georgia|oregon|arizona|utah|florida|remote)\b/;

/**
 * Remote roles get the stricter list: a "Remote" posting still has a hiring
 * region, and "Remote — India" is not a job this user can take.
 */
const REMOTE_REGION_REGEX =
  /\b(?:calgary|edmonton|alberta|toronto|vancouver|montreal|ontario|british columbia|canada|canadian|north america|americas|usa|u\.s\.a|united states|u\.s\.?|\bus\b|america|worldwide|global|anywhere)\b/;

/** Tokens that carry no geography, so a remote posting made only of them is unrestricted. */
const REMOTE_ONLY_TOKENS =
  /\b(?:remote|fully remote|remote friendly|work from home|wfh|distributed|hybrid|flexible|anywhere)\b/g;

/**
 * True when the posting's location is somewhere this user could work.
 *
 * With `prefs` (the user's `search_prefs` row) the user's own location list
 * and remote mode win; without them the default Canada/US allow-list applies,
 * which is what the nightly scrape uses since it runs before any user is
 * known.
 *
 * An unknown location keeps remote postings and drops onsite ones: an onsite
 * job whose city the board never published is not actionable.
 */
export function isPreferredLocation(
  location: string | null,
  remote: boolean,
  prefs?: { locations: string[]; remote: string },
): boolean {
  const mode = prefs?.remote ?? "any";
  if (mode === "remote" && !remote) return false;
  if (mode === "onsite" && remote) return false;

  const norm = normalizeLocation(location);

  if (prefs) {
    // With user prefs, geography is enforced by COUNTRY in SQL
    // (src/rank/candidates.ts → search_prefs.countries); the user's city list
    // is advisory only — it feeds the "onsite outside your cities" caveat in
    // src/rank/verdict.ts rather than hiding postings. (Before 2026-08-27 this
    // did a literal substring match against the raw pref strings, which
    // rejected "Calgary, Alberta, Canada" for a "Calgary, AB" pref and every
    // US city, leaving the ranker with zero candidates.)
    if (!norm) return remote; // unknown location: keep remote, drop onsite (not actionable)
    return true;
  }

  if (!norm) return remote;
  if (remote) {
    const geography = stripRemoteTokens(norm);
    if (geography === "") return true;
    return REMOTE_REGION_REGEX.test(geography);
  }
  return PREFERRED_LOCATION_REGEX.test(norm);
}

function stripRemoteTokens(norm: string): string {
  return norm
    .replace(REMOTE_ONLY_TOKENS, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Work authorisation
// ---------------------------------------------------------------------------

/**
 * TN status is the owner's route into US roles (spec §1), so an explicit
 * mention is the strongest positive signal there is.
 */
const TN_SIGNALS = [
  /\btn(?:-1\b|[- ](?:visa|status|permit|classification))/,
  /\b(?:nafta|usmca)\b/,
];

/**
 * Canadian hiring. A Canadian *location* alone is not enough — plenty of
 * "Toronto, Canada" postings are US-entity roles — so the text has to tie
 * hiring/employment/eligibility to Canada.
 */
const CANADA_HIRING_SIGNALS = [
  /\b(?:hir\w+|employ\w*|work\w*|eligib\w+|authoriz\w+|legally|based|located|payroll|entity|team)\b[^.]{0,60}?\bin canada\b/,
  /\bcanadian\s+(?:applicants?|candidates?|citizens?|permanent residents?|work permits?|payroll|entity|subsidiary|employees?|residents?)\b/,
  /\b(?:open to|available to|welcome(?:s)?)\b[^.]{0,40}\bcanad(?:a|ian)/,
  /\bcanada\b[^.]{0,30}\b(?:payroll|entity|subsidiary|employment)\b/,
];

/** Postings that require US work authorisation the owner does not have. */
const NEEDS_US_AUTH_SIGNALS = [
  /\bwithout\b[^.]{0,40}\bsponsorship\b/,
  /\bnot\b[^.]{0,25}\bsponsor\w*/,
  /\bunable to sponsor\b/,
  /\b(?:cannot|can't|won't|unwilling to) sponsor\w*/,
  /\bno (?:visa |immigration )?sponsorship\b/,
  /\bdo(?:es)? not (?:currently )?(?:provide |offer )?sponsor\w*/,
  /\b(?:must be|are|be) (?:legally )?authoriz\w+ to work in the (?:us|u\.s\.a?|usa|united states)\b/,
  /\bu\.?s\.? (?:citizen|person)(?:ship)? (?:is )?required\b/,
  /\bmust be a (?:u\.?s\.?|united states) (?:citizen|person)\b/,
  /\bus citizen\b/,
  /\bcitizen(?:ship)?\/visa only\b/,
  /\bsecurity clearance\b/,
];

/**
 * Classify a posting's work-authorisation stance from its text (the caller
 * passes `${location} ${description}` — location matters, see
 * CANADA_HIRING_SIGNALS).
 *
 * Precedence is TN → Canada → US-only → unclear: an explicit TN or Canadian
 * signal is actionable for this user even when the same ad also carries
 * boilerplate US-authorisation language for its US locations.
 */
export function detectWorkAuth(text: string): WorkAuthSignal {
  const t = (text ?? "").toLowerCase().replace(/\s+/g, " ");
  if (!t.trim()) return "unclear";
  if (TN_SIGNALS.some((re) => re.test(t))) return "tn_friendly";
  if (CANADA_HIRING_SIGNALS.some((re) => re.test(t))) return "hires_canadians";
  if (NEEDS_US_AUTH_SIGNALS.some((re) => re.test(t))) return "needs_us_auth";
  return "unclear";
}
