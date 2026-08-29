/**
 * The cheap filters that run over every feed listing before any model is
 * called. Their job is to take ~22,000 records down to the handful worth
 * fetching a description for.
 *
 * Everything here is deliberately conservative in one direction: it is fine
 * to pass a listing that the LLM gate later rejects (costs a fraction of a
 * cent), and not fine to text the owner about a job in the wrong country or
 * at the wrong level.
 */
import type { FeedListing } from "./sources";

/** Postal abbreviations for the provinces and territories. */
const CA_PROVINCES = ["ON", "BC", "AB", "QC", "MB", "SK", "NS", "NB", "NL", "PE", "YT", "NT", "NU"];

/**
 * US state codes that share a city name with somewhere Canadian. The feed
 * really does contain "Vancouver, WA" (Washington) — matching the bare city
 * name would text the owner about a job in the United States, so a city hit
 * is only honoured when a US state does NOT follow it.
 */
const CITY_THEN_US_STATE =
  /\b(vancouver|london|windsor|hamilton|kingston|waterloo|cambridge|victoria)\s*,\s*(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/i;

/**
 * Countries that are definitively not Canada. Checked BEFORE the city list,
 * because several Canadian city names are borrowed from elsewhere: the live
 * feed contains "London, UK" (England, not London Ontario) and "Remote in
 * USA". Without this, a shared city name silently turns a London or a
 * Waterloo abroad into a Canadian match — and the whole promise of this tier
 * is that a text is worth acting on.
 */
const FOREIGN_COUNTRY =
  /\b(uk|u\.k\.|united kingdom|england|scotland|wales|ireland|usa|u\.s\.a\.|united states|india|germany|france|spain|netherlands|poland|romania|australia|singapore|japan|china|brazil|mexico|israel|sweden|norway|denmark|switzerland|italy|portugal|ukraine|philippines|vietnam|argentina|colombia|nigeria|kenya|south africa|new zealand|korea|taiwan|hong kong|uae|dubai)\b/i;

const CA_CITIES =
  /\b(toronto|montr[eé]al|vancouver|calgary|edmonton|ottawa|waterloo|kitchener|mississauga|burnaby|victoria|halifax|winnipeg|quebec city|hamilton|london|markham|brampton|richmond hill|kanata|gatineau|saskatoon|regina|st\.? john's)\b/i;

/**
 * True when the posting is somewhere the owner can actually work: Canada, or
 * remote with no country that rules Canada out.
 *
 * "Remote" with no country is treated as a maybe rather than a yes — plenty
 * of US-only roles say just "Remote" — so it passes here and is settled by
 * the LLM gate, which reads the posting's own work-authorization text.
 */
export function isCanadian(locations: string[]): boolean {
  const text = locations.join(" | ");
  if (!text.trim()) return false;

  if (/\bcanada\b/i.test(text)) return true;

  // Named somewhere else — settled before any city match, so "London, UK" and
  // "Remote in USA" can never be read as London, Ontario or as open to Canada.
  if (FOREIGN_COUNTRY.test(text)) return false;

  // A province code in a "City, XX" tail. Word-boundary anchored so "ON" does
  // not match inside "ONTARIO"-adjacent prose or a word like "MONITOR".
  const provincePattern = new RegExp(`,\\s*(${CA_PROVINCES.join("|")})\\b`);
  if (provincePattern.test(text)) return true;

  // A Canadian city name, unless a US state immediately follows it.
  if (CA_CITIES.test(text) && !CITY_THEN_US_STATE.test(text)) return true;

  return false;
}

/** Remote-anywhere postings, which the LLM gate has to settle rather than the location string. */
export function isAmbiguousRemote(locations: string[]): boolean {
  const text = locations.join(" | ");
  if (!/\bremote\b/i.test(text)) return false;
  // "Remote in USA" names its country: that is a no, not an ambiguity. Only a
  // bare "Remote" with nowhere attached is genuinely undecidable from the
  // location string, and only those are handed to the LLM gate.
  if (FOREIGN_COUNTRY.test(text)) return false;
  return !isCanadian(locations);
}

const SOFTWARE_CATEGORY = /software|engineering|data|machine learning|ai|ml|quant|security/i;
const SOFTWARE_TITLE =
  /\b(software|developer|engineer|engineering|programmer|data|machine learning|ml|ai|backend|back-end|frontend|front-end|full[- ]?stack|devops|sre|platform|infrastructure|qa|quality assurance|test|security|analyst)\b/i;

/**
 * A technical role. Checked against the category when the feed supplies one
 * (Simplify does) and the title otherwise (speedyapply does not).
 *
 * `Hardware` and `Product Management` are real Simplify categories and are
 * excluded deliberately — an ASIC or PM role is not what this resume is for.
 */
export function isSoftwareRole(listing: FeedListing): boolean {
  if (listing.category) {
    if (/^hardware$/i.test(listing.category)) return false;
    if (/product management|^product$/i.test(listing.category)) return false;
    if (SOFTWARE_CATEGORY.test(listing.category)) return true;
  }
  return SOFTWARE_TITLE.test(listing.title);
}

/**
 * Titles that are unambiguously above entry level. This is only the cheap
 * pre-filter — the real gate reads the posting body — but rejecting here
 * saves fetching a description for a job titled "Staff Engineer".
 *
 * Roman numerals are handled as whole words so "Engineer II" is caught while
 * "Engineer I" (a genuine entry-level marker) is not, and so a company with
 * "III" nowhere near a level is not accidentally matched.
 */
const SENIOR_TITLE =
  /\b(senior|sr\.?|staff|principal|lead|manager|director|head of|vp|architect|II|III|IV|distinguished|fellow)\b/i;

export function looksEntryLevelTitle(title: string): boolean {
  return !SENIOR_TITLE.test(title);
}

/**
 * Internships, co-ops and work terms. A HARD REJECT, not entry-level
 * evidence: the owner graduates Dec 2026 and wants permanent new-grad roles
 * only. This distinction is easy to get backwards, because every generic
 * "entry level" word list groups interns with new grads — the first version
 * of this file did, and surfaced a "AI Automation Co-op (Fall 2026)".
 *
 * "New grad" and "co-op" are different products, not different wordings of
 * the same one.
 */
const INTERNSHIP_TITLE =
  /\b(intern|interns|internship|co-?op|coop|work term|summer analyst|summer associate|placement student|student position|industrial placement)\b/i;

export function isInternship(title: string): boolean {
  return INTERNSHIP_TITLE.test(title);
}

/**
 * Positive new-grad markers. Used to rank, not to exclude — plenty of genuine
 * new-grad roles are titled plainly ("Software Engineer"). Deliberately does
 * NOT include intern/co-op; see {@link isInternship}.
 */
const ENTRY_TITLE =
  /\b(new grad|new graduate|recent graduate|graduate program|junior|jr\.?|associate|entry[- ]level|university grad|campus hire|early career|apprentice)\b|\b(engineer|developer|analyst)\s+(i|1)\b/i;

export function hasEntryLevelMarker(title: string): boolean {
  return ENTRY_TITLE.test(title);
}

/** Posted within `hours`. Listings with no date (markdown feeds) are never "fresh" on their own — see sources.ts. */
export function isFresh(listing: FeedListing, hours: number, now: Date = new Date()): boolean {
  if (!listing.postedAt) return false;
  const age = now.getTime() - listing.postedAt.getTime();
  return age >= 0 && age <= hours * 3600 * 1000;
}

export interface ShortlistOptions {
  /** How far back a dated listing may have been posted. */
  freshnessHours: number;
  /** Keys already sent, from `job_pings`. */
  alreadySent: Set<string>;
  /** Keys seen in the previous run's snapshot; a listing absent from it is new even without a date. */
  previouslySeen?: Set<string>;
  now?: Date;
}

/**
 * The full cheap pass. Returns the listings worth spending a description
 * fetch and an LLM call on, newest first.
 */
export function shortlist(listings: FeedListing[], opts: ShortlistOptions): FeedListing[] {
  const now = opts.now ?? new Date();
  const out: FeedListing[] = [];

  for (const listing of listings) {
    if (opts.alreadySent.has(listing.externalKey)) continue;
    if (!isSoftwareRole(listing)) continue;
    // Permanent new-grad roles only — an internship or co-op is never wanted,
    // however good the fit would otherwise be.
    if (isInternship(listing.title)) continue;
    if (!looksEntryLevelTitle(listing.title)) continue;
    if (!isCanadian(listing.locations) && !isAmbiguousRemote(listing.locations)) continue;

    // Dated listings must be recent. Undated ones (markdown feeds) qualify
    // only by being absent from the last snapshot — that absence is the only
    // evidence of newness such a feed offers.
    const fresh = isFresh(listing, opts.freshnessHours, now);
    const newlyAppeared = listing.postedAt === null && opts.previouslySeen
      ? !opts.previouslySeen.has(listing.externalKey)
      : false;
    if (!fresh && !newlyAppeared) continue;

    out.push(listing);
  }

  return out.sort((a, b) => (b.postedAt?.getTime() ?? 0) - (a.postedAt?.getTime() ?? 0));
}
