/**
 * "Is this worth applying to?" — a deterministic verdict from signals we
 * already store, so it costs nothing and can be shown on every row.
 *
 *   skip  → at least one hard blocker (wrong country, needs US auth the user
 *           lacks, senior/years requirement, stale/inactive, already applied,
 *           very low fit) — note `is_entry_level = NULL` is NOT one: unknown
 *           is not a blocker, it is a caveat
 *   maybe → no blocker but a real caveat (not yet scored, middling fit, aging
 *           posting, onsite outside the user's cities, unknown work-auth on a
 *           US role for a Canadian)
 *   apply → fresh, in-country, entry-level, scored well, no caveats
 *
 * Reasons are short, user-facing, hard blockers first, never duplicated.
 */
import { COUNTRY_OPTIONS, countriesAllow, hasUnrecognizedGeography, type CountryCode } from "../finders/country";

export type Verdict = "apply" | "maybe" | "skip";

export type VerdictInput = {
  job: {
    title: string;
    remote: boolean | null;
    countries: CountryCode[] | null;
    postedAt: Date | null;
    lastSeenAt: Date | null;
    active: boolean;
    isEntryLevel: boolean | null;
    isRelevantRole: boolean | null;
    workAuthSignal: "hires_canadians" | "tn_friendly" | "needs_us_auth" | "unclear" | null;
    location: string | null;
  };
  analysis?: { seniority?: string | null; years_min?: number | null; requirements?: unknown[] } | null;
  fitScore: number | null;
  prefs: {
    countries: CountryCode[] | null;
    workAuth: "canada" | "us_citizen_pr" | "needs_sponsorship" | "tn_eligible" | null;
    remote: "any" | "remote" | "hybrid" | "onsite" | null;
    locations: string[] | null;
  } | null;
  alreadyApplied: boolean;
  now?: Date;
};

export type VerdictResult = { verdict: Verdict; reasons: string[] };

export const FIT_SKIP_BELOW = 35;
export const FIT_APPLY_FROM = 55;
export const STALE_AFTER_DAYS = 45;
export const AGING_AFTER_DAYS = 21;

/**
 * The caveat shown for `is_entry_level = NULL` rows — also what
 * `/jobs`' `level=unknown` view labels them with, so the two never drift.
 */
export const ENTRY_LEVEL_UNKNOWN_REASON =
  "Description not fetched — check the experience requirement on the posting";

const SENIOR_TITLE = /\b(senior|sr\.?|staff|principal|lead|manager|director|head of|vp|chief|architect|distinguished)\b/i;

function countryName(code: CountryCode): string {
  return COUNTRY_OPTIONS.find((o) => o.code === code)?.name ?? code;
}

function daysBetween(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / 86_400_000);
}

export function assessJob(input: VerdictInput): VerdictResult {
  const { job, analysis, fitScore, prefs, alreadyApplied } = input;
  const now = input.now ?? new Date();
  const hard: string[] = [];
  const soft: string[] = [];
  const push = (list: string[], r: string) => { if (!list.includes(r)) list.push(r); };

  // --- hard blockers -------------------------------------------------------
  if (alreadyApplied) push(hard, "You already applied to this posting");
  if (!job.active) push(hard, "Posting is no longer listed");

  const wantedCountries = prefs?.countries ?? null;
  if (!countriesAllow(job.countries, wantedCountries)) {
    const names = (job.countries ?? []).map(countryName).join(", ");
    push(hard, `Restricted to ${names} — outside your countries`);
  } else if (wantedCountries && wantedCountries.length > 0 && hasUnrecognizedGeography(job.location, job.countries)) {
    push(hard, `Location "${job.location}" isn't in one of your countries`);
  }

  const userLacksUsAuth = prefs?.workAuth === "canada" || prefs?.workAuth === "needs_sponsorship" || prefs?.workAuth === null || prefs?.workAuth === undefined;
  if (job.workAuthSignal === "needs_us_auth" && userLacksUsAuth) {
    push(hard, "Requires existing US work authorization (no sponsorship)");
  }

  if (job.isEntryLevel === false) push(hard, "Not an entry-level posting");
  // NULL is "unknown", not "no": the board never gave us a posting body and
  // the title said nothing either (classifyEntryLevel, src/finders/filters.ts).
  // That is a caveat for the user to check, never a blocker — hiding these
  // would throw away real postings, and rounding them UP to entry-level is
  // what put "5+ years" reqs in front of a new grad in the first place.
  else if (job.isEntryLevel === null) {
    push(soft, ENTRY_LEVEL_UNKNOWN_REASON);
  }
  if (job.isRelevantRole === false) push(hard, "Not a software/engineering role");
  if (SENIOR_TITLE.test(job.title)) push(hard, "Senior-level title");
  const years = analysis?.years_min ?? null;
  if (years !== null && years >= 3) push(hard, `Wants ${years}+ years of experience`);
  const seniority = (analysis?.seniority ?? "").toLowerCase();
  if (["senior", "staff", "lead", "principal", "manager"].includes(seniority)) push(hard, `Seniority: ${seniority}`);

  if (job.postedAt) {
    const age = daysBetween(now, job.postedAt);
    if (age > STALE_AFTER_DAYS) push(hard, `Posted ${age} days ago — likely filled or evergreen`);
    else if (age > AGING_AFTER_DAYS) push(soft, `Posted ${age} days ago`);
  }

  if (fitScore !== null && fitScore < FIT_SKIP_BELOW) push(hard, `Low fit score (${fitScore}/100)`);

  if (hard.length > 0) return { verdict: "skip", reasons: [...hard, ...soft] };

  // --- soft caveats --------------------------------------------------------
  if (fitScore === null) push(soft, "Not scored yet — run Rank to get a fit score");
  else if (fitScore < FIT_APPLY_FROM) push(soft, `Middling fit (${fitScore}/100)`);

  if (job.remote === false) {
    const norm = (job.location ?? "").toLowerCase();
    const wanted = (prefs?.locations ?? []).map((l) => l.toLowerCase().trim()).filter((l) => l && l !== "remote");
    const matches = wanted.some((w) => norm.includes(w.split(",")[0]));
    if (!matches) push(soft, `Onsite in ${job.location ?? "an unlisted city"} — not one of your locations`);
  }

  if (job.workAuthSignal === "unclear" && userLacksUsAuth && (job.countries ?? []).includes("US") && !(job.countries ?? []).includes("CA")) {
    push(soft, "US role with no work-authorization statement — check before investing time");
  }

  return { verdict: soft.length > 0 ? "maybe" : "apply", reasons: soft };
}

