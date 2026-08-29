/**
 * Tracking an application made OUTSIDE the app — the shared logic behind
 * `POST /api/applications/manual` (`app/api/applications/manual/route.ts`),
 * `POST /api/applications/manual/fetch` (`app/api/applications/manual/fetch/route.ts`)
 * and `applyops outcome add` (`cli/commands/outcome.ts`).
 *
 * Two independent pieces live here:
 *
 * - `fetchPostingDetails(url)` — best-effort scrape of a job posting URL
 *   (ATS public JSON where the URL matches a known vendor pattern, else
 *   generic HTML/JSON-LD parsing). Never throws; returns `{ error }` for a
 *   URL it cannot make sense of. Used both to prefill the "Add application"
 *   dialog (the UI's "Fetch details" button calls the `/fetch` route
 *   directly) and internally by `createManualApplication` to get a real
 *   description for the `jobs` row it creates.
 * - `createManualApplication(db, userId, input)` — the write path: reuse an
 *   existing `jobs` row by normalized URL, or create one (+ its `companies`
 *   row) from the caller's fields with `fetchPostingDetails` filling in
 *   whatever the caller left blank; then create the `applications` row +
 *   founding `applied` outcome_event, idempotently on (user_id, job_id) —
 *   same unique index `recordApplication` (src/applications/record.ts)
 *   relies on, but this path never reactivates a withdrawn row (an existing
 *   application, in any status, is just returned with `existing: true`)
 *   since "I already have an application for this job" is unambiguous here
 *   in a way it isn't for the Tailor tab's re-apply flow.
 */

import { and, asc, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { applications, companies, jobs, outcomeEvents } from "../db/schema";
import { currentStage, type OutcomeEventType } from "./derive";
import { detectCountries } from "../finders/country";
import { classifyEntryLevel, isRelevantRole, detectWorkAuth } from "../finders/filters";
import { fetchJsonOrNull, joinLines, stripHtml, decodeEntities } from "../finders/http";
import { fetchAshbyJobs } from "../finders/ashby";

// ---------------------------------------------------------------------------
// URL normalisation
// ---------------------------------------------------------------------------

/**
 * Normalises a job-posting URL for dedup: strips `utm_*` query params (the
 * #1 reason the same posting looks like two different URLs — a link shared
 * on LinkedIn vs. one pasted straight from the ATS) and any fragment.
 * Everything else (path, remaining query params, trailing slash) is left
 * alone — those can be meaningful (e.g. a `gh_jid` query param on some
 * Greenhouse embeds).
 *
 * Throws if `raw` is not a parseable URL — callers validate with
 * `z.string().url()` first (`app/api/applications/manual/route.ts`) so this
 * never has to guess at a malformed value.
 */
export function normalizeJobUrl(raw: string): string {
  const url = new URL(raw.trim());
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_")) url.searchParams.delete(key);
  }
  url.hash = "";
  return url.toString();
}

// ---------------------------------------------------------------------------
// ATS URL pattern detection
// ---------------------------------------------------------------------------

export type AtsSlugMatch =
  | { vendor: "greenhouse"; slug: string; id: string }
  | { vendor: "lever"; slug: string; id: string }
  | { vendor: "ashby"; slug: string; id: string };

/**
 * Recognises a job-posting URL as one of the three ATS vendors this module
 * knows how to fetch exact structured data for:
 *
 * - Greenhouse: `boards.greenhouse.io/{slug}/jobs/{id}` and the newer
 *   `job-boards.greenhouse.io/{slug}/jobs/{id}` host.
 * - Lever: `jobs.lever.co/{slug}/{id}` (an optional trailing `/apply` is
 *   ignored — only the first two path segments matter).
 * - Ashby: `jobs.ashbyhq.com/{slug}/{id}`.
 *
 * Returns `null` for anything else (including a malformed URL) — callers
 * fall back to generic HTML/JSON-LD parsing.
 */
