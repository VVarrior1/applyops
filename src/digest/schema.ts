/**
 * The wire format the daily career-page watcher sends to `POST /api/digest`.
 *
 * The producer is a scheduled Claude cloud agent (see `data/watchlist.json`
 * and the routine at claude.ai/code/routines), not our own code, so this
 * schema is the *only* thing standing between a model's free-form output and
 * an email. Everything is length-capped: a run that goes haywire and reports
 * four hundred "jobs", or pastes an entire job description into `summary`,
 * gets a 400 instead of an unreadable mail.
 *
 * `url` is restricted to http(s) because it is rendered as a link the owner
 * is expected to click immediately — `javascript:` and `data:` URLs have no
 * business in a job digest.
 */
import { z } from "zod";

/** Cap on jobs per digest. Well above the ~10 a good day produces; a run reporting more has misread something. */
export const MAX_DIGEST_JOBS = 40;

const httpUrl = z
  .string()
  .trim()
  .url()
  .max(2048)
  .refine((u) => /^https?:\/\//i.test(u), { message: "Job links must be http(s)." });

export const digestJobSchema = z.object({
  company: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(200),
  url: httpUrl,
  /** Free text as printed on the posting ("Calgary, AB · Hybrid"), not a parsed structure. */
  location: z.string().trim().max(200).default(""),
  /** What the page said about when it went up ("Posted today", "Aug 29"). Empty when the page shows no date. */
  postedAt: z.string().trim().max(80).default(""),
  /** Two or three sentences on what the role actually is. */
  summary: z.string().trim().min(1).max(1200),
  /** Concrete overlaps with the owner's confirmed resume facts. */
  whyYouQualify: z.array(z.string().trim().min(1).max(400)).max(8).default([]),
  /** Requirements the resume does not currently evidence. Honesty here is the point — see the route doc. */
  gaps: z.array(z.string().trim().min(1).max(400)).max(8).default([]),
  /** The agent's own 0-100 fit call. Used for ordering only; the cutoff is applied agent-side. */
  score: z.number().int().min(0).max(100),
});

export type DigestJob = z.infer<typeof digestJobSchema>;

export const digestPayloadSchema = z.object({
  /** ISO date of the run, for the subject line. Defaults to the server's today. */
  date: z.string().trim().max(40).optional(),
  /** Companies whose careers page could not be read, so a silent gap is visible rather than invisible. */
  unreachable: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
  /** How many careers pages the run actually checked. Shown in the footer as a health signal. */
  checked: z.number().int().min(0).max(1000).default(0),
  jobs: z.array(digestJobSchema).max(MAX_DIGEST_JOBS),
});

export type DigestPayload = z.infer<typeof digestPayloadSchema>;
