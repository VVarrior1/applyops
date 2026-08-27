/**
 * SmartRecruiters — `api.smartrecruiters.com/v1/companies/{slug}/postings`.
 *
 * The only vendor here whose list endpoint omits the posting body, so the
 * description has to come from `/postings/{id}` (`jobAd.sections`). That is an
 * extra request per posting, and SmartRecruiters boards are dominated by
 * non-engineering roles, so details are fetched only for titles that survive
 * `isRelevantRole` and only up to `MAX_DETAIL_FETCHES` per company; everything
 * else keeps a description synthesised from the structured list fields. A
 * posting is never dropped for want of a detail fetch.
 *
 * Some tenants have the public API disabled entirely — that shows up as
 * 401/403 on the *listing* call and is reported as `VendorRequiresKeyError`
 * so `runFinders` can log it once and skip the vendor rather than hammering
 * every slug (plan Task 7, endpoints note).
 */
import { isRelevantRole } from "./filters";
import { fetchJsonOrNull, joinLines, sleep, stripHtml, toDate } from "./http";
import { VendorRequiresKeyError, type Finder, type RawJob } from "./types";

const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const MAX_DETAIL_FETCHES = 40;
const DETAIL_DELAY_MS = 120;

type SrPosting = {
  id: string;
  name?: string;
  releasedDate?: string;
  company?: { identifier?: string; name?: string };
  location?: {
    city?: string;
    region?: string;
    country?: string;
    fullLocation?: string;
    remote?: boolean;
    hybrid?: boolean;
  };
  industry?: { label?: string };
  department?: { label?: string };
  function?: { label?: string };
  typeOfEmployment?: { label?: string };
  experienceLevel?: { label?: string };
};

type SrDetail = {
  postingUrl?: string;
  applyUrl?: string;
  jobAd?: { sections?: Record<string, { title?: string; text?: string }> };
};

export function smartrecruitersListUrl(slug: string, offset: number): string {
  return `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=${PAGE_SIZE}&offset=${offset}`;
}

export function smartrecruitersDetailUrl(slug: string, id: string): string {
  return `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings/${encodeURIComponent(id)}`;
}

async function listPostings(slug: string): Promise<SrPosting[]> {
  const all: SrPosting[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = smartrecruitersListUrl(slug, page * PAGE_SIZE);
    let data: { content?: SrPosting[]; totalFound?: number } | null;
    try {
      data = await fetchJsonOrNull<{ content?: SrPosting[]; totalFound?: number }>(url);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 401 || status === 403) {
        throw new VendorRequiresKeyError("smartrecruiters", status);
      }
      throw err;
    }
    const content = data?.content ?? [];
    all.push(...content);
    if (content.length < PAGE_SIZE) break;
    if (data?.totalFound != null && all.length >= data.totalFound) break;
    await sleep(DETAIL_DELAY_MS);
  }
  return all;
}

export async function fetchSmartRecruitersJobs(slug: string): Promise<RawJob[]> {
  const postings = await listPostings(slug);
  if (postings.length === 0) return [];

  const jobs: RawJob[] = [];
  let detailFetches = 0;

  for (const posting of postings) {
    const title = (posting.name ?? "").trim();
    const id = posting.id == null ? "" : String(posting.id);
    if (!title || !id) continue;

    const loc = posting.location;
    const location =
      loc?.fullLocation?.trim() ||
      [loc?.city, loc?.region, loc?.country].filter(Boolean).join(", ") ||
      null;

    let detail: SrDetail | null = null;
    if (detailFetches < MAX_DETAIL_FETCHES && isRelevantRole(title)) {
      detailFetches++;
      if (detailFetches > 1) await sleep(DETAIL_DELAY_MS);
      try {
        detail = await fetchJsonOrNull<SrDetail>(smartrecruitersDetailUrl(slug, id));
      } catch {
        // A single bad detail must not lose the posting.
        detail = null;
      }
    }

    const sections = detail?.jobAd?.sections ?? {};
    const body = ["jobDescription", "qualifications", "additionalInformation", "companyDescription"]
      .map((key) => stripHtml(sections[key]?.text))
      .filter(Boolean)
      .join("\n\n");

    jobs.push({
      externalId: id,
      url:
        detail?.postingUrl ||
        `https://jobs.smartrecruiters.com/${encodeURIComponent(slug)}/${encodeURIComponent(id)}`,
      title,
      location,
      remote: loc?.remote === true || /\bremote\b/i.test(location ?? ""),
      description:
        joinLines(
          body,
          posting.department?.label ? `Department: ${posting.department.label}` : null,
          posting.function?.label ? `Function: ${posting.function.label}` : null,
          posting.typeOfEmployment?.label ? `Employment: ${posting.typeOfEmployment.label}` : null,
          posting.experienceLevel?.label ? `Experience level: ${posting.experienceLevel.label}` : null,
          posting.industry?.label ? `Industry: ${posting.industry.label}` : null,
        ) || title,
      postedAt: toDate(posting.releasedDate),
    });
  }
  return jobs;
}

export const smartrecruitersFinder: Finder = {
  vendor: "smartrecruiters",
  fetchJobs: fetchSmartRecruitersJobs,
};
