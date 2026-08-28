/**
 * Workday CXS boards —
 * `https://{tenant}.{host}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs`.
 *
 * The one vendor here with no single fixed host: Workday assigns each
 * customer to a pod (`wd1`, `wd3`, `wd5`, `wd8`, `wd10`, `wd12`, …), and the
 * pod is not derivable from the tenant name. `workday-tenants.ts` records the
 * host for every tenant this repo has already verified; anything else is
 * resolved once per process by probing the candidate hosts and caching
 * whichever one answers.
 *
 * The list endpoint (`POST …/jobs`) returns only `title`, `locationsText`,
 * `postedOn`, `externalPath` and — for the minority of postings that carry
 * one — `remoteType`; the actual posting body lives behind a second request
 * (`GET …/{externalPath}`). Fetching that for every posting on a board this
 * size (TC Energy: ~40 open reqs, PwC: thousands globally) would be both slow
 * and mostly wasted on non-technical roles, so — same trade-off as
 * `smartrecruiters.ts` — the detail request is made only for postings whose
 * title already passes `isRelevantRole`; everything else keeps a description
 * synthesised from the list fields (still enough for the filters and search
 * to work against, just not as rich).
 *
 * Workday never publishes an absolute date, only a relative one ("Posted
 * Today", "Posted 3 Days Ago", "Posted 30+ Days Ago") — `parseWorkdayPostedOn`
 * converts that to `now - age`.
 */
import { isRelevantRole } from "./filters";
import { HttpError, sleep, stripHtml } from "./http";
import type { Finder, RawJob } from "./types";
import { WORKDAY_HOST_BY_TENANT } from "./workday-tenants";

/** Workday pods to try, in the order `workday-tenants.ts`'s known hosts appear. */
export const WORKDAY_HOST_CANDIDATES = ["wd1", "wd3", "wd5", "wd8", "wd10", "wd12"] as const;

const USER_AGENT =
  "ApplyOps/0.1 (+https://github.com/VVarrior1/applyops) job-board reader";
const TIMEOUT_MS = 8_000;
/** Workday's own page size cap for this endpoint is well above 20; kept small
 * on purpose — this is a politeness limit, not a Workday limit. */
const PAGE_SIZE = 20;
/** Hard cap on postings scanned per tenant per run (spec). */
const MAX_POSTINGS = 300;
/** Hard cap on posting-detail fetches per tenant per run — bounds a single
 * huge global board (PwC, Manulife, …) to a sane number of extra requests. */
const MAX_DETAIL_FETCHES = 60;
/** ≥150 ms between *any* two requests to the same tenant/host (spec). */
const REQUEST_DELAY_MS = 150;

type WorkdayPosting = {
  title?: string;
  externalPath?: string;
  locationsText?: string;
  postedOn?: string;
  remoteType?: string;
};

type WorkdayJobsResponse = { total?: number; jobPostings?: WorkdayPosting[] };
type WorkdayDetailResponse = { jobPostingInfo?: { jobDescription?: string } };

// ---------------------------------------------------------------------------
// URL shape
// ---------------------------------------------------------------------------

/** The human-facing careers board — also what `companies.careers_url` stores. */
export function workdayBoardUrl(tenant: string, host: string, site: string): string {
  return `https://${tenant}.${host}.myworkdayjobs.com/${site}`;
}

function workdayJobsEndpoint(tenant: string, host: string, site: string): string {
  return `https://${tenant}.${host}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`;
}

function workdayDetailEndpoint(
  tenant: string,
  host: string,
  site: string,
  externalPath: string,
): string {
  return `https://${tenant}.${host}.myworkdayjobs.com/wday/cxs/${tenant}/${site}${externalPath}`;
}

/** `companies.ats_slug` is `"tenant/site"` — splits it, or throws on malformed input. */
export function splitWorkdaySlug(slug: string): { tenant: string; site: string } {
  const idx = slug.indexOf("/");
  if (idx <= 0 || idx === slug.length - 1) {
    throw new Error(`workday slug must be "tenant/site", got ${JSON.stringify(slug)}`);
  }
  return { tenant: slug.slice(0, idx).trim(), site: slug.slice(idx + 1).trim() };
}

