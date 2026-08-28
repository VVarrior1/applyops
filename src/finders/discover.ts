/**
 * Canadian ATS discovery: given a company name (and maybe a domain hint),
 * guess the slug it might use on each of the five ATS vendors this repo can
 * read, probe the vendor's public *list* endpoint directly (no auth, no paid
 * API), and report whether it actually has postings there.
 *
 * This is deliberately dumb and cheap: no LLM call, no scraping of the
 * company's own careers page, just HTTP HEAD-shaped requests against five
 * well-known JSON endpoints (the same ones `src/finders/greenhouse.ts`,
 * `lever.ts`, `ashby.ts`, `recruitee.ts` and `smartrecruiters.ts` already
 * read for the nightly scrape). A miss here is the overwhelmingly common
 * case — most companies in `canada-companies.ts` run Workday, iCIMS, or
 * their own careers page, none of which this repo can read — so misses are
 * recorded quietly rather than logged one by one.
 *
 * Politeness matters more here than in the nightly scrape: this probes
 * hundreds of *guessed* slugs, most of which 404, against five hosts that
 * did nothing to invite that traffic. Two knobs enforce it:
 *
 * - a global cap of `MAX_CONCURRENT` requests in flight at any moment
 *   (across every vendor, every company);
 * - a per-vendor gate ensuring consecutive requests to the same vendor are
 *   at least `MIN_VENDOR_GAP_MS` apart, no matter how many companies are
 *   being probed concurrently.
 *
 * Both live in one shared `ProbeContext` so a caller that fires off
 * `Promise.all(companies.map(discoverAts))` still respects both limits
 * globally — the fan-out is real, the network traffic isn't.
 */
import type { AtsVendor } from "./types";

export type ProbeVendor = Extract<
  AtsVendor,
  "greenhouse" | "lever" | "ashby" | "recruitee" | "smartrecruiters"
>;

export const PROBE_VENDORS: ProbeVendor[] = [
  "greenhouse",
  "lever",
  "ashby",
  "recruitee",
  "smartrecruiters",
];

export const DEFAULT_PROBE_TIMEOUT_MS = 6_000;
export const MAX_CONCURRENT_PROBES = 4;
export const MIN_VENDOR_GAP_MS = 150;

const USER_AGENT =
  "ApplyOps/0.1 (+https://github.com/VVarrior1/applyops) canada-employer discovery probe";

/**
 * `(vendor, slug)` pairs confirmed by hand to be an unrelated tenant that
 * sets its `company_name` to the brand it's impersonating — the
 * `company_name` cross-check in `classifyProbeResponse` cannot see through
 * that, because the impostor's own data agrees with what was searched for.
 * Found while running the initial `discover-canada` pass over
 * `canada-companies.ts`'s "large global tech" section:
 *
 * - `recruitee:google` — a single "Senior Marketer (Sample)" posting; the
 *   title marks it as a demo/placeholder tenant, not Google.
 * - `recruitee:ey` — the posting's `requirements` text is a leaked prompt
 *   template ("...should be concise, using simple language and be between
 *   200-300 words in length"), i.e. AI-spam impersonating EY.
 * - `recruitee:meta` — resolves (via a 302 the vendor adapter's `fetch`
 *   follows) to a `facebookdata.recruitee.com` tenant with the same
 *   spam-template pattern.
 *
 * These are *hard* excludes rather than something `slugCandidates` should
 * avoid generating: the slug guess itself was correct (or would have been,
 * for the real company) — the problem is that these particular vendor
 * tenants are impostors, which is a fact about that specific board, not
 * about how the name was normalized. Add an entry here only after fetching
 * the endpoint and reading the actual posting content by hand.
 */
const KNOWN_IMPOSTOR_TENANTS = new Set<string>(["recruitee:google", "recruitee:ey", "recruitee:meta"]);

function isKnownImpostorTenant(vendor: ProbeVendor, slug: string): boolean {
  return KNOWN_IMPOSTOR_TENANTS.has(`${vendor}:${slug.toLowerCase()}`);
}

// ---------------------------------------------------------------------------
// Slug candidate generation
// ---------------------------------------------------------------------------

/** Corporate-entity words stripped from the *end* of a name to form an extra candidate. */
const LEGAL_SUFFIX_WORDS = new Set([
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "ltd",
  "limited",
  "llc",
  "llp",
  "co",
  "company",
  "group",
  "holdings",
]);

