/**
 * "Is this worth applying to?" — a deterministic verdict from signals we
 * already store, so it costs nothing and can be shown on every row.
 *
 *   skip  → at least one hard blocker (wrong country, needs US auth the user
 *           lacks, senior/years requirement, stale/inactive, already applied,
 *           very low fit)
 *   maybe → no blocker but a real caveat (not yet scored, middling fit, aging
 *           posting, onsite outside the user's cities, unknown work-auth on a
 *           US role for a Canadian)
 *   apply → fresh, in-country, entry-level, scored well, no caveats
 *
 * Reasons are short, user-facing, hard blockers first, never duplicated.
 */
import { COUNTRY_OPTIONS, countriesAllow, type CountryCode } from "../finders/country";

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
  }

  const userLacksUsAuth = prefs?.workAuth === "canada" || prefs?.workAuth === "needs_sponsorship" || prefs?.workAuth === null || prefs?.workAuth === undefined;
  if (job.workAuthSignal === "needs_us_auth" && userLacksUsAuth) {
    push(hard, "Requires existing US work authorization (no sponsorship)");
  }

  if (job.isEntryLevel === false) push(hard, "Not an entry-level posting");
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
