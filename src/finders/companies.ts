/**
 * Company discovery (spec §6): the `companies` rows the nightly scrape walks.
 *
 * Two sources, both idempotent:
 *
 * 1. **v1's hand-kept allow-lists** — 146 Greenhouse + 80 Lever slugs and 9
 *    Workday tenants, parsed straight out of `scripts/scrape-apis.ts` in the
 *    v1 repo rather than copy-pasted here, so the provenance stays visible and
 *    a re-run picks up anything added there.
 * 2. **OpenJobs** (github.com/outscal/OpenJobs, MIT) — ~12k companies with
 *    their careers URLs. The URLs are what matter: the vendor and board slug
 *    are recovered from the URL shape, and companies on an ATS this repo has
 *    no finder for are skipped rather than stored as junk.
 *
 * Merging rules live in `upsertCompanies`, and exist because `companies` has
 * *two* unique constraints — `(ats_vendor, ats_slug)` and `lower(name)` — and
 * the v1 seed already created 63 name-only rows with `ats_vendor = 'other'`.
 */
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { companies } from "../db/schema";
import { fetchJsonOrNull } from "./http";
import type { AtsVendor } from "./types";

/** Where the v1 repo lives; override with `V1_REPO_PATH` for a checkout elsewhere. */
export const DEFAULT_V1_REPO = "/Users/abdu/Job_Auto_Apply";
export const OPENJOBS_URL =
  "https://raw.githubusercontent.com/outscal/OpenJobs/main/data/companies_v2.json";

const INSERT_CHUNK = 500;

export type CompanyCandidate = {
  name: string;
  atsVendor: AtsVendor;
  atsSlug: string | null;
  careersUrl: string | null;
  source: "v1_allowlist" | "openjobs" | "manual" | "canada_curated";
};

export type ImportResult = {
  /** Rows created. */
  inserted: number;
  /** Existing name-only rows (from the v1 seed) given a vendor + slug. */
  linked: number;
  /** Candidates already present with this vendor + slug. */
  existing: number;
  /** Candidate URLs whose ATS this repo has no finder for. */
  unknownVendor: number;
};

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/** The human-facing careers page for a (vendor, slug) pair. */
export function careersUrlFor(vendor: AtsVendor, slug: string): string | null {
  switch (vendor) {
    case "greenhouse":
      return `https://job-boards.greenhouse.io/${slug}`;
    case "lever":
      return `https://jobs.lever.co/${slug}`;
    case "ashby":
      return `https://jobs.ashbyhq.com/${slug}`;
    case "recruitee":
      return `https://${slug}.recruitee.com`;
    case "personio":
      return `https://${slug}.jobs.personio.de`;
    case "smartrecruiters":
      return `https://jobs.smartrecruiters.com/${slug}`;
    case "yc":
      return `https://www.ycombinator.com/companies/${slug}/jobs`;
    default:
      return null;
  }
}

/** Path segments that are never a board slug. */
const NON_SLUGS = new Set([
  "",
  "embed",
  "jobs",
  "job",
  "careers",
  "career",
  "search",
  "companies",
  "o",
  "apply",
  "www",
  "boards",
]);

/**
 * Recovers `(vendor, slug)` from a careers URL.
 *
 * Returns null for anything this repo has no finder for — Workable, Jobvite,
 * LinkedIn, Workday, a company's own `/careers` page, and the ~1.8k rows in
 * the OpenJobs data whose `ats_links` entry is literal placeholder text.
 */
