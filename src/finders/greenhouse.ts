/**
 * Greenhouse job boards — `boards-api.greenhouse.io/v1/boards/{slug}/jobs`.
 *
 * `content=true` returns the full posting body inline, which is the whole
 * reason to use this endpoint: one request per company instead of one per
 * posting (v1 fetched details per job behind a `GREENHOUSE_FETCH_DETAILS`
 * flag and normally ran with no descriptions at all). The body arrives
 * HTML-entity-encoded — `stripHtml` handles that.
 */
import { fetchJsonOrNull, stripHtml, toDate } from "./http";
import type { Finder, RawJob } from "./types";

type GreenhouseJob = {
  id: number | string;
  title?: string;
  absolute_url?: string;
  location?: { name?: string } | null;
  content?: string;
  updated_at?: string;
  first_published?: string;
  created_at?: string;
};

export function greenhouseBoardUrl(slug: string): string {
  return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`;
}

export async function fetchGreenhouseJobs(slug: string): Promise<RawJob[]> {
  const data = await fetchJsonOrNull<{ jobs?: GreenhouseJob[] }>(
    greenhouseBoardUrl(slug),
  );
  if (!data?.jobs?.length) return [];

  const jobs: RawJob[] = [];
  for (const job of data.jobs) {
    const title = (job.title ?? "").trim();
    const url = job.absolute_url;
    if (!title || !url) continue;

    const location = job.location?.name?.trim() || null;
    jobs.push({
      externalId: String(job.id),
      url,
      title,
      location,
      remote: /\bremote\b/i.test(location ?? ""),
      description: stripHtml(job.content) || title,
      postedAt: toDate(job.updated_at ?? job.first_published ?? job.created_at),
    });
  }
  return jobs;
}

export const greenhouseFinder: Finder = {
  vendor: "greenhouse",
  fetchJobs: fetchGreenhouseJobs,
};