export function detectAtsSource(rawUrl: string): AtsSlugMatch | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);

  if (host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io") {
    const jobsIdx = parts.indexOf("jobs");
    if (jobsIdx > 0 && parts[jobsIdx - 1] && parts[jobsIdx + 1]) {
      return { vendor: "greenhouse", slug: parts[jobsIdx - 1], id: parts[jobsIdx + 1] };
    }
    return null;
  }
  if (host === "jobs.lever.co") {
    if (parts.length >= 2) return { vendor: "lever", slug: parts[0], id: parts[1] };
    return null;
  }
  if (host === "jobs.ashbyhq.com") {
    if (parts.length >= 2) return { vendor: "ashby", slug: parts[0], id: parts[1] };
    return null;
  }
  return null;
}

/** "acme-robotics" -> "Acme Robotics". Best-effort company display name for
 * vendors whose posting JSON carries no company field (Lever, Ashby). */
function humanizeSlug(slug: string): string {
  const words = slug
    .replace(/[-_]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return slug;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// ---------------------------------------------------------------------------
// Posting detail fetch
// ---------------------------------------------------------------------------

export interface PostingDetails {
  title: string | null;
  company: string | null;
  location: string | null;
  description: string | null;
  source: "greenhouse" | "lever" | "ashby" | "jsonld" | "html";
}

export type PostingDetailsResult = PostingDetails | { error: string };

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 6_000;

type GreenhouseJobDetail = {
  title?: string;
  location?: { name?: string } | null;
  content?: string;
  company_name?: string;
};

/** Greenhouse's public single-job endpoint — confirmed to exist alongside
 * the per-board listing endpoint `src/finders/greenhouse.ts` uses. */
async function fetchGreenhouseDetails(slug: string, id: string): Promise<PostingDetails | null> {
  const data = await fetchJsonOrNull<GreenhouseJobDetail>(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(id)}?content=true`,
  );
  if (!data?.title) return null;
  return {
    title: data.title.trim(),
    company: data.company_name?.trim() || humanizeSlug(slug),
    location: data.location?.name?.trim() || null,
    description: stripHtml(data.content) || null,
    source: "greenhouse",
  };
}

type LeverPostingDetail = {
  text?: string;
  categories?: { location?: string };
  descriptionPlain?: string;
  description?: string;
  lists?: Array<{ text?: string; content?: string }>;
  additionalPlain?: string;
  additional?: string;
};

/** Lever's public single-posting endpoint (`/v0/postings/{slug}/{id}`) — an
 * object, not the array the board-listing endpoint returns. Lever's JSON
 * carries no company name field, so `company` falls back to the slug. */
async function fetchLeverDetails(slug: string, id: string): Promise<PostingDetails | null> {
  const data = await fetchJsonOrNull<LeverPostingDetail>(
    `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}/${encodeURIComponent(id)}?mode=json`,
  );
  if (!data?.text) return null;
  const lists = (data.lists ?? [])
    .map((l) => joinLines(l.text ? `${stripHtml(l.text)}:` : null, stripHtml(l.content)))
    .filter(Boolean)
    .join("\n\n");
  const description = joinLines(
    data.descriptionPlain?.trim() || stripHtml(data.description),
    lists,
    data.additionalPlain?.trim() || stripHtml(data.additional),
  );
  return {
    title: data.text.trim(),
    company: humanizeSlug(slug),
    location: data.categories?.location?.trim() || null,
    description: description || null,
    source: "lever",
  };
}

/** Ashby has no public single-job endpoint (confirmed: returns 401), so
 * this fetches the whole board via the existing adapter and finds the id —
 * exactly the "else fetch the board and find the id" fallback. */
async function fetchAshbyDetails(slug: string, id: string): Promise<PostingDetails | null> {
  const jobsList = await fetchAshbyJobs(slug);
  const match = jobsList.find((j) => j.externalId === id || j.url.includes(id));
  if (!match) return null;
  return {
    title: match.title,
    company: humanizeSlug(slug),
    location: match.location,
    description: match.description || null,
    source: "ashby",
  };
}

// ---- generic HTML / JSON-LD fallback ---------------------------------------

/** Finds the first `JobPosting` object in a parsed JSON-LD value — handles
 * a bare object, an array of objects (some sites emit several `<script>`
 * blocks or a top-level array), and a `@graph` wrapper. */
function findJobPosting(data: unknown): Record<string, unknown> | null {
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findJobPosting(item);
      if (found) return found;
    }
    return null;
  }
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const type = obj["@type"];
    if (type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"))) {
      return obj;
    }
    if (obj["@graph"]) return findJobPosting(obj["@graph"]);
  }
  return null;
}

function extractJsonLdLocation(jobLocation: unknown): string | null {
  const loc = Array.isArray(jobLocation) ? jobLocation[0] : jobLocation;
  if (!loc) return null;
  if (typeof loc === "string") return loc.trim() || null;
  if (typeof loc !== "object") return null;
  const address = (loc as Record<string, unknown>).address;
  if (address && typeof address === "object") {
    const a = address as Record<string, unknown>;
    const parts = [a.addressLocality, a.addressRegion, a.addressCountry].filter(
      (p): p is string => typeof p === "string" && p.trim().length > 0,
    );
    if (parts.length > 0) return parts.join(", ");
  }
  const name = (loc as Record<string, unknown>).name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

/**
 * Extracts a `JobPosting` from a page's `application/ld+json` script tags,
 * if any. Exported so its extraction logic can be unit-tested against
 * fixture HTML strings without a network fetch.
 */
export function extractJsonLdJobPosting(html: string): Omit<PostingDetails, "source"> | null {
  const scripts = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const m of scripts) {
    let data: unknown;
    try {
      data = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    const posting = findJobPosting(data);
    if (!posting) continue;

    const title = typeof posting.title === "string" ? posting.title.trim() : null;
    const org = posting.hiringOrganization;
    const company =
      org && typeof org === "object" && typeof (org as Record<string, unknown>).name === "string"
        ? ((org as Record<string, unknown>).name as string).trim()
        : typeof org === "string"
          ? org.trim()
          : null;
    const location = extractJsonLdLocation(posting.jobLocation);
    const description = typeof posting.description === "string" ? stripHtml(posting.description) : null;

    return {
      title: title || null,
      company: company || null,
      location,
      description: description || null,
    };
  }
  return null;
}

function matchMeta(html: string, name: string): string | null {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`, "i"),
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m) return m[1];
  }
  return null;
}

