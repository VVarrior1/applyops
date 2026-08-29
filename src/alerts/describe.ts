/**
 * Resolves a posting URL from a community feed to the posting's own text.
 *
 * The feeds give a title, a company and a link — never a description — but
 * the entry-level gate is worthless without the body: "Software Engineer"
 * tells you nothing about whether the posting wants five years. So each URL
 * is mapped back to the vendor's public board API, which is the same data the
 * apply page renders, and returns the description as plain text.
 *
 * Vendors covered are the ones the feeds actually link to, measured over the
 * live Simplify listings rather than guessed: SmartRecruiters, Ashby,
 * Greenhouse and Lever account for the large majority. Anything else (Workday
 * tenants, bespoke career sites) returns null, and a null description makes
 * `classifyEntryLevel` answer "unknown" — which the alerter treats as a
 * reason not to text, never as a pass.
 */

/** HTML → readable text. Good enough for an LLM to judge; not trying to be a renderer. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/[ \t]+/g, " ")
    // Tags leave a space where they stood, so a stripped "<li>One</li>" comes
    // out as "\n One". Trim around every newline before collapsing blank
    // runs, so requirement bullets read as clean lines to the model.
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface Resolved {
  apiUrl: string;
  pick: (body: unknown) => string | null;
}

/**
 * Maps a posting URL to the board API that serves it.
 *
 * Ashby is the odd one: it has no per-posting public endpoint, so the whole
 * board is fetched and the posting picked out by id. That is one extra
 * request for a handful of postings an hour, which is cheaper than the
 * alternative of rendering the page.
 */
export function resolveApi(url: string): Resolved | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const parts = parsed.pathname.split("/").filter(Boolean);

  if (host.endsWith("greenhouse.io")) {
    // /<org>/jobs/<id>  |  /embed/job_app?for=<org>&token=<id>
    const org = parts[0];
    const id = parts[parts.indexOf("jobs") + 1] ?? parsed.searchParams.get("token");
    if (!org || !id) return null;
    return {
      apiUrl: `https://boards-api.greenhouse.io/v1/boards/${org}/jobs/${id}`,
      pick: (b) => {
        const j = b as { content?: string };
        return j.content ? htmlToText(j.content) : null;
      },
    };
  }

  if (host.endsWith("lever.co")) {
    // /<org>/<id>[/apply]
    const [org, id] = parts;
    if (!org || !id) return null;
    return {
      apiUrl: `https://api.lever.co/v0/postings/${org}/${id}`,
      pick: (b) => {
        const j = b as { descriptionPlain?: string; description?: string };
        return j.descriptionPlain ?? (j.description ? htmlToText(j.description) : null);
      },
    };
  }

  if (host.endsWith("smartrecruiters.com")) {
    // /<Company>/<postingId>[-slug]
    const [org, rest] = parts;
    const id = rest?.split("-")[0];
    if (!org || !id) return null;
    return {
      apiUrl: `https://api.smartrecruiters.com/v1/companies/${org}/postings/${id}`,
      pick: (b) => {
        const j = b as { jobAd?: { sections?: Record<string, { text?: string }> } };
        const sections = j.jobAd?.sections ?? {};
        const text = Object.values(sections)
          .map((s) => s?.text ?? "")
          .filter(Boolean)
          .join("\n\n");
        return text ? htmlToText(text) : null;
      },
    };
  }

  if (host.endsWith("ashbyhq.com")) {
    // /<org>/<uuid>[/application]
    const [org, id] = parts;
    if (!org || !id) return null;
    return {
      apiUrl: `https://api.ashbyhq.com/posting-api/job-board/${org}`,
      pick: (b) => {
        const board = b as { jobs?: { id?: string; descriptionPlain?: string; descriptionHtml?: string }[] };
        const match = board.jobs?.find((j) => j.id === id);
        if (!match) return null;
        return match.descriptionPlain ?? (match.descriptionHtml ? htmlToText(match.descriptionHtml) : null);
      },
    };
  }

  return null;
}

/**
 * Every outbound call is bounded. This runs unattended on a cron, and a
 * careers host that accepts the connection then never answers would otherwise
 * hang the whole hourly run — observed while testing icims and Oracle
 * Recruiting, which is also why there is no generic HTML fallback here.
 */
export const FETCH_TIMEOUT_MS = 15_000;

/** Fetches a posting's description, or null when the vendor is unsupported or the request fails. */
export async function fetchDescription(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const resolved = resolveApi(url);
  if (!resolved) return null;
  try {
    const response = await fetchImpl(resolved.apiUrl, {
      headers: { "user-agent": "applyops-alerts" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return resolved.pick(await response.json());
  } catch {
    return null;
  }
}