/**
 * Recovers `{tenant, host, site}` from a Workday careers URL, e.g.
 * `https://suncor.wd1.myworkdayjobs.com/en-US/Suncor_External/job/...` or the
 * bare board URL `https://suncor.wd1.myworkdayjobs.com/Suncor_External`.
 * Returns null for anything that isn't a `*.wd\d+.myworkdayjobs.com` host.
 */
export function parseWorkdayUrl(
  input: string,
): { tenant: string; host: string; site: string } | null {
  let url: URL;
  try {
    url = new URL(input.trim().startsWith("http") ? input.trim() : `https://${input.trim()}`);
  } catch {
    return null;
  }
  const hostMatch = /^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/i.exec(url.hostname);
  if (!hostMatch) return null;

  const segments = url.pathname.split("/").filter(Boolean);
  // Drop a leading locale segment ("en-US", "fr-CA", …) — the site id is the
  // first segment that isn't one.
  const site = segments.find((s) => !/^[a-z]{2}-[a-z]{2}$/i.test(s));
  if (!site) return null;

  return { tenant: hostMatch[1].toLowerCase(), host: hostMatch[2].toLowerCase(), site };
}

// ---------------------------------------------------------------------------
// HTTP (Workday's search endpoint is POST-only, so this can't reuse
// fetchJsonOrNull from ./http, which is GET-only)
// ---------------------------------------------------------------------------

async function postJson<T>(url: string): Promise<T | null> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": USER_AGENT,
    },
    body: JSON.stringify({ appliedFacets: {}, limit: PAGE_SIZE, offset: 0, searchText: "" }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return parseJsonResponse<T>(res, url);
}

async function postJsonPage<T>(url: string, limit: number, offset: number): Promise<T | null> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": USER_AGENT,
    },
    body: JSON.stringify({ appliedFacets: {}, limit, offset, searchText: "" }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return parseJsonResponse<T>(res, url);
}

async function getJson<T>(url: string): Promise<T | null> {
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return parseJsonResponse<T>(res, url);
}

async function parseJsonResponse<T>(res: Response, url: string): Promise<T | null> {
  // Workday answers an unknown tenant/site with 404, and — seen against a few
  // stale tenants during discovery — sometimes 422 ("HTTP_422") instead of a
  // clean 404. Both mean "this board does not exist here", same as v1's
  // "no Workday site for …" skip.
  if (res.status === 404 || res.status === 410 || res.status === 422) return null;
  if (!res.ok) throw new HttpError(res.status, url);
  try {
    return (await res.json()) as T;
  } catch {
    throw new Error(`Malformed JSON from ${url}`);
  }
}

/** One posting-detail request, exported so the CLI's `workday probe` can reuse it. */
export async function probeWorkdayTenant(
  tenant: string,
  host: string,
  site: string,
): Promise<number | null> {
  const data = await postJson<WorkdayJobsResponse>(workdayJobsEndpoint(tenant, host, site));
  return data ? (data.total ?? data.jobPostings?.length ?? 0) : null;
}

// ---------------------------------------------------------------------------
// Host resolution
// ---------------------------------------------------------------------------

const hostCache = new Map<string, string>(Object.entries(WORKDAY_HOST_BY_TENANT));

async function resolveHost(tenant: string, site: string): Promise<string> {
  const cached = hostCache.get(tenant);
  if (cached) return cached;

  for (const host of WORKDAY_HOST_CANDIDATES) {
    try {
      const total = await probeWorkdayTenant(tenant, host, site);
      if (total !== null) {
        hostCache.set(tenant, host);
        return host;
      }
    } catch {
      // Try the next host — a timeout/5xx on one pod says nothing about the others.
    }
  }
  throw new Error(
    `workday: no host answered for tenant "${tenant}" site "${site}" ` +
      `(tried ${WORKDAY_HOST_CANDIDATES.join(", ")})`,
  );
}