/** Lowercases and splits on anything that isn't a letter or digit. Apostrophes are dropped, not split on. */
function words(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function stripLegalSuffix(ws: string[]): string[] {
  if (ws.length > 1 && LEGAL_SUFFIX_WORDS.has(ws[ws.length - 1])) return ws.slice(0, -1);
  return ws;
}

/**
 * Generates the slug candidates worth probing for a company name (and
 * optional domain hint): the concatenated and hyphenated forms of the name,
 * the same with a trailing legal suffix (" Inc", " Ltd", …) dropped, and —
 * because a parenthetical often carries the *other* name a company is known
 * by ("Shareworks (Solium)", "Ceridian (Dayforce)") — the base name alone,
 * the parenthetical alone, and the two combined.
 *
 * A `domain` hint (e.g. "getjobber.com") contributes its own label
 * ("getjobber") as one more candidate: several boards use the product/domain
 * name rather than the legal company name as their slug.
 */
export function slugCandidates(name: string, domain?: string): string[] {
  const out = new Set<string>();
  const add = (ws: string[]) => {
    if (ws.length === 0) return;
    const concat = ws.join("");
    const hyphen = ws.join("-");
    if (concat) out.add(concat);
    if (hyphen) out.add(hyphen);
  };

  const parenMatch = /^(.*?)\s*\(([^)]+)\)\s*(.*)$/.exec(name);
  let base = name;
  let parenPart: string | null = null;
  if (parenMatch) {
    base = `${parenMatch[1]} ${parenMatch[3]}`.trim();
    parenPart = parenMatch[2].trim() || null;
  }

  const baseWords = words(base);
  add(baseWords);
  add(stripLegalSuffix(baseWords));

  if (parenPart) {
    const parenWords = words(parenPart);
    add(parenWords);
    add(stripLegalSuffix(parenWords));
    add(words(`${base} ${parenPart}`));
  }

  if (domain) {
    const label = domain.trim().toLowerCase().replace(/^www\./, "").split(".")[0];
    if (label) out.add(label);
  }

  return [...out];
}

// ---------------------------------------------------------------------------
// Vendor endpoint URLs (mirrors src/finders/{greenhouse,lever,ashby,recruitee,smartrecruiters}.ts)
// ---------------------------------------------------------------------------

export function probeUrlFor(vendor: ProbeVendor, slug: string): string {
  const s = encodeURIComponent(slug);
  switch (vendor) {
    case "greenhouse":
      return `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`;
    case "lever":
      return `https://api.lever.co/v0/postings/${s}?mode=json`;
    case "ashby":
      return `https://api.ashbyhq.com/posting-api/job-board/${s}`;
    case "recruitee":
      return `https://${s}.recruitee.com/api/offers`;
    case "smartrecruiters":
      return `https://api.smartrecruiters.com/v1/companies/${s}/postings`;
  }
}

// ---------------------------------------------------------------------------
// Hit/miss classification
// ---------------------------------------------------------------------------

