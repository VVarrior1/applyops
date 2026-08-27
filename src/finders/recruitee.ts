/**
 * Recruitee careers sites — `https://{slug}.recruitee.com/api/offers`.
 *
 * Recruitee splits a posting into `description` and `requirements`, both HTML;
 * the requirements half is where every years-of-experience line lives, so
 * dropping it would blind `isEntryLevel`. Timestamps come back as
 * `"2026-08-19 13:16:05 UTC"`, which `toDate` handles.
 */
import { fetchJsonOrNull, joinLines, stripHtml, toDate } from "./http";
import type { Finder, RawJob } from "./types";

type RecruiteeOffer = {
  id: number | string;
  title?: string;
  slug?: string;
  status?: string;
  description?: string;
  requirements?: string;
  location?: string;
  city?: string;
  state_name?: string;
  country?: string;
  remote?: boolean;
  hybrid?: boolean;
  careers_url?: string;
  careers_apply_url?: string;
  published_at?: string;
  created_at?: string;
  department?: string;
  employment_type_code?: string;
};

export function recruiteeBoardUrl(slug: string): string {
  return `https://${encodeURIComponent(slug)}.recruitee.com/api/offers`;
}

export async function fetchRecruiteeJobs(slug: string): Promise<RawJob[]> {
  const data = await fetchJsonOrNull<{ offers?: RecruiteeOffer[] }>(
    recruiteeBoardUrl(slug),
  );
  if (!data?.offers?.length) return [];

  const jobs: RawJob[] = [];
  for (const offer of data.offers) {
    if (offer.status && offer.status !== "published") continue;
    const title = (offer.title ?? "").trim();
    const url = offer.careers_url || offer.careers_apply_url;
    if (!title || !url) continue;

    const location =
      offer.location?.trim() ||
      [offer.city, offer.state_name, offer.country].filter(Boolean).join(", ") ||
      null;

    jobs.push({
      externalId: String(offer.id),
      url,
      title,
      location,
      remote: offer.remote === true || /\bremote\b/i.test(location ?? ""),
      description:
        joinLines(
          stripHtml(offer.description),
          stripHtml(offer.requirements),
          offer.department ? `Department: ${offer.department}` : null,
        ) || title,
      postedAt: toDate(offer.published_at ?? offer.created_at),
    });
  }
  return jobs;
}

export const recruiteeFinder: Finder = {
  vendor: "recruitee",
  fetchJobs: fetchRecruiteeJobs,
};
