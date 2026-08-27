/**
 * Personio career pages — `https://{slug}.jobs.personio.{de,com}/xml`.
 *
 * The only XML feed of the seven. Personio splits a posting into named
 * sections ("Your Job", "Responsibilities", "Requirements"), each a CDATA
 * block of HTML; they are flattened back into one labelled plaintext body.
 *
 * The tenant host is per-customer and not derivable from the slug — German
 * customers are on `.de`, most others on `.com` — so a `.de` miss retries
 * `.com` before giving up, and the host that answered decides the posting URL.
 */
import { XMLParser } from "fast-xml-parser";
import { fetchTextOrNull, joinLines, stripHtml, toDate } from "./http";
import type { Finder, RawJob } from "./types";

const HOSTS = ["de", "com"] as const;

type PersonioDescription = { name?: string; value?: string };
type PersonioPosition = {
  id?: number | string;
  name?: string;
  office?: string;
  department?: string;
  subcompany?: string;
  employmentType?: string;
  seniority?: string;
  schedule?: string;
  yearsOfExperience?: string;
  occupation?: string;
  keywords?: string;
  createdAt?: string;
  jobDescriptions?: { jobDescription?: PersonioDescription | PersonioDescription[] } | string;
};

const parser = new XMLParser({
  ignoreAttributes: true,
  trimValues: true,
  // Ids like `2723821` must stay strings; `parseTagValue: false` also keeps
  // ISO timestamps from being mangled into numbers.
  parseTagValue: false,
});

export function personioFeedUrl(slug: string, host: (typeof HOSTS)[number]): string {
  return `https://${encodeURIComponent(slug)}.jobs.personio.${host}/xml?language=en`;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

export async function fetchPersonioJobs(slug: string): Promise<RawJob[]> {
  for (const host of HOSTS) {
    const xml = await fetchTextOrNull(personioFeedUrl(slug, host), {
      accept: "application/xml, text/xml, */*",
    });
    if (xml === null) continue;

    const parsed = parser.parse(xml) as {
      "workzag-jobs"?: { position?: PersonioPosition | PersonioPosition[] };
    };
    const positions = asArray(parsed["workzag-jobs"]?.position);
    if (positions.length === 0) return [];

    const jobs: RawJob[] = [];
    for (const position of positions) {
      const title = String(position.name ?? "").trim();
      const id = position.id == null ? "" : String(position.id);
      if (!title || !id) continue;

      const sections =
        typeof position.jobDescriptions === "object"
          ? asArray(position.jobDescriptions?.jobDescription)
          : [];
      const body = sections
        .map((s) => joinLines(s.name ? `${String(s.name).trim()}:` : null, stripHtml(s.value)))
        .filter(Boolean)
        .join("\n\n");

      const location = String(position.office ?? "").trim() || null;
      // Personio's own structured fields are the fallback body for the many
      // postings that publish no description at all.
      const meta = joinLines(
        position.department ? `Department: ${position.department}` : null,
        position.employmentType ? `Employment type: ${position.employmentType}` : null,
        position.seniority ? `Seniority: ${position.seniority}` : null,
        position.schedule ? `Schedule: ${position.schedule}` : null,
        position.yearsOfExperience ? `Years of experience: ${position.yearsOfExperience}` : null,
        position.keywords ? `Keywords: ${position.keywords}` : null,
      );

      jobs.push({
        externalId: id,
        url: `https://${slug}.jobs.personio.${host}/job/${id}?language=en`,
        title,
        location,
        remote: /\bremote\b/i.test(`${location ?? ""} ${title} ${body}`),
        description: joinLines(body, meta) || title,
        postedAt: toDate(position.createdAt),
      });
    }
    return jobs;
  }
  return [];
}

export const personioFinder: Finder = {
  vendor: "personio",
  fetchJobs: fetchPersonioJobs,
};