function matchTitleTag(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? stripHtml(m[1]) : null;
}

/**
 * Generic `<title>` / `og:*` / meta-description extraction for a page with
 * no JSON-LD `JobPosting`. Exported for fixture-string unit tests.
 */
export function extractHtmlMeta(html: string): Omit<PostingDetails, "source"> {
  const title = matchMeta(html, "og:title") ?? matchTitleTag(html);
  const company = matchMeta(html, "og:site_name");
  const description = matchMeta(html, "og:description") ?? matchMeta(html, "description");
  return {
    title: title ? decodeEntities(title).trim() || null : null,
    company: company ? decodeEntities(company).trim() || null : null,
    location: null,
    description: description ? decodeEntities(description).trim() || null : null,
  };
}

async function fetchHtmlDetails(url: string): Promise<PostingDetailsResult> {
  let html: string;
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": BROWSER_UA,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "follow",
    });
    if (!res.ok) return { error: `Fetch failed (HTTP ${res.status}).` };
    html = await res.text();
  } catch {
    return { error: "Couldn't fetch that URL." };
  }

  const jsonLd = extractJsonLdJobPosting(html);
  if (jsonLd) return { ...jsonLd, source: "jsonld" };
  return { ...extractHtmlMeta(html), source: "html" };
}

/**
 * Best-effort fetch of a job posting's title/company/location/description.
 * Tries the matching ATS vendor's public JSON first (exact data, no
 * scraping); falls back to JSON-LD `JobPosting` in the page HTML, then to
 * plain `<title>`/`og:*`/meta-description tags. Never throws — a bad URL,
 * a dead link, or an unparseable page all come back as `{ error }` (still
 * HTTP 200 from the route that wraps this) rather than an exception, since
 * the caller (the UI's "Fetch details" button, or `createManualApplication`
 * filling in a blank field) always has a graceful degraded path: leave the
 * field blank / empty.
 */
