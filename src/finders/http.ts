/**
 * The small amount of plumbing every ATS adapter needs: one polite fetch, one
 * HTML-to-text function, one date parser.
 *
 * It lives apart from the adapters so the seven of them stay what they should
 * be — a URL and a field mapping — and so the "a missing board is not an
 * error, a 500 is" rule is written down exactly once.
 */

/** A non-OK response the caller should treat as a real failure. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`HTTP ${status} for ${url}`);
    this.name = "HttpError";
  }
}

/**
 * Identifies the scraper to the boards it reads. Several vendors (YC, and
 * Personio's front end) reject requests with no User-Agent outright.
 */
const USER_AGENT =
  "ApplyOps/0.1 (+https://github.com/VVarrior1/applyops) job-board reader";

const DEFAULT_TIMEOUT_MS = 20_000;

type FetchOpts = { accept?: string; timeoutMs?: number };

/**
 * Fetches a URL as text.
 *
 * Returns `null` for 404/410 — "this company has no board here" is an
 * expected, uninteresting outcome for an allow-list of a few thousand slugs,
 * not something to log or count as an error. Every other non-OK status throws
 * `HttpError`, which `runFinders` records against the company.
 */
export async function fetchTextOrNull(
  url: string,
  opts: FetchOpts = {},
): Promise<string | null> {
  const res = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT,
      accept: opts.accept ?? "application/json, text/plain, */*",
    },
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    redirect: "follow",
  });
  if (res.status === 404 || res.status === 410) return null;
  if (!res.ok) throw new HttpError(res.status, url);
  return res.text();
}

/** As `fetchTextOrNull`, parsed as JSON. Returns null on 404/410. */
export async function fetchJsonOrNull<T>(
  url: string,
  opts: FetchOpts = {},
): Promise<T | null> {
  const body = await fetchTextOrNull(url, opts);
  if (body === null) return null;
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`Malformed JSON from ${url}`);
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  bull: "•",
  middot: "·",
  eacute: "é",
  egrave: "è",
  agrave: "à",
  ccedil: "ç",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  euro: "€",
  pound: "£",
  times: "×",
};

/** Decodes named and numeric HTML entities; leaves unknown ones alone. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * HTML (or entity-encoded HTML) → plain text with paragraph breaks preserved.
 *
 * Greenhouse's `content` field arrives *double* encoded (`&lt;p&gt;…`), so a
 * value that has entity-escaped tags but no real ones is decoded once up
 * front; everything else is stripped first and decoded after, which keeps a
 * literal `&lt;5ms` in a description from being eaten as a tag.
 */
export function stripHtml(value: unknown): string {
  let s = typeof value === "string" ? value : value == null ? "" : String(value);
  if (!s) return "";
  if (!/</.test(s) && /&lt;/i.test(s)) s = decodeEntities(s);

  const text = s
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|ul|ol|table|section)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    // Inline images and other data URIs: one SmartRecruiters posting in the
    // corpus carried a 497 KB base64 PNG that survived tag stripping, which
    // is both a token-cost problem for `analyze` and a source of spurious
    // keyword matches (a `TN1` inside base64 read as a TN-visa mention).
    .replace(/data:[a-z0-9/+.-]+;base64,[A-Za-z0-9+/=\s]+/gi, " ")
    .replace(/[A-Za-z0-9+/=]{200,}/g, " ");

  return decodeEntities(text)
    .replace(/\r/g, "")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Parses whatever a board calls a timestamp: ISO strings, "2026-08-19
 * 13:16:05 UTC" (Recruitee), epoch seconds or millis (Lever). Returns null
 * rather than an Invalid Date — the `jobs.posted_at` column is nullable
 * precisely because several boards publish no date at all.
 */
export function toDate(value: unknown): Date | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  let date: Date;
  if (typeof value === "number") {
    date = new Date(value < 1e11 ? value * 1000 : value);
  } else if (typeof value === "string" && /^\d+$/.test(value)) {
    const n = Number(value);
    date = new Date(n < 1e11 ? n * 1000 : n);
  } else if (typeof value === "string") {
    date = new Date(value);
  } else {
    return null;
  }
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * YC publishes a posting's age as prose ("about 2 years", "3 months ago"),
 * never a date. An approximate date is worth more than none — recency is only
 * ever used for ordering and the 30-day staleness sweep — so this converts
 * the phrase to `now - age` and returns null when it cannot.
 */
export function parseRelativeAge(value: unknown, now: Date = new Date()): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const m =
    /(?:about|over|almost|nearly|less than)?\s*(\d+|an?)\s*(second|minute|hour|day|week|month|year)s?/i.exec(
      value,
    );
  if (!m) return null;
  const count = /^\d+$/.test(m[1]) ? Number(m[1]) : 1;
  const unitMs: Record<string, number> = {
    second: 1000,
    minute: 60_000,
    hour: 3_600_000,
    day: 86_400_000,
    week: 604_800_000,
    month: 2_629_800_000,
    year: 31_557_600_000,
  };
  const ms = unitMs[m[2].toLowerCase()];
  if (!ms) return null;
  return new Date(now.getTime() - count * ms);
}

/** Joins the non-empty pieces of a synthesised description. */
export function joinLines(...parts: Array<string | null | undefined>): string {
  return parts
    .map((p) => (p ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

/** Sleeps — used by `runFinders` for the per-vendor politeness delay. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