export const VERDICT_LABEL: Record<Verdict, string> = { apply: "Worth applying", maybe: "Maybe", skip: "Skip" };

/** `fit.v1.md`'s own scoring cap — see {@link hardPreferenceConflict}. */
export const FIT_HARD_PREFERENCE_CAP = 40;

export type HardPreferenceConflictInput = {
  job: {
    remote: boolean | null;
    location: string | null;
    companyName: string | null;
  };
  prefs: {
    remote: "any" | "remote" | "hybrid" | "onsite" | null;
    locations: string[] | null;
    excludedCompanies: string[] | null;
  } | null;
};

/**
 * Deterministic re-check of fit.v1.md's own rule: "A role that contradicts a
 * hard preference (excluded company, unusable location, remote policy the
 * candidate ruled out) caps the score at 40." The prompt is asked to enforce
 * this itself, but a prompt is not a guarantee — the model can (and did) hand
 * back a high score next to a rationale describing exactly this kind of
 * conflict. `scoreFit()` (`src/rank/rank.ts`) calls this after the model
 * returns and clamps the *stored* score, rather than trusting the model's
 * arithmetic — the same "verify after the fact" shape as
 * `checkCitations()`/`stripUnsupportedBullets()` in
 * `src/pipeline/hallucination.ts`.
 *
 * Deliberately narrower than this file's own hard-blocker list above: those
 * (stale posting, already applied, seniority, country) are facts about the
 * *job*, not a preference the candidate stated. And "onsite outside your
 * cities" stays a soft, non-blocking *verdict* caveat below — a user's city
 * list is advisory (`isPreferredLocation()` in `src/finders/filters.ts`) —
 * but fit.v1.md counts "unusable location" as a hard preference for
 * *scoring* purposes even when it is not severe enough to hide the posting
 * from the list, so this checks it independently rather than reusing
 * `assessJob`'s soft/hard split. Returns `null` when the candidate never
 * named that preference at all (no `locations`, no `excludedCompanies`) —
 * absence of a preference is not a contradiction of one.
 *
 * The location branch only fires for a candidate who said `remote:
 * "onsite"` — i.e. stated they must physically be somewhere, so a city
 * list is no longer advisory but an actual constraint. `remote: "any"`
 * (the common case) rules nothing out, so a bare city list can't
 * contradict it: measured against the owner's real `search_prefs`
 * (`remote: "any"`) over the live job pool, treating the list as a hard
 * cap here clamped 4,773 of 6,000 active jobs to the same score and
 * flattened `/jobs`' "sorted by fit" into "sorted by posted date" for most
 * of the pool. Also requires `job.location` to be non-null — an unknown
 * location is not a contradicted preference.
 */
export function hardPreferenceConflict(input: HardPreferenceConflictInput): string | null {
  const { job, prefs } = input;
  if (!prefs) return null;

  if (job.companyName) {
    const excluded = (prefs.excludedCompanies ?? []).map((c) => c.toLowerCase().trim()).filter(Boolean);
    if (excluded.includes(job.companyName.toLowerCase().trim())) {
      return `${job.companyName} is on your excluded-companies list`;
    }
  }

  if (prefs.remote === "remote" && job.remote === false) {
    return "You're only interested in remote roles, and this one is onsite";
  }
  if (prefs.remote === "onsite" && job.remote === true) {
    return "You're only interested in onsite roles, and this one is remote-only";
  }

  if (job.remote === false && prefs.remote === "onsite" && job.location) {
    const wanted = (prefs.locations ?? [])
      .map((l) => l.toLowerCase().trim())
      .filter((l) => l && l !== "remote");
    if (wanted.length > 0) {
      const norm = job.location.toLowerCase();
      const matches = wanted.some((w) => norm.includes(w.split(",")[0]));
      if (!matches) {
        return `Onsite in ${job.location} — not one of your locations`;
      }
    }
  }

  return null;
}
