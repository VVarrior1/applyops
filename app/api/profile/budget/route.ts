import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireOwner } from "@/src/auth/require";
import { getDb } from "@/src/db/client";
import { profiles } from "@/src/db/schema";

// Sanity ceiling so a fat-fingered value can't wire up an unbounded daily
// LLM bill — spec §11's whole point is a spending cap, not a way to remove
// one. $100/day is generous headroom above the $1 default for the one
// person (the owner) allowed to raise it at all.
const MAX_DAILY_BUDGET_USD = 100;

const budgetBodySchema = z.object({
  dailyBudgetUsd: z.number().finite().min(0).max(MAX_DAILY_BUDGET_USD),
});

/**
 * `POST /api/profile/budget` — Settings' budget editor (plan Task 6 Step 4:
 * "daily budget (owner may edit)"). Owner-only: every other user's
 * `$1.00/day` default is an abuse control, not something they can raise
 * themselves. Edits only the caller's own `profiles.daily_budget_usd` — this
 * is not an admin panel for other users' budgets.
 */
export async function POST(request: Request) {
  const owner = await requireOwner();

  const parsed = budgetBodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: `Enter an amount between $0 and $${MAX_DAILY_BUDGET_USD}.` },
      { status: 400 },
    );
  }

  const db = getDb();
  const [row] = await db
    .update(profiles)
    .set({ dailyBudgetUsd: parsed.data.dailyBudgetUsd.toFixed(2) })
    .where(eq(profiles.userId, owner.id))
    .returning({ dailyBudgetUsd: profiles.dailyBudgetUsd });

  return NextResponse.json({ dailyBudgetUsd: row.dailyBudgetUsd });
}