export function vendorFromAtsUrl(link: string): { vendor: AtsVendor; slug: string } | null {
  if (typeof link !== "string" || !link.trim()) return null;
  let url: URL;
  try {
    url = new URL(link.trim().startsWith("http") ? link.trim() : `https://${link.trim()}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  const first = segments[0] ?? "";

  const ok = (vendor: AtsVendor, slug: string) => {
    const trimmed = slug.trim().replace(/\/+$/, "");
    if (!trimmed || trimmed.length > 80 || NON_SLUGS.has(trimmed.toLowerCase())) return null;
    return { vendor, slug: trimmed };
  };

  if (host === "greenhouse.io" || host.endsWith(".greenhouse.io")) return ok("greenhouse", first);
  if (host === "lever.co" || host.endsWith(".lever.co")) return ok("lever", first);
  if (host === "ashbyhq.com" || host.endsWith(".ashbyhq.com")) return ok("ashby", first);
  if (host === "smartrecruiters.com" || host.endsWith(".smartrecruiters.com")) {
    return ok("smartrecruiters", first);
  }
  if (host.endsWith(".recruitee.com")) return ok("recruitee", host.split(".")[0]);
  if (/\.jobs\.personio\.(de|com)$/.test(host)) return ok("personio", host.split(".")[0]);
  if (
    (host === "ycombinator.com" || host === "workatastartup.com") &&
    segments[0] === "companies"
  ) {
    return ok("yc", segments[1] ?? "");
  }
  return null;
}

/** "weights-biases" → "Weights Biases"; used only where no real name exists. */
export function prettifySlug(slug: string): string {
  return slug
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Source 1 — v1 allow-lists
// ---------------------------------------------------------------------------

/** Pulls a `const NAME = [ … ]` array literal's string entries out of TS source. */
function extractStringArray(source: string, name: string): string[] {
  const start = source.indexOf(`const ${name} = [`);
  if (start < 0) return [];
  const from = source.indexOf("[", start);
  const to = source.indexOf("\n]", from);
  if (to < 0) return [];
  return [
    ...source
      .slice(from, to)
      // Drop `// …` comments before harvesting quoted strings, otherwise a
      // commented-out slug would be imported.
      .replace(/\/\/[^\n]*/g, "")
      .matchAll(/'([^']+)'|"([^"]+)"/g),
  ]
    .map((m) => (m[1] ?? m[2]).trim())
    .filter(Boolean);
}

/**
 * Parses v1's three allow-lists out of `scripts/scrape-apis.ts`.
 *
 * Workday tenants are kept (as `ats_vendor = 'other'`, slug `tenant/site`)
 * even though there is no Workday finder: the spec keeps them as data so the
 * finder can be added later without re-deriving the list.
 */
export function parseV1Allowlists(source: string): CompanyCandidate[] {
  const out: CompanyCandidate[] = [];

  for (const [name, vendor] of [
    ["GREENHOUSE_COMPANIES", "greenhouse"],
    ["LEVER_COMPANIES", "lever"],
  ] as const) {
    for (const slug of extractStringArray(source, name)) {
      out.push({
        name: prettifySlug(slug),
        atsVendor: vendor,
        atsSlug: slug,
        careersUrl: careersUrlFor(vendor, slug),
        source: "v1_allowlist",
      });
    }
  }

  const workday = source.slice(source.indexOf("const WORKDAY_CONFIG = ["));
  for (const m of workday
    .slice(0, workday.indexOf("\n]") + 2)
    .matchAll(
      /\{\s*tenant:\s*'([^']+)'\s*,\s*site:\s*'([^']+)'\s*,\s*label:\s*'([^']+)'\s*\}/g,
    )) {
    out.push({
      name: m[3],
      atsVendor: "other",
      atsSlug: `${m[1]}/${m[2]}`,
      careersUrl: `https://${m[1]}.wd3.myworkdayjobs.com/${m[2]}`,
      source: "v1_allowlist",
    });
  }

  return dedupeCandidates(out);
}

export async function importV1Allowlists(
  db: Db,
  opts: { repoPath?: string } = {},
): Promise<ImportResult> {
  const repo = opts.repoPath ?? process.env.V1_REPO_PATH ?? DEFAULT_V1_REPO;
  const file = `${repo}/scripts/scrape-apis.ts`;
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch {
    throw new Error(
      `Cannot read v1 allow-lists at ${file}. Point V1_REPO_PATH at a checkout of the v1 repo, or run \`companies import --source openjobs\`.`,
    );
  }
  const candidates = parseV1Allowlists(source);
  const result = await upsertCompanies(db, candidates);
  return { ...result, unknownVendor: 0 };
}

// ---------------------------------------------------------------------------
// Source 2 — OpenJobs
// ---------------------------------------------------------------------------

export type OpenJobsCompany = {
  name?: string;
  website?: string;
  type?: string | null;
  industry_category?: string | null;
  ats_links?: unknown;
};

/** OpenJobs' own taxonomy for "this is a software/tech company". */
function isTechCompany(company: OpenJobsCompany): boolean {
  const type = (company.type ?? "").toLowerCase();
  const industry = (company.industry_category ?? "").toLowerCase();
  return type === "tech" || type === "ai" || industry === "tech";
}

/**
 * Maps the OpenJobs dataset to candidates, keeping only companies on an ATS
 * this repo can actually read.
 */
export function parseOpenJobsCompanies(
  data: OpenJobsCompany[],
  opts: { techOnly: boolean },
): { candidates: CompanyCandidate[]; unknownVendor: number } {
  const out: CompanyCandidate[] = [];
  let unknownVendor = 0;

  for (const company of data) {
    if (opts.techOnly && !isTechCompany(company)) continue;
    const name = (company.name ?? "").replace(/\s+/g, " ").trim();
    const links = Array.isArray(company.ats_links) ? company.ats_links : [];
    for (const link of links) {
      if (typeof link !== "string") continue;
      const parsed = vendorFromAtsUrl(link);
      if (!parsed) {
        unknownVendor++;
        continue;
      }
      out.push({
        name: name || prettifySlug(parsed.slug),
        atsVendor: parsed.vendor,
        atsSlug: parsed.slug,
        careersUrl: careersUrlFor(parsed.vendor, parsed.slug),
        source: "openjobs",
      });
    }
  }
  return { candidates: dedupeCandidates(out), unknownVendor };
}

