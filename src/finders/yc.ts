/**
 * Y Combinator / Work at a Startup — the public company jobs page at
 * `https://www.ycombinator.com/companies/{slug}/jobs`.
 *
 * v1 queried YC's Algolia index (`Jobs_production` on app `4CT5KVQCBV`). That
 * app no longer exists — its DSN host does not resolve — and the key on the
 * current site is restricted to the `YCCompany_*` indices, so the jobs index
 * is not publicly queryable any more. The company page is, and it is better
 * data: it is an Inertia page whose `data-page` attribute carries the same
 * JSON the React app renders, including the structured `visa`,
 * `minExperience` and `skills` fields that no other vendor publishes.
 *
 * The trade-off is that YC publishes no posting body and no posting date —
 * only a relative age ("about 2 years") — so the description is assembled
 * from those structured fields and `postedAt` is approximate. Both are
 * documented at the point of use.
 */
import { decodeEntities, fetchTextOrNull, joinLines, parseRelativeAge } from "./http";
import type { Finder, RawJob } from "./types";

const ORIGIN = "https://www.ycombinator.com";

type YcJobPosting = {
  id: number | string;
  title?: string;
  url?: string;
  applyUrl?: string;
  location?: string;
  type?: string;
  role?: string;
  roleSpecificType?: string;
  prettyRole?: string;
  salaryRange?: string;
  equityRange?: string;
  minExperience?: string;
  minSchoolYear?: string | null;
  visa?: string;
  skills?: string[];
  companyName?: string;
  companyOneLiner?: string;
  companyBatchName?: string;
  createdAt?: string;
};

export function ycCompanyJobsUrl(slug: string): string {
  return `${ORIGIN}/companies/${encodeURIComponent(slug)}/jobs`;
}

/**
 * Pulls the Inertia payload out of `<div id="app" data-page="{…}">`. The
 * attribute is HTML-escaped, so the value ends at the first *raw* quote.
 */
export function extractInertiaPage(html: string): unknown | null {
  const marker = 'data-page="';
  const start = html.indexOf(marker);
  if (start < 0) return null;
  const from = start + marker.length;
  const end = html.indexOf('"', from);
  if (end < 0) return null;
  try {
    return JSON.parse(decodeEntities(html.slice(from, end)));
  } catch {
    return null;
  }
}

export async function fetchYcJobs(slug: string, now: Date = new Date()): Promise<RawJob[]> {
  const html = await fetchTextOrNull(ycCompanyJobsUrl(slug), {
    accept: "text/html,application/xhtml+xml",
  });
  if (html === null) return [];

  const page = extractInertiaPage(html) as
    | { props?: { jobPostings?: YcJobPosting[]; company?: { name?: string; one_liner?: string } } }
    | null;
  const postings = page?.props?.jobPostings ?? [];
  if (postings.length === 0) return [];
  const company = page?.props?.company;

  const jobs: RawJob[] = [];
  for (const posting of postings) {
    const title = (posting.title ?? "").trim();
    const rel = posting.url ?? "";
    if (!title || !rel) continue;
    const url = rel.startsWith("http") ? rel : `${ORIGIN}${rel}`;

    const location = posting.location?.trim() || null;
    jobs.push({
      externalId: String(posting.id),
      url,
      title,
      location,
      remote: /\bremote\b/i.test(`${location ?? ""} ${title}`),
      // YC publishes no posting body. Everything it *does* publish goes into
      // the description so the filters and `analyze` have something to read.
      description:
        joinLines(
          posting.companyOneLiner ?? company?.one_liner,
          posting.companyBatchName ? `YC batch: ${posting.companyBatchName}` : null,
          posting.prettyRole || posting.roleSpecificType
            ? `Role: ${[posting.prettyRole, posting.roleSpecificType].filter(Boolean).join(" — ")}`
            : null,
          posting.type ? `Type: ${posting.type}` : null,
          posting.minExperience ? `Experience: ${posting.minExperience}` : null,
          posting.minSchoolYear ? `Minimum school year: ${posting.minSchoolYear}` : null,
          posting.visa ? `Visa: ${posting.visa}` : null,
          posting.salaryRange ? `Salary: ${posting.salaryRange}` : null,
          posting.equityRange ? `Equity: ${posting.equityRange}` : null,
          posting.skills?.length ? `Skills: ${posting.skills.join(", ")}` : null,
        ) || title,
      // Approximate: the board only gives an age in prose (see file header).
      postedAt: parseRelativeAge(posting.createdAt, now),
    });
  }
  return jobs;
}

export const ycFinder: Finder = {
  vendor: "yc",
  fetchJobs: (slug: string) => fetchYcJobs(slug),
};
