/**
 * Lever postings — `api.lever.co/v0/postings/{slug}?mode=json`.
 *
 * The list response already carries the full body, so unlike v1 there is no
 * per-posting detail fetch. Lever splits a posting across four fields
 * (`descriptionPlain`, `lists`, `additionalPlain`); all of them are joined so
 * the requirements — which live in `lists` — reach the filters and `analyze`.
 */
import { fetchJsonOrNull, joinLines, stripHtml, toDate } from "./http";
import type { Finder, RawJob } from "./types";

type LeverPosting = {
  id: string;
  text?: string;
  hostedUrl?: string;
  applyUrl?: string;
  createdAt?: number | string;
  workplaceType?: string;
  country?: string;
  categories?: { location?: string; commitment?: string; team?: string; department?: string };
  descriptionPlain?: string;
  description?: string;
  lists?: Array<{ text?: string; content?: string }>;
  additionalPlain?: string;
  additional?: string;
};

export function leverBoardUrl(slug: string): string {
  return `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`;
}

export async function fetchLeverJobs(slug: string): Promise<RawJob[]> {
  const data = await fetchJsonOrNull<LeverPosting[]>(leverBoardUrl(slug));
  if (!Array.isArray(data) || data.length === 0) return [];

  const jobs: RawJob[] = [];
  for (const posting of data) {
    const title = (posting.text ?? "").trim();
    const url = posting.hostedUrl || posting.applyUrl;
    if (!title || !url) continue;

    const location = posting.categories?.location?.trim() || null;
    const lists = (posting.lists ?? [])
      .map((l) => joinLines(l.text ? `${stripHtml(l.text)}:` : null, stripHtml(l.content)))
      .filter(Boolean)
      .join("\n\n");

    jobs.push({
      externalId: String(posting.id),
      url,
      title,
      location,
      remote:
        posting.workplaceType?.toLowerCase() === "remote" ||
        /\bremote\b/i.test(location ?? ""),
      description:
        joinLines(
          posting.descriptionPlain?.trim() || stripHtml(posting.description),
          lists,
          posting.additionalPlain?.trim() || stripHtml(posting.additional),
        ) || title,
      postedAt: toDate(posting.createdAt),
    });
  }
  return jobs;
}

export const leverFinder: Finder = { vendor: "lever", fetchJobs: fetchLeverJobs };