export async function importOpenJobs(
  db: Db,
  opts: { techOnly: boolean },
): Promise<ImportResult> {
  const data = await fetchJsonOrNull<OpenJobsCompany[]>(OPENJOBS_URL, { timeoutMs: 60_000 });
  if (!Array.isArray(data)) {
    throw new Error(`OpenJobs dataset unavailable at ${OPENJOBS_URL}`);
  }
  const { candidates, unknownVendor } = parseOpenJobsCompanies(data, opts);
  const result = await upsertCompanies(db, candidates);
  return { ...result, unknownVendor };
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Read-only lookup of every `(vendor, slug)` pair already in `companies`, as
 * `"vendor:slug.lower()"` keys. Lets a caller report "already present" vs.
 * "new" (e.g. `companies discover-canada --dry-run`) without writing
 * anything — `upsertCompanies` computes the same set internally, but only as
 * a side effect of an insert.
 */
export async function existingVendorSlugKeys(db: Db): Promise<Set<string>> {
  const rows = await db
    .select({ atsVendor: companies.atsVendor, atsSlug: companies.atsSlug })
    .from(companies);
  const keys = new Set<string>();
  for (const row of rows) {
    if (row.atsSlug) keys.add(`${row.atsVendor}:${row.atsSlug.toLowerCase()}`);
  }
  return keys;
}

/** First candidate wins per `(vendor, lower(slug))`. */
function dedupeCandidates(candidates: CompanyCandidate[]): CompanyCandidate[] {
  const seen = new Map<string, CompanyCandidate>();
  for (const c of candidates) {
    const key = `${c.atsVendor}:${(c.atsSlug ?? "").toLowerCase()}`;
    if (!seen.has(key)) seen.set(key, c);
  }
  return [...seen.values()];
}

/**
 * Reconciles candidates against `companies`.
 *
 * Three outcomes per candidate:
 * - the `(vendor, slug)` pair already exists → nothing to do;
 * - a row with the same name exists but has **no** slug — that is one of the
 *   63 rows the v1 CSV seed created from job records — → it is *linked*: given
 *   the vendor, slug and careers URL in place, rather than duplicated;
 * - otherwise insert, disambiguating the display name when a *different*
 *   company already owns it (Figma has both a Greenhouse and a Lever board;
 *   `lower(name)` is unique, so one of them becomes "Figma (lever)").
 */
export async function upsertCompanies(
  db: Db,
  candidates: CompanyCandidate[],
): Promise<Omit<ImportResult, "unknownVendor">> {
  const existingRows = await db
    .select({
      id: companies.id,
      name: companies.name,
      atsVendor: companies.atsVendor,
      atsSlug: companies.atsSlug,
    })
    .from(companies);

  const byVendorSlug = new Set<string>();
  const byName = new Map<string, { id: string; hasSlug: boolean }>();
  for (const row of existingRows) {
    if (row.atsSlug) byVendorSlug.add(`${row.atsVendor}:${row.atsSlug.toLowerCase()}`);
    byName.set(row.name.toLowerCase(), { id: row.id, hasSlug: Boolean(row.atsSlug) });
  }

  const toInsert: CompanyCandidate[] = [];
  const toLink: Array<{ id: string; candidate: CompanyCandidate }> = [];
  let existing = 0;

  for (const candidate of candidates) {
    const slug = candidate.atsSlug ?? "";
    const key = `${candidate.atsVendor}:${slug.toLowerCase()}`;
    if (byVendorSlug.has(key)) {
      existing++;
      continue;
    }
    byVendorSlug.add(key);

    const lower = candidate.name.toLowerCase();
    const clash = byName.get(lower);
    if (clash && !clash.hasSlug) {
      toLink.push({ id: clash.id, candidate });
      byName.set(lower, { id: clash.id, hasSlug: true });
      continue;
    }

    let name = candidate.name;
    if (clash) {
      name = `${candidate.name} (${candidate.atsVendor})`;
      if (byName.has(name.toLowerCase())) name = `${candidate.name} (${candidate.atsVendor}/${slug})`;
      if (byName.has(name.toLowerCase())) continue; // give up rather than fight the index
    }
    byName.set(name.toLowerCase(), { id: "", hasSlug: true });
    toInsert.push({ ...candidate, name });
  }

  for (const { id, candidate } of toLink) {
    await db
      .update(companies)
      .set({
        atsVendor: candidate.atsVendor,
        atsSlug: candidate.atsSlug,
        careersUrl: candidate.careersUrl,
      })
      .where(sql`${companies.id} = ${id}`);
  }

  let inserted = 0;
  for (let i = 0; i < toInsert.length; i += INSERT_CHUNK) {
    const rows = await db
      .insert(companies)
      .values(toInsert.slice(i, i + INSERT_CHUNK))
      // No target: `companies` has two unique indexes and a concurrent run
      // could collide on either. Skipping is always the right answer here.
      .onConflictDoNothing()
      .returning({ id: companies.id });
    inserted += rows.length;
  }

  return { inserted, linked: toLink.length, existing };
}
