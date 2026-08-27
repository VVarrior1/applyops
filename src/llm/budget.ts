/**
 * Per-user daily spend cap (spec §11: "`usage_daily` checked before every LLM
 * call; over budget → 429 with a friendly message").
 *
 * Two halves, deliberately separated:
 *   - {@link decideBudget} is pure arithmetic, so the rule that actually
 *     gates spending is unit-tested without a database;
 *   - the rest reads `profiles.daily_budget_usd` / `usage_daily` and writes
 *     the running total back.
 *
 * `userId === null` means "owner CLI / eval run" and bypasses the cap
 * entirely: those paths are owner-only by construction (spec §11) and a
 * benchmark sweep would otherwise trip a $1/day consumer limit immediately.
 */

import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { profiles, usageDaily } from "../db/schema";
import { LlmError } from "./model-id";
import { COST_DECIMALS } from "./pricing";

/** Matches `profiles.daily_budget_usd`'s column default. */
export const DEFAULT_DAILY_BUDGET_USD = 1.0;

/** Sentinel budget for the owner CLI / eval path — never exceeded. */
export const UNLIMITED_BUDGET = Number.POSITIVE_INFINITY;

/**
 * Tolerance for the comparison, in USD. Budgets and costs are decimals stored
 * as `numeric` but compared as IEEE-754 doubles, where `0.1 + 0.2 > 0.3`.
 * A tenth of a millionth of a dollar is far below the 6-decimal precision the
 * columns keep, so this can only ever forgive float noise, never real spend.
 */
const EPSILON_USD = 1e-7;

export interface BudgetDecision {
  allowed: boolean;
  /** User-facing explanation when blocked; `null` when allowed. */
  reason: string | null;
  spentToday: number;
  dailyBudget: number;
  estimate: number;
  /** Budget left *before* this call, floored at 0. */
  remainingUsd: number;
}

export interface BudgetState {
  dailyBudget: number;
  spentToday: number;
  calls: number;
}

/**
 * Thrown when a call is refused for cost. Carries the full decision so an API
 * route can render the numbers, and `status` 429 so the handler can return the
 * right code without inspecting the message (spec §11).
 */
export class BudgetExceededError extends LlmError {
  readonly decision: BudgetDecision;

  constructor(message: string, decision: BudgetDecision) {
    super("budget_exceeded", message, { status: 429 });
    this.decision = decision;
  }
}

/**
 * Money for a user-facing sentence. Two decimals normally, four when the
 * amount is a real but sub-cent figure — a single cheap call costs well under
 * a cent, and "estimated at $0.00" in a refusal message reads as a bug.
 */
function usd(n: number): string {
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function sanitize(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * The spend rule, in one pure function: a call is allowed when today's spend
 * plus this call's estimated cost still fits inside the user's daily budget.
 *
 * Landing exactly on the budget is allowed. A non-finite budget (the owner
 * bypass) always allows; a zero budget always blocks.
 */
export function decideBudget(args: {
  spentToday: number;
  dailyBudget: number;
  estimate: number;
}): BudgetDecision {
  const spentToday = sanitize(args.spentToday);
  const estimate = sanitize(args.estimate);
  const dailyBudget = Number.isNaN(args.dailyBudget)
    ? 0
    : Math.max(0, args.dailyBudget);

  const remainingUsd = Number.isFinite(dailyBudget)
    ? Math.max(0, dailyBudget - spentToday)
    : UNLIMITED_BUDGET;

  if (!Number.isFinite(dailyBudget)) {
    return {
      allowed: true,
      reason: null,
      spentToday,
      dailyBudget,
      estimate,
      remainingUsd,
    };
  }

  const allowed = spentToday + estimate <= dailyBudget + EPSILON_USD;

  return {
    allowed,
    reason: allowed
      ? null
      : `Daily AI budget reached: ${usd(spentToday)} of ${usd(dailyBudget)} spent today, and this request is estimated at ${usd(estimate)}. It resets at midnight UTC — or raise the limit in Settings.`,
    spentToday,
    dailyBudget,
    estimate,
    remainingUsd,
  };
}

/**
 * Today's date in UTC as `YYYY-MM-DD`, the key of `usage_daily`.
 *
 * UTC, not local time, so the boundary is the same for the web app on Vercel,
 * the CLI on a laptop and GitHub Actions — three clocks that would otherwise
 * disagree about which day a call belongs to.
 */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Read the user's cap and what they have already spent today. */
export async function getBudgetState(
  db: Db,
  userId: string,
): Promise<BudgetState> {
  const [profile] = await db
    .select({ dailyBudgetUsd: profiles.dailyBudgetUsd })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);

  const [usage] = await db
    .select({ costUsd: usageDaily.costUsd, calls: usageDaily.calls })
    .from(usageDaily)
    .where(and(eq(usageDaily.userId, userId), eq(usageDaily.date, todayUtc())))
    .limit(1);

  const parsedBudget = Number(profile?.dailyBudgetUsd);

  return {
    dailyBudget: Number.isFinite(parsedBudget)
      ? parsedBudget
      : DEFAULT_DAILY_BUDGET_USD,
    spentToday: sanitize(Number(usage?.costUsd)),
    calls: usage?.calls ?? 0,
  };
}

/**
 * Should this user be allowed to spend `estimateUsd` right now?
 *
 * `userId === null` (owner CLI / eval) short-circuits without touching the DB.
 */
export async function checkBudget(
  db: Db,
  userId: string | null,
  estimateUsd: number,
): Promise<BudgetDecision> {
  if (userId === null) {
    return decideBudget({
      spentToday: 0,
      dailyBudget: UNLIMITED_BUDGET,
      estimate: estimateUsd,
    });
  }

  const state = await getBudgetState(db, userId);
  return decideBudget({
    spentToday: state.spentToday,
    dailyBudget: state.dailyBudget,
    estimate: estimateUsd,
  });
}

/**
 * Add a completed call's cost to today's running total.
 *
 * A single upsert rather than read-modify-write: two concurrent calls for the
 * same user must both land, and `ON CONFLICT … SET cost_usd = usage_daily.cost_usd
 * + excluded` makes that atomic in Postgres.
 *
 * No-op for the null user (nothing to charge) and for a genuinely empty write.
 */
export async function recordUsage(
  db: Db,
  userId: string | null,
  costUsd: number,
  calls = 1,
): Promise<void> {
  if (userId === null) return;

  const amount = sanitize(costUsd);
  const callCount = Math.max(0, Math.trunc(calls));
  if (amount === 0 && callCount === 0) return;

  const cost = amount.toFixed(COST_DECIMALS);

  await db
    .insert(usageDaily)
    .values({
      userId,
      date: todayUtc(),
      costUsd: cost,
      calls: callCount,
    })
    .onConflictDoUpdate({
      target: [usageDaily.userId, usageDaily.date],
      set: {
        costUsd: sql`${usageDaily.costUsd} + ${cost}::numeric`,
        calls: sql`${usageDaily.calls} + ${callCount}`,
      },
    });
}
