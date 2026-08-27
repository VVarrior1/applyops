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
 * "3+ years", "5 yrs", "4-6 years", "10 years" — anything at or above three
 * years. Two-or-fewer-years mentions are left alone on purpose: "0-2 years"
 * and "1-2 years" are entry-level phrasing.
 */
const YEARS_AT_LEAST_THREE = /\b(?:[3-9]|[1-9]\d)\s*\+?\s*(?:years?|yrs?)\b/;
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
  if (YEARS_AT_LEAST_THREE.test(text)) return false;
  if (ADVANCED_DEGREE.test(text)) return false;
  if (SENIOR_CONTEXT.some((re) => re.test(text))) return false;

  if (ENTRY_LEVEL_SIGNALS.some((re) => re.test(text))) return true;

  // No explicit entry-level wording. Any experience requirement at all now
  // disqualifies, and only a title that is *exactly* generic gets through.
  if (ANY_YEARS.test(text)) return false;
  return EXACT_GENERIC_TITLES.has(normalizeTitle(titleLower));
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