export async function fetchPostingDetails(url: string): Promise<PostingDetailsResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: "Not a valid URL." };
  }

  const ats = detectAtsSource(url);
  try {
    if (ats?.vendor === "greenhouse") {
      const details = await fetchGreenhouseDetails(ats.slug, ats.id);
      if (details) return details;
    } else if (ats?.vendor === "lever") {
      const details = await fetchLeverDetails(ats.slug, ats.id);
      if (details) return details;
    } else if (ats?.vendor === "ashby") {
      const details = await fetchAshbyDetails(ats.slug, ats.id);
      if (details) return details;
    }
  } catch {
    // Fall through to a generic HTML fetch below — an ATS-shaped URL whose
    // vendor call failed (dead board, renamed slug) is still worth trying
    // as a plain web page.
  }

  return fetchHtmlDetails(parsed.toString());
}

// ---------------------------------------------------------------------------
// createManualApplication
// ---------------------------------------------------------------------------

export type ManualApplicationStatus = "applied" | "responded" | "interviewing" | "offer" | "rejected";

/** Which extra `outcome_events` row (beyond the founding `applied` one) a
 * non-default `status` implies, so `applications.status` still lands on
 * exactly what the caller asked for after `currentStage` recomputes it. */
const STATUS_EVENT: Record<Exclude<ManualApplicationStatus, "applied">, OutcomeEventType> = {
  responded: "response",
  interviewing: "interview",
  offer: "offer",
  rejected: "rejected",
};

export interface CreateManualApplicationInput {
  url: string;
  company?: string | null;
  title?: string | null;
  location?: string | null;
  /** Defaults to now. */
  appliedAt?: Date;
  notes?: string | null;
  /** Defaults to `"applied"`. */
  status?: ManualApplicationStatus;
}

export interface CreateManualApplicationResult {
  id: string;
  /** True when an application for this (user, job) already existed — the
   * call was a no-op returning that row rather than creating a new one. */
  existing: boolean;
}

/** Test-only seam: lets `tests/funnel/manual-application.test.ts` supply a
 * network-free `fetchPostingDetails` stand-in instead of hitting the real
 * ATS/HTML fetch. Production call sites never pass this. */
export interface ManualApplicationDeps {
  fetchPostingDetails?: (url: string) => Promise<PostingDetailsResult>;
}

/** Upsert a company by name, case-insensitively — same
 * `on conflict (lower(name))` raw-SQL pattern as `upsertCompanyByName` in
 * `src/db/seed-v1.ts` (drizzle's typed `onConflictDoUpdate` only accepts
 * column targets, not the expression index `companies_name_lower_uq` is
 * built on). `ats_vendor` is `'other'` and `source` is `'manual'` — this
 * company was typed in by the user, not discovered by a finder. */
async function upsertCompanyByName(db: Db, name: string): Promise<string> {
  const key = name.trim();
  const rows = (await db.execute(sql`
    insert into companies (name, ats_vendor, source, active)
    values (${key}, 'other', 'manual', true)
    on conflict (lower(name)) do update set name = excluded.name
    returning id
  `)) as unknown as Array<{ id: string }>;
  return rows[0].id;
}

