/**
 * The hourly urgent tier: watch the community new-grad feeds and text the
 * owner the moment something genuinely worth dropping everything for appears.
 *
 * This is the *narrow* counterpart to the 7am email digest. The digest reads
 * 40 company careers pages and reports everything decent; this reads
 * curated new-grad feeds every hour and interrupts a phone only for a strong,
 * fresh, Canadian, genuinely entry-level match. Every stage below exists to
 * protect that promise — a text that fires for a mediocre job trains the
 * owner to ignore texts, which is worse than sending none.
 *
 * Order matters, cheapest filter first:
 *   1. `shortlist` — pure string work over ~22k records, no network, no model.
 *   2. `fetchDescription` — one board-API call per survivor (a handful/hour).
 *   3. `classifyEntryLevel` — the same hardened filter the scraper uses;
 *      an unreadable description yields `null`, which is treated as "do not
 *      text", never as a pass.
 *   4. analyze + fit — the real ranker, on what is left (usually zero).
 *
 * Dedupe is a `job_pings` row per (user, posting, channel) with a unique
 * index behind it, so a crash between sending and recording can at worst
 * re-text once, and a re-run within the hour texts nothing.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { jobPings } from "../db/schema";
import { classifyEntryLevel } from "../finders/filters";
import { runAnalyze, runFit } from "../pipeline/steps";
import { getConfirmedFacts, getPrefs } from "../profile/facts";
import { toFitPrefs } from "../rank/rank";
import { fetchDescription } from "./describe";
import { shortlist, type ShortlistOptions } from "./filter";
import { alertSourcesFileSchema, fetchSource, type FeedListing } from "./sources";
import { renderSms, sendSms } from "./sms";

/** Score at or above which a posting earns a text. Set from the owner's choice; see the CLI flag. */
export const DEFAULT_SMS_THRESHOLD = 75;
/** How recently a dated listing must have been posted to count as urgent. */
export const DEFAULT_FRESHNESS_HOURS = 24;
/** Hard ceiling on descriptions fetched + scored per run, so a feed glitch cannot run up a bill. */
export const MAX_CANDIDATES_PER_RUN = 12;
/** Hard ceiling on texts per run. More than this in an hour means something is wrong, not that the market got good. */
export const MAX_SMS_PER_RUN = 3;

export interface AlertRunSummary {
  fetched: number;
  shortlisted: number;
  descriptionMissing: number;
  rejectedEntryLevel: number;
  scored: number;
  sent: number;
  belowThreshold: number;
  sourceErrors: string[];
  sentJobs: { company: string; title: string; score: number; url: string }[];
}

export interface AlertRunOptions {
  db: Db;
  userId: string;
  /** E.164, e.g. +15871234567. */
  to: string;
  sourcesJson: unknown;
  threshold?: number;
  freshnessHours?: number;
  /** Log and score, but never text and never record. */
  dryRun?: boolean;
  onProgress?: (line: string) => void;
  fetchImpl?: typeof fetch;
  now?: Date;
}

async function loadAlreadySent(db: Db, userId: string, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await db
    .select({ externalKey: jobPings.externalKey })
    .from(jobPings)
    .where(
      and(
        eq(jobPings.userId, userId),
        eq(jobPings.channel, "sms"),
        inArray(jobPings.externalKey, keys),
      ),
    );
  return new Set(rows.map((r) => r.externalKey));
}

export async function runAlerts(opts: AlertRunOptions): Promise<AlertRunSummary> {
  const {
    db,
    userId,
    to,
    threshold = DEFAULT_SMS_THRESHOLD,
    freshnessHours = DEFAULT_FRESHNESS_HOURS,
    dryRun = false,
    fetchImpl = fetch,
    now = new Date(),
  } = opts;
  const log = opts.onProgress ?? (() => {});

  const summary: AlertRunSummary = {
    fetched: 0,
    shortlisted: 0,
    descriptionMissing: 0,
    rejectedEntryLevel: 0,
    scored: 0,
    sent: 0,
    belowThreshold: 0,
    sourceErrors: [],
    sentJobs: [],
  };

  const config = alertSourcesFileSchema.parse(opts.sourcesJson);
  const listings: FeedListing[] = [];
  for (const source of config.sources) {
    if (!source.enabled) continue;
    const { listings: found, error } = await fetchSource(source, fetchImpl);
    if (error) summary.sourceErrors.push(error);
    listings.push(...found);
    log(`${source.id}: ${found.length} active listings${error ? ` (${error})` : ""}`);
  }
  summary.fetched = listings.length;

  const alreadySent = await loadAlreadySent(db, userId, listings.map((l) => l.externalKey));
  const shortlistOpts: ShortlistOptions = { freshnessHours, alreadySent, now };
  const candidates = shortlist(listings, shortlistOpts).slice(0, MAX_CANDIDATES_PER_RUN);
  summary.shortlisted = candidates.length;
  log(`shortlisted ${candidates.length} of ${listings.length}`);

  const [facts, prefsRow] = await Promise.all([
    getConfirmedFacts(db, userId),
    getPrefs(db, userId),
  ]);

  for (const candidate of candidates) {
    if (summary.sent >= MAX_SMS_PER_RUN) break;

    const description = await fetchDescription(candidate.url, fetchImpl);
    if (!description) {
      // Unsupported vendor or a failed request. Not evidence of anything, so
      // it is counted and skipped rather than guessed at.
      summary.descriptionMissing += 1;
      log(`  skip (no description) ${candidate.company} — ${candidate.title}`);
      continue;
    }

    if (classifyEntryLevel(candidate.title, description) !== true) {
      // `false` (senior) and `null` (can't tell) are both "do not text".
      summary.rejectedEntryLevel += 1;
      log(`  reject (not entry level) ${candidate.company} — ${candidate.title}`);
      continue;
    }

    const location = candidate.locations.join(", ");
    const analyzed = await runAnalyze(db, {
      job: {
        title: candidate.title,
        company: candidate.company,
        description,
        location,
        remote: /remote/i.test(location),
      },
      userId,
    });

    const fit = await runFit(db, {
      analysis: analyzed.output,
      facts,
      prefs: toFitPrefs(prefsRow),
      job: {
        title: candidate.title,
        company: candidate.company,
        location,
        remote: /remote/i.test(location),
      },
      userId,
    });
    summary.scored += 1;

    const score = fit.output.score;
    if (score < threshold) {
      summary.belowThreshold += 1;
      log(`  below bar (${score}) ${candidate.company} — ${candidate.title}`);
      continue;
    }

    const body = renderSms({
      company: candidate.company,
      title: candidate.title,
      location,
      score,
      url: candidate.url,
    });

    if (dryRun) {
      log(`  WOULD TEXT (${score}):\n${body}\n`);
      summary.sent += 1;
      summary.sentJobs.push({ company: candidate.company, title: candidate.title, score, url: candidate.url });
      continue;
    }

    // Record first, then send. A crash between the two costs a missed text;
    // the other order costs a duplicate text every run until it succeeds, and
    // a silent miss is friendlier than a loop that keeps buzzing a phone.
    await db.insert(jobPings).values({
      userId,
      externalKey: candidate.externalKey,
      channel: "sms",
      company: candidate.company,
      title: candidate.title,
      url: candidate.url,
      score,
    });

    await sendSms({ to, body }, fetchImpl);
    summary.sent += 1;
    summary.sentJobs.push({ company: candidate.company, title: candidate.title, score, url: candidate.url });
    log(`  TEXTED (${score}) ${candidate.company} — ${candidate.title}`);
  }

  return summary;
}
