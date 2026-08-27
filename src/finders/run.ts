/**
 * The nightly scrape (spec §6, §13): walk every active company, ask its ATS
 * for the current postings, and reconcile them into `jobs`.
 *
 * Three properties matter more than throughput here:
 *
 * - **One dead board never kills a run.** Every company is wrapped in its own
 *   try/catch and counted; the run always returns a summary (spec §12).
 * - **Politeness is per vendor.** Requests to one vendor are strictly
 *   sequential with a ≥100 ms gap; different vendors run concurrently, since
 *   the delay exists to be kind to each API, not to make the run slow.
 * - **Nothing is deleted.** A posting that disappears from a board is flipped
 *   to `active = false` after 30 days unseen. Applications reference jobs, and
 *   the funnel still has to explain an application to a job that was pulled.
 *
 * The filters are *recorded*, not applied: `is_entry_level`,
 * `is_relevant_role` and `work_auth_signal` are stored on the row so ranking
 * (Task 8) can weigh them and a bad heuristic costs signal instead of silently
 * losing jobs.
 */
import { and, asc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { companies, jobs } from "../db/schema";
import { detectCountries } from "./country";
import { detectWorkAuth, isEntryLevel, isRelevantRole } from "./filters";
import { ashbyFinder } from "./ashby";
import { greenhouseFinder } from "./greenhouse";
import { sleep } from "./http";
import { leverFinder } from "./lever";
import { personioFinder } from "./personio";
import { recruiteeFinder } from "./recruitee";
import { smartrecruitersFinder } from "./smartrecruiters";
import { VendorRequiresKeyError, type AtsVendor, type Finder, type RawJob } from "./types";
import { ycFinder } from "./yc";

/**
 * Every vendor with a working public endpoint. `other` (v1's Workday tenants,
 * kept as data — spec §6) and companies with no slug are simply never asked.
 */
export const FINDERS: Partial<Record<AtsVendor, Finder>> = {
  ashby: ashbyFinder,
  greenhouse: greenhouseFinder,
  lever: leverFinder,
  personio: personioFinder,
  recruitee: recruiteeFinder,
  smartrecruiters: smartrecruitersFinder,
  yc: ycFinder,
};

export const FINDER_VENDORS = Object.keys(FINDERS).sort() as AtsVendor[];

/** ≥100 ms between requests to the same vendor (spec §6). */
export const DEFAULT_VENDOR_DELAY_MS = 120;
/** Postings unseen this long are marked inactive. */
export const DEFAULT_STALE_DAYS = 30;
/** Rows per INSERT … ON CONFLICT statement. */
const UPSERT_CHUNK = 200;
/**
 * Hard cap on a stored description. The scraped corpus has a median of ~5.4k
 * characters and a 99th percentile of ~11k, so this truncates almost nothing
 * while bounding what a single pathological posting can cost the `analyze`
 * step in tokens.
 */
export const MAX_DESCRIPTION_CHARS = 30_000;

export type RunFindersOptions = {
  vendors?: AtsVendor[];
  maxCompanies?: number;
  /** Milliseconds between requests to the same vendor. */
  delayMs?: number;
  /** Days unseen before a job is deactivated; null skips the sweep. */
  staleDays?: number | null;
  /** Progress line sink — the CLI passes `console.log`. */
  onProgress?: (line: string) => void;
};

export type VendorStats = {
  companies: number;
  fetched: number;
  inserted: number;
  updated: number;
  errors: number;
  skipped: boolean;
};

export type FinderRunSummary = {
  fetched: number;
  inserted: number;
  updated: number;
  errors: number;
  deactivated: number;
  companiesScanned: number;
  byVendor: Record<string, VendorStats>;
};

type CompanyRow = { id: string; name: string; atsVendor: AtsVendor; atsSlug: string };

/** Validates a comma-separated `--vendors` value against the finder registry. */
export function parseVendors(value: string | undefined): AtsVendor[] | undefined {
  if (!value) return undefined;
  const asked = value
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  const bad = asked.filter((v) => !FINDER_VENDORS.includes(v as AtsVendor));
  if (bad.length) {
    throw new Error(
      `Unknown vendor(s): ${bad.join(", ")}. Known: ${FINDER_VENDORS.join(", ")}`,
    );
  }
  return [...new Set(asked)] as AtsVendor[];
}

function emptyStats(): VendorStats {
  return { companies: 0, fetched: 0, inserted: 0, updated: 0, errors: 0, skipped: false };
}

export async function runFinders(
  db: Db,
  opts: RunFindersOptions = {},
): Promise<FinderRunSummary> {
  const log = opts.onProgress ?? (() => {});
  const vendors = (opts.vendors ?? FINDER_VENDORS).filter((v) => FINDERS[v]);
  const delayMs = opts.delayMs ?? DEFAULT_VENDOR_DELAY_MS;

  const summary: FinderRunSummary = {
    fetched: 0,
    inserted: 0,
    updated: 0,
    errors: 0,
    deactivated: 0,
    companiesScanned: 0,
    byVendor: {},
  };
  for (const vendor of vendors) summary.byVendor[vendor] = emptyStats();
  if (vendors.length === 0) return summary;

  const rows = await selectCompanies(db, vendors, opts.maxCompanies);
  if (rows.length === 0) {
    log("no active companies with an ATS slug for the requested vendors");
    return summary;
  }
  summary.companiesScanned = rows.length;

  const byVendor = new Map<AtsVendor, CompanyRow[]>();
  for (const row of rows) {
    const list = byVendor.get(row.atsVendor) ?? [];
    list.push(row);
    byVendor.set(row.atsVendor, list);
  }
  for (const [vendor, list] of byVendor) summary.byVendor[vendor].companies = list.length;

  // One sequential worker per vendor; workers run concurrently with each other.
  await Promise.all(
    [...byVendor.entries()].map(([vendor, list]) =>
      scrapeVendor(db, vendor, list, { delayMs, log, stats: summary.byVendor[vendor] }),
    ),
  );

  for (const stats of Object.values(summary.byVendor)) {
    summary.fetched += stats.fetched;
    summary.inserted += stats.inserted;
    summary.updated += stats.updated;
    summary.errors += stats.errors;
  }

  const staleDays = opts.staleDays === undefined ? DEFAULT_STALE_DAYS : opts.staleDays;
  if (staleDays != null) {
    summary.deactivated = await deactivateStaleJobs(db, staleDays);
  }
  return summary;
}

async function selectCompanies(
  db: Db,
  vendors: AtsVendor[],
  maxCompanies?: number,
): Promise<CompanyRow[]> {
  const rows = await db
    .select({
      id: companies.id,
      name: companies.name,
      atsVendor: companies.atsVendor,
      atsSlug: companies.atsSlug,
    })
    .from(companies)
    .where(
      and(
        eq(companies.active, true),
        isNotNull(companies.atsSlug),
        inArray(companies.atsVendor, vendors),
      ),
    )
    // Deterministic order so `--max-companies` picks the same companies every
    // run (which is what makes a capped run a usable smoke test) rather than
    // whatever Postgres felt like returning.
    .orderBy(asc(companies.atsVendor), asc(companies.name));

  const present = rows.filter((r): r is CompanyRow => Boolean(r.atsSlug));
  return spreadAcrossVendors(present, maxCompanies);
}

/**
 * Applies `--max-companies` round-robin across the vendors present instead of
 * as a plain `LIMIT`.
 *
 * `--vendors greenhouse,lever,ashby --max-companies 60` is a question about
 * three vendors; an alphabetical prefix would have answered it entirely from
 * Ashby and told the operator nothing about the other two. Vendors keep their
 * incoming order and each keeps its own rows in order, so the selection is
 * still deterministic.
 */
export function spreadAcrossVendors<T extends { atsVendor: AtsVendor }>(
  rows: T[],
  maxCompanies?: number,
): T[] {
  if (!maxCompanies || maxCompanies <= 0 || rows.length <= maxCompanies) return rows;

  const queues = new Map<AtsVendor, T[]>();
  for (const row of rows) {
    const queue = queues.get(row.atsVendor) ?? [];
    queue.push(row);
    queues.set(row.atsVendor, queue);
  }

  const picked: T[] = [];
  const order = [...queues.keys()];
  while (picked.length < maxCompanies) {
    let took = false;
    for (const vendor of order) {
      const next = queues.get(vendor)!.shift();
      if (!next) continue;
      picked.push(next);
      took = true;
      if (picked.length >= maxCompanies) break;
    }
    if (!took) break;
  }
  return picked;
}

async function scrapeVendor(
  db: Db,
  vendor: AtsVendor,
  list: CompanyRow[],
  ctx: { delayMs: number; log: (line: string) => void; stats: VendorStats },
): Promise<void> {
  const finder = FINDERS[vendor];
  if (!finder) return;

  for (const [index, company] of list.entries()) {
    if (index > 0) await sleep(ctx.delayMs);
    try {
      const raw = await finder.fetchJobs(company.atsSlug);
      ctx.stats.fetched += raw.length;
      if (raw.length === 0) continue;
      const { inserted, updated } = await upsertJobs(db, company.id, raw);
      ctx.stats.inserted += inserted;
      ctx.stats.updated += updated;
    } catch (err) {
      if (err instanceof VendorRequiresKeyError) {
        // Vendor-level configuration problem, not a dead board: log once and
        // stop asking this vendor for the rest of the run.
        ctx.stats.skipped = true;
        ctx.log(`[${vendor}] requires_key — ${err.message}`);
        return;
      }
      ctx.stats.errors++;
      ctx.log(
        `[${vendor}] ${company.name} (${company.atsSlug}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  ctx.log(
    `[${vendor}] ${list.length} companies · ${ctx.stats.fetched} postings · ` +
      `${ctx.stats.inserted} new · ${ctx.stats.updated} updated · ${ctx.stats.errors} errors`,
  );
}

/**
 * Upserts a company's postings keyed on `jobs.url` (the unique index from
 * spec §4).
 *
 * `xmax = 0` is Postgres' way of telling insert from update inside an
 * `ON CONFLICT DO UPDATE`: the tuple has no updating transaction only when it
 * was freshly inserted. Without it the run could not report new-vs-seen, which
 * is the number that says whether the scrape is finding anything.
 *
 * Rows are deduplicated by URL first: two postings sharing a URL in one
 * statement would make Postgres raise "cannot affect row a second time".
 */
async function upsertJobs(
  db: Db,
  companyId: string,
  raw: RawJob[],
): Promise<{ inserted: number; updated: number }> {
  const now = new Date();
  const byUrl = new Map<string, RawJob>();
  for (const job of raw) byUrl.set(job.url, job);

  const values = [...byUrl.values()].map((job) => {
    const description = sanitizeText(job.description ?? "", MAX_DESCRIPTION_CHARS);
    const location = job.location === null ? null : sanitizeText(job.location, 500);
    return {
      companyId,
      externalId: job.externalId,
      url: job.url,
      title: sanitizeText(job.title, 500),
      location,
      remote: job.remote,
      description,
      postedAt: job.postedAt,
      scrapedAt: now,
      lastSeenAt: now,
      active: true,
      isEntryLevel: isEntryLevel(job.title, description),
      isRelevantRole: isRelevantRole(job.title),
      workAuthSignal: detectWorkAuth(`${job.location ?? ""} ${description}`),
      countries: detectCountries(location, description),
    };
  });

  let inserted = 0;
  let updated = 0;
  for (let i = 0; i < values.length; i += UPSERT_CHUNK) {
    const chunk = values.slice(i, i + UPSERT_CHUNK);
    const result = await db
      .insert(jobs)
      .values(chunk)
      .onConflictDoUpdate({
        target: jobs.url,
        set: {
          companyId: sql`excluded.company_id`,
          externalId: sql`excluded.external_id`,
          title: sql`excluded.title`,
          location: sql`excluded.location`,
          remote: sql`excluded.remote`,
          description: sql`excluded.description`,
          postedAt: sql`excluded.posted_at`,
          lastSeenAt: sql`excluded.last_seen_at`,
          active: sql`true`,
          isEntryLevel: sql`excluded.is_entry_level`,
          isRelevantRole: sql`excluded.is_relevant_role`,
          workAuthSignal: sql`excluded.work_auth_signal`,
          countries: sql`excluded.countries`,
          // `scraped_at`, `analysis` and `analysis_generation_id` are
          // deliberately absent: first-seen time and a paid-for analysis must
          // survive a re-scrape.
        },
      })
      .returning({ isNew: sql<boolean>`(xmax = 0)` });

    for (const row of result) {
      if (row.isNew) inserted++;
      else updated++;
    }
  }
  return { inserted, updated };
}

/**
 * Makes board text safe to store: Postgres `text` rejects NUL bytes outright,
 * and one of them anywhere in a 200-row chunk would fail the whole statement.
 * Truncation also trims a trailing lone surrogate, which would otherwise be
 * an invalid UTF-8 sequence on the wire.
 */
function sanitizeText(value: string, maxChars: number): string {
  const clean = value.replace(/\u0000/g, "");
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars).replace(/[\uD800-\uDBFF]$/, "")}\n[truncated]`;
}

/** Flips jobs no board has listed for `staleDays` to `active = false`. */
export async function deactivateStaleJobs(db: Db, staleDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - staleDays * 86_400_000);
  const rows = await db
    .update(jobs)
    .set({ active: false })
    .where(and(eq(jobs.active, true), lt(jobs.lastSeenAt, cutoff)))
    .returning({ id: jobs.id });
  return rows.length;
}