// ---------------------------------------------------------------------------
// postedOn parsing
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/**
 * Workday only ever publishes a relative age — "Posted Today", "Posted
 * Yesterday", "Posted N Days Ago", "Posted 30+ Days Ago" — never an absolute
 * date. Converts that to `now - age`; anything unrecognised (missing, a
 * phrasing this hasn't seen) returns null rather than an Invalid Date, same
 * contract as `http.ts`'s `toDate`/`parseRelativeAge`.
 */
export function parseWorkdayPostedOn(
  value: string | null | undefined,
  now: Date = new Date(),
): Date | null {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  if (!text) return null;

  if (text === "posted today" || text === "today") return now;
  if (text === "posted yesterday" || text === "yesterday") {
    return new Date(now.getTime() - DAY_MS);
  }

  // "30+ days ago" before the plain "N days ago" pattern — the "+" would
  // otherwise just fail the plain pattern silently and fall through to null,
  // which is also correct, but matching it explicitly keeps the semantics
  // ("at least N days", not "unknown") visible in the code.
  const plus = /posted\s+(\d+)\+\s*days?\s+ago/.exec(text);
  if (plus) return new Date(now.getTime() - Number(plus[1]) * DAY_MS);

  const days = /posted\s+(\d+)\s*days?\s+ago/.exec(text);
  if (days) return new Date(now.getTime() - Number(days[1]) * DAY_MS);

  return null;
}

// ---------------------------------------------------------------------------
// Finder
// ---------------------------------------------------------------------------

function externalIdFromPath(externalPath: string): string {
  const segments = externalPath.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? externalPath;
}

export async function fetchWorkdayJobs(slug: string): Promise<RawJob[]> {
  const { tenant, site } = splitWorkdaySlug(slug);
  const host = await resolveHost(tenant, site);
  const boardUrl = workdayBoardUrl(tenant, host, site);
  const jobsUrl = workdayJobsEndpoint(tenant, host, site);

  // A single shared throttle for every request this call makes (list pages
  // *and* detail fetches) — Workday sees one steady ≥150ms-spaced stream per
  // tenant/host, not two independent ones.
  let requests = 0;
  const throttle = async () => {
    if (requests > 0) await sleep(REQUEST_DELAY_MS);
    requests++;
  };

  const postings: WorkdayPosting[] = [];
  let offset = 0;
  let total = Infinity;
  while (postings.length < MAX_POSTINGS && offset < total) {
    await throttle();
    const data = await postJsonPage<WorkdayJobsResponse>(jobsUrl, PAGE_SIZE, offset);
    const page = data?.jobPostings ?? [];
    if (page.length === 0) break;
    postings.push(...page);
    total = data?.total ?? postings.length;
    offset += page.length;
    if (page.length < PAGE_SIZE) break;
  }

  const jobs: RawJob[] = [];
  let detailFetches = 0;

  for (const posting of postings.slice(0, MAX_POSTINGS)) {
    const title = (posting.title ?? "").trim();
    const externalPath = posting.externalPath ?? "";
    if (!title || !externalPath) continue;

    const location = posting.locationsText?.trim() || null;
    const remote = /remote/i.test(`${location ?? ""} ${posting.remoteType ?? ""}`);

    let description = title;
    if (detailFetches < MAX_DETAIL_FETCHES && isRelevantRole(title)) {
      detailFetches++;
      await throttle();
      try {
        const detail = await getJson<WorkdayDetailResponse>(
          workdayDetailEndpoint(tenant, host, site, externalPath),
        );
        const html = detail?.jobPostingInfo?.jobDescription;
        if (html) description = stripHtml(html) || title;
      } catch {
        // A single bad detail fetch must not lose the posting.
      }
    }

    jobs.push({
      externalId: externalIdFromPath(externalPath),
      url: `${boardUrl}${externalPath}`,
      title,
      location,
      remote,
      description,
      postedAt: parseWorkdayPostedOn(posting.postedOn),
    });
  }
  return jobs;
}

export const workdayFinder: Finder = { vendor: "workday", fetchJobs: fetchWorkdayJobs };