/**
 * Records an application the user made outside the app: reuses a `jobs`
 * row for the (normalized) URL if one already exists, otherwise creates a
 * `companies` + `jobs` row for it (source `'manual'`), then creates the
 * `applications` row + founding `applied` outcome_event — idempotently on
 * `applications_user_job_uq` (drizzle/0015): a second call for a URL the
 * user already logged returns the existing row with `existing: true`
 * rather than erroring or duplicating it.
 *
 * A non-default `status` (the dialog lets the user say "I already heard
 * back") logs one additional outcome event of the matching type
 * ({@link STATUS_EVENT}) at the same `appliedAt` timestamp, then recomputes
 * `applications.status` from the full event history via `currentStage` —
 * the same derivation `logOutcome` (src/funnel/outcomes.ts) uses, so this
 * path never hand-sets a status inconsistent with its own event log.
 */
export async function createManualApplication(
  db: Db,
  userId: string,
  input: CreateManualApplicationInput,
  deps: ManualApplicationDeps = {},
): Promise<CreateManualApplicationResult> {
  const fetchDetails = deps.fetchPostingDetails ?? fetchPostingDetails;
  const normalizedUrl = normalizeJobUrl(input.url);
  const appliedAt = input.appliedAt ?? new Date();
  const status = input.status ?? "applied";

  const [existingJob] = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.url, normalizedUrl)).limit(1);

  let jobId: string;
  if (existingJob) {
    jobId = existingJob.id;
  } else {
    const fetched = await fetchDetails(normalizedUrl).catch(
      (): PostingDetailsResult => ({ error: "Couldn't fetch that URL." }),
    );
    const details = fetched && !("error" in fetched) ? fetched : null;

    const title = input.title?.trim() || details?.title || "Untitled position";
    const companyName = input.company?.trim() || details?.company || "Unknown company";
    const location = input.location?.trim() || details?.location || null;
    const description = details?.description || "";

    const companyId = await upsertCompanyByName(db, companyName);

    const [inserted] = await db
      .insert(jobs)
      .values({
        companyId,
        url: normalizedUrl,
        title,
        location,
        description,
        source: "manual",
        active: true,
        countries: detectCountries(location),
        isEntryLevel: classifyEntryLevel(title, description),
        isRelevantRole: isRelevantRole(title),
        workAuthSignal: detectWorkAuth(`${location ?? ""} ${description}`),
      })
      .onConflictDoNothing({ target: jobs.url })
      .returning({ id: jobs.id });

    if (inserted) {
      jobId = inserted.id;
    } else {
      // Race: another request created the same URL between our select and
      // insert (e.g. two tabs submitting the same posting at once).
      const [race] = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.url, normalizedUrl)).limit(1);
      jobId = race!.id;
    }
  }

  return db.transaction(async (tx) => {
    const [insertedApp] = await tx
      .insert(applications)
      .values({ userId, jobId, status: "applied" })
      .onConflictDoNothing({ target: [applications.userId, applications.jobId] })
      .returning({ id: applications.id });

    if (!insertedApp) {
      const [existing] = await tx
        .select({ id: applications.id })
        .from(applications)
        .where(and(eq(applications.userId, userId), eq(applications.jobId, jobId)))
        .limit(1);
      return { id: existing!.id, existing: true as const };
    }

    await tx.insert(outcomeEvents).values({
      applicationId: insertedApp.id,
      type: "applied",
      occurredAt: appliedAt,
      notes: input.notes ?? null,
    });

    if (status !== "applied") {
      await tx.insert(outcomeEvents).values({
        applicationId: insertedApp.id,
        type: STATUS_EVENT[status],
        occurredAt: appliedAt,
      });

      const allEvents = await tx
        .select({ type: outcomeEvents.type, occurredAt: outcomeEvents.occurredAt })
        .from(outcomeEvents)
        .where(eq(outcomeEvents.applicationId, insertedApp.id))
        .orderBy(asc(outcomeEvents.occurredAt));

      await tx
        .update(applications)
        .set({ status: currentStage(allEvents) })
        .where(eq(applications.id, insertedApp.id));
    }

    return { id: insertedApp.id, existing: false as const };
  });
}