export type ProbeOutcome = { hit: false } | { hit: true; jobCount: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayLength(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null;
}

/**
 * Board tokens/subdomains on these vendors are a shared, unverified
 * namespace — nothing stops an unrelated small business from picking
 * `solera` or `parkland` for itself, and nothing stops a scraper-bait or
 * scam listing from squatting `google` or `meta` and simply *claiming* to be
 * that company in its data. Three of the five vendors' list responses expose
 * a per-posting company name, so where one is available it is compared
 * against the name we were actually looking for; a clear mismatch turns what
 * would otherwise look like a hit back into a miss.
 *
 * This catches the "wrong, unrelated real company" case (a genuine Solera
 * Health posting when the target was Solera Holdings; a genuine Parkland
 * Animal Clinic posting when the target was Parkland Corporation) — it
 * cannot catch a listing that deliberately sets `company_name` to the brand
 * it's impersonating. `discoverAts` callers still owe a skim of the hits for
 * a household name with a suspiciously small posting count before trusting
 * them; see `cli/commands/companies.ts`'s `discover-canada` output.
 */
function extractCompanyName(vendor: ProbeVendor, body: unknown): string | null {
  const firstOf = (arr: unknown): unknown => (Array.isArray(arr) && arr.length > 0 ? arr[0] : null);

  switch (vendor) {
    case "greenhouse": {
      const first = isRecord(body) ? firstOf(body.jobs) : null;
      return isRecord(first) && typeof first.company_name === "string" ? first.company_name : null;
    }
    case "recruitee": {
      const first = isRecord(body) ? firstOf(body.offers) : null;
      return isRecord(first) && typeof first.company_name === "string" ? first.company_name : null;
    }
    case "smartrecruiters": {
      const first = isRecord(body) ? firstOf(body.content) : null;
      const company = isRecord(first) ? first.company : null;
      return isRecord(company) && typeof company.name === "string" ? company.name : null;
    }
    // Lever's and Ashby's list endpoints carry no per-posting company name
    // to check against — nothing to compare, so nothing is rejected.
    case "lever":
    case "ashby":
      return null;
  }
}

/** Lowercased, alnum-only tokens — the same normalization `slugCandidates` uses for names. */
function nameTokens(name: string): Set<string> {
  return new Set(words(name));
}

const NAME_STOPWORDS = new Set([
  "the",
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "ltd",
  "limited",
  "llc",
  "group",
  "co",
]);

const filteredTokens = (name: string): Set<string> =>
  new Set([...nameTokens(name)].filter((t) => !NAME_STOPWORDS.has(t) && t.length > 2));

/**
 * True unless the two names are confidently *different* companies.
 *
 * Two shortcuts first: identical after normalizing, or one is a substring of
 * the other (catches "EY" vs. "EY Canada", and a legitimate rebrand caught
 * via a domain hint — see `discoverAts`, which folds the domain label into
 * `expected`). Failing that, a *plain* shared word is not enough — "Solera
 * Health" and "Solera Holdings" share "solera" and are still two different
 * companies — so this falls back to token-set overlap (intersection over
 * union) and requires at least half the combined vocabulary to match. Errs
 * toward rejecting on a real disagreement: a quiet miss costs nothing, an
 * unrelated company mislabeled with a household name costs trust.
 */
export function namesLooselyMatch(expected: string, got: string): boolean {
  const a = expected.trim().toLowerCase();
  const b = got.trim().toLowerCase();
  if (!a || !b) return true;
  if (a === b || a.includes(b) || b.includes(a)) return true;

  const setA = filteredTokens(expected);
  const setB = filteredTokens(got);
  if (setA.size === 0 || setB.size === 0) return true;

  const intersection = [...setA].filter((t) => setB.has(t)).length;
  const union = new Set([...setA, ...setB]).size;
  return intersection / union >= 0.5;
}

/**
 * A hit is HTTP 200 with a JSON body carrying a non-empty postings array in
 * the shape that vendor uses (`jobs` for Greenhouse/Ashby, the bare array
 * itself for Lever, `offers` for Recruitee, `content` for SmartRecruiters).
 * An empty board (200 with zero postings) is explicitly a miss — it proves
 * the slug resolves, but gives `runFinders` nothing to scrape yet, and a
 * wrong-but-parseable slug guess can easily 200 with an empty array.
 *
 * `expectedName`, when given, is cross-checked against whatever company name
 * the response itself carries (see `extractCompanyName`) — see that
 * function's doc for what this can and cannot catch.
 */
export function classifyProbeResponse(
  vendor: ProbeVendor,
  status: number,
  body: unknown,
  expectedName?: string,
): ProbeOutcome {
  if (status !== 200) return { hit: false };

  const count =
    vendor === "lever"
      ? arrayLength(body)
      : vendor === "greenhouse" || vendor === "ashby"
        ? isRecord(body)
          ? arrayLength(body.jobs)
          : null
        : vendor === "recruitee"
          ? isRecord(body)
            ? arrayLength(body.offers)
            : null
          : isRecord(body)
            ? arrayLength(body.content)
            : null;

  if (!count) return { hit: false };

  if (expectedName) {
    const gotName = extractCompanyName(vendor, body);
    if (gotName && !namesLooselyMatch(expectedName, gotName)) return { hit: false };
  }

  return { hit: true, jobCount: count };
}

/**
 * Fetches one (vendor, slug) endpoint and classifies it. Every failure mode
 * — network error, timeout, non-200, malformed JSON — collapses to a quiet
 * miss; nothing here throws. `timeoutMs` bounds the whole request, matching
 * the vendor adapters' own defensive posture (a dead/slow board must not
 * stall the run).
 */
export async function probeVendorSlug(
  vendor: ProbeVendor,
  slug: string,
  opts: { timeoutMs?: number; expectedName?: string } = {},
): Promise<ProbeOutcome> {
  if (isKnownImpostorTenant(vendor, slug)) return { hit: false };
  const url = probeUrlFor(vendor, slug);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return classifyProbeResponse(vendor, res.status, body, opts.expectedName);
  } catch {
    return { hit: false };
  }
}

// ---------------------------------------------------------------------------
// Rate limiting: a global concurrency cap + a per-vendor minimum gap
// ---------------------------------------------------------------------------

class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly max: number) {}

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const grant = () => {
        this.active++;
        resolve(() => this.release());
      };
      if (this.active < this.max) grant();
      else this.queue.push(grant);
    });
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

