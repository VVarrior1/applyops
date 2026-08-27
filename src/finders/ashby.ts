/**
 * Ashby job boards — `api.ashbyhq.com/posting-api/job-board/{slug}`.
 *
 * Ashby is the one vendor that hands over both a clean plaintext body and an
 * explicit `isRemote` flag, so nothing has to be inferred from the location
 * string. `includeCompensation=true` adds the salary band, which is appended
 * to the description because the `fit` step (spec §5) reads it from there.
 * Unlisted postings (`isListed: false`) are drafts and are skipped.
 */
import { fetchJsonOrNull, joinLines, stripHtml, toDate } from "./http";
import type { Finder, RawJob } from "./types";

type AshbyJob = {
  id: string;
  title?: string;
  location?: string;
  secondaryLocations?: Array<{ location?: string }>;
  department?: string;
  team?: string;
  employmentType?: string;
  isListed?: boolean;
  isRemote?: boolean;
  publishedAt?: string;
  updatedAt?: string;
  jobUrl?: string;
  applyUrl?: string;
  descriptionPlain?: string;
  descriptionHtml?: string;
  compensation?: { compensationTierSummary?: string | null };
};

export function ashbyBoardUrl(slug: string): string {
  return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`;
}

export async function fetchAshbyJobs(slug: string): Promise<RawJob[]> {
  const data = await fetchJsonOrNull<{ jobs?: AshbyJob[] }>(ashbyBoardUrl(slug));
  if (!data?.jobs?.length) return [];

  const jobs: RawJob[] = [];
  for (const job of data.jobs) {
    if (job.isListed === false) continue;
    const title = (job.title ?? "").trim();
    const url = job.jobUrl || job.applyUrl;
    if (!title || !url) continue;

    const secondary = (job.secondaryLocations ?? [])
      .map((l) => l.location?.trim())
      .filter(Boolean) as string[];
    const location = job.location?.trim() || secondary[0] || null;

    jobs.push({
      externalId: String(job.id),
      url,
      title,
      location,
      remote:
        job.isRemote === true ||
        /\bremote\b/i.test(location ?? "") ||
        secondary.some((l) => /\bremote\b/i.test(l)),
      description:
        joinLines(
          job.descriptionPlain?.trim() || stripHtml(job.descriptionHtml),
          secondary.length ? `Also hiring in: ${secondary.join("; ")}` : null,
          job.compensation?.compensationTierSummary
            ? `Compensation: ${job.compensation.compensationTierSummary}`
            : null,
        ) || title,
      postedAt: toDate(job.publishedAt ?? job.updatedAt),
    });
  }
  return jobs;
}

export const ashbyFinder: Finder = { vendor: "ashby", fetchJobs: fetchAshbyJobs };
