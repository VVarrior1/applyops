/**
 * Reads the community-maintained new-grad job feeds listed in
 * `data/alert-sources.json` and normalises them into one shape.
 *
 * Why these feeds at all, when we already scrape 1,381 company boards: they
 * are curated *for new grads*, they carry postings from companies not on the
 * watchlist, and SimplifyJobs in particular republishes within minutes of a
 * role going up — which is what makes an hourly "apply now" alert possible.
 *
 * Two kinds of source, and the difference matters:
 *
 * - `json` (SimplifyJobs) — a typed `listings.json` with real `date_posted`
 *   epochs, an `active` flag and `sponsorship`. Everything below is read
 *   straight off a field.
 * - `markdown` (speedyapply) — publishes no structured file at all, so the
 *   table rows are parsed. A markdown table has no posted date, so entries
 *   from it carry `postedAt: null` and can never satisfy the freshness
 *   filter on their own; they exist to widen *coverage*, and the alerter
 *   treats an unseen row as news because it was absent from the previous
 *   snapshot, not because it claims to be new.
 */
import { z } from "zod";

export interface FeedListing {
  /** Source id from the config, e.g. `simplify-newgrad`. */
  source: string;
  /** `<source>:<the source's own id>` — the dedupe key in `job_pings`. */
  externalKey: string;
  company: string;
  title: string;
  url: string;
  locations: string[];
  /** Null for markdown sources, which publish no dates. */
  postedAt: Date | null;
  category: string | null;
  sponsorship: string | null;
}

export const alertSourceSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["json", "markdown"]),
  url: z.string().url(),
  repo: z.string().min(1),
  enabled: z.boolean().default(true),
});
export type AlertSource = z.infer<typeof alertSourceSchema>;

export const alertSourcesFileSchema = z.object({
  sources: z.array(alertSourceSchema).min(1),
});

/**
 * One SimplifyJobs record. Deliberately loose — the repo adds fields over
 * time and an unknown key must never break the hourly run — but every field
 * we actually branch on is validated.
 */
const simplifyListingSchema = z.object({
  id: z.string(),
  company_name: z.string(),
  title: z.string(),
  url: z.string(),
  active: z.boolean().optional(),
  is_visible: z.boolean().optional(),
  date_posted: z.number().optional(),
  locations: z.array(z.string()).nullish(),
  category: z.string().nullish(),
  sponsorship: z.string().nullish(),
});

export function parseSimplify(source: AlertSource, raw: unknown): FeedListing[] {
  if (!Array.isArray(raw)) return [];
  const out: FeedListing[] = [];
  for (const entry of raw) {
    const parsed = simplifyListingSchema.safeParse(entry);
    if (!parsed.success) continue;
    const j = parsed.data;
    // A delisted or hidden posting is not an opportunity — Simplify keeps
    // them in the file for history, and ~83% of the 19k records are inactive.
    if (j.active === false || j.is_visible === false) continue;
    if (!/^https?:\/\//i.test(j.url)) continue;
    out.push({
      source: source.id,
      externalKey: `${source.id}:${j.id}`,
      company: j.company_name,
      title: j.title,
      url: j.url,
      locations: j.locations ?? [],
      postedAt: j.date_posted ? new Date(j.date_posted * 1000) : null,
      category: j.category ?? null,
      sponsorship: j.sponsorship ?? null,
    });
  }
  return out;
}

/**
 * speedyapply's tables look like:
 *   | **[Company](link)** | Role | Location | <a href="apply"><img ...></a> | 0d |
 * The company cell is a markdown link, the apply cell is raw HTML. Rows that
 * do not yield both a company and an apply URL are skipped rather than
 * guessed at — a wrong link in an "apply now" text is worse than a miss.
 */
export function parseSpeedyapply(source: AlertSource, markdown: string): FeedListing[] {
  const out: FeedListing[] = [];
  const seen = new Set<string>();

  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|") || line.includes("---")) continue;
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 5) continue;

    const company = cells[1]?.match(/\[\*{0,2}([^\]*]+)\*{0,2}\]/)?.[1] ?? cells[1]?.replace(/\*/g, "").trim();
    const title = cells[2]?.replace(/\*/g, "").trim();
    const location = cells[3]?.replace(/<br\s*\/?>/gi, ", ").replace(/\*/g, "").trim();
    const url = line.match(/href="(https?:\/\/[^"]+)"/i)?.[1] ?? cells[4]?.match(/\((https?:\/\/[^)]+)\)/)?.[1];

    if (!company || !title || !url) continue;
    if (company.toLowerCase() === "company" || title.toLowerCase() === "role") continue;

    // The feed has no ids, so the key is derived from the apply URL — stable
    // across runs, and distinct per posting.
    const key = `${source.id}:${url}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      source: source.id,
      externalKey: key,
      company,
      title,
      url,
      locations: location ? [location] : [],
      postedAt: null,
      category: null,
      sponsorship: null,
    });
  }
  return out;
}

/** Fetches one source. A single failing feed must not sink the run, so errors surface as an empty list plus a reason. */
export async function fetchSource(
  source: AlertSource,
  fetchImpl: typeof fetch = fetch,
): Promise<{ listings: FeedListing[]; error: string | null }> {
  try {
    // Simplify's listings.json is ~13MB, so this is generous — but still
    // bounded, because the hourly run must always terminate.
    const response = await fetchImpl(source.url, {
      headers: { "user-agent": "applyops-alerts" },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      return { listings: [], error: `${source.id}: HTTP ${response.status}` };
    }
    if (source.kind === "json") {
      return { listings: parseSimplify(source, await response.json()), error: null };
    }
    return { listings: parseSpeedyapply(source, await response.text()), error: null };
  } catch (error) {
    return { listings: [], error: `${source.id}: ${(error as Error).message}` };
  }
}