/** Serializes callers and ensures ≥`minGapMs` between the *start* of consecutive requests. */
class VendorGate {
  private lastStart = 0;
  private chain: Promise<void> = Promise.resolve();
  constructor(private readonly minGapMs: number) {}

  wait(): Promise<void> {
    const turn = this.chain.then(async () => {
      const waitMs = Math.max(0, this.lastStart + this.minGapMs - Date.now());
      if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
      this.lastStart = Date.now();
    });
    // Everyone after this caller waits for this caller's turn to finish first.
    this.chain = turn.catch(() => {});
    return turn;
  }
}

export type ProbeFn = (
  vendor: ProbeVendor,
  slug: string,
  expectedName?: string,
) => Promise<ProbeOutcome>;
export type ProbeContext = { probe: ProbeFn };

export function createProbeContext(
  opts: {
    timeoutMs?: number;
    maxConcurrent?: number;
    minVendorGapMs?: number;
  } = {},
): ProbeContext {
  const semaphore = new Semaphore(opts.maxConcurrent ?? MAX_CONCURRENT_PROBES);
  const gates = new Map<ProbeVendor, VendorGate>();
  const gateFor = (vendor: ProbeVendor): VendorGate => {
    let gate = gates.get(vendor);
    if (!gate) {
      gate = new VendorGate(opts.minVendorGapMs ?? MIN_VENDOR_GAP_MS);
      gates.set(vendor, gate);
    }
    return gate;
  };

  return {
    probe: async (vendor, slug, expectedName) => {
      // Reserve this request's place in the vendor's timeline *before*
      // fighting for a concurrency slot, so the spacing guarantee holds
      // even when the semaphore is the bottleneck.
      await gateFor(vendor).wait();
      const release = await semaphore.acquire();
      try {
        return await probeVendorSlug(vendor, slug, { timeoutMs: opts.timeoutMs, expectedName });
      } finally {
        release();
      }
    },
  };
}

let sharedContext: ProbeContext | undefined;
/** The context every `discoverAts` call shares by default, so a whole discovery run — however many companies are probed "in parallel" by the caller — obeys one global rate limit. */
export function getSharedProbeContext(): ProbeContext {
  if (!sharedContext) sharedContext = createProbeContext();
  return sharedContext;
}

/** Test-only: forces the next `getSharedProbeContext()` call to build a fresh context. */
export function resetSharedProbeContext(): void {
  sharedContext = undefined;
}

// ---------------------------------------------------------------------------
// Company-level discovery
// ---------------------------------------------------------------------------

export type CompanyHint = { name: string; domain?: string };

export type DiscoverHit = {
  name: string;
  vendor: ProbeVendor;
  slug: string;
  jobCount: number;
};

/**
 * Tries every vendor for one company, each with its own slug-candidate
 * search, and returns the first hit (vendor priority: greenhouse, lever,
 * ashby, recruitee, smartrecruiters — the order `PROBE_VENDORS` lists them
 * in). Returns null if nothing hit, or if the name yields no usable slug
 * candidates at all.
 *
 * The five vendors are probed concurrently (they are five different hosts;
 * there is no reason to serialize across them), but candidates *within* one
 * vendor are tried in order and stop at the first hit — a company that is on
 * Greenhouse under its obvious slug does not need its other three guesses
 * tried too.
 */
export async function discoverAts(
  company: CompanyHint,
  ctx: ProbeContext = getSharedProbeContext(),
): Promise<DiscoverHit | null> {
  const candidates = slugCandidates(company.name, company.domain);
  if (candidates.length === 0) return null;

  // Fold the domain's label into the expected-name check so a legitimate
  // rebrand a board's `company_name` reports under its product name rather
  // than the legal name we searched for (Ceridian's board saying
  // "Dayforce") still passes — the domain hint is exactly that product name.
  const domainLabel = company.domain?.replace(/^www\./, "").split(".")[0];
  const expectedName = domainLabel ? `${company.name} ${domainLabel}` : company.name;

  const perVendor = await Promise.all(
    PROBE_VENDORS.map(async (vendor): Promise<DiscoverHit | null> => {
      for (const slug of candidates) {
        const outcome = await ctx.probe(vendor, slug, expectedName);
        if (outcome.hit) return { name: company.name, vendor, slug, jobCount: outcome.jobCount };
      }
      return null;
    }),
  );

  for (let i = 0; i < PROBE_VENDORS.length; i++) {
    if (perVendor[i]) return perVendor[i];
  }
  return null;
}
