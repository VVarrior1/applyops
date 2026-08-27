import { describe, it, expect } from "vitest";
import { profiles, usageDaily } from "../../src/db/schema";
import type { Db } from "../../src/db/client";
import {
  BudgetExceededError,
  UNLIMITED_BUDGET,
  checkBudget,
  decideBudget,
  getBudgetState,
  recordUsage,
  todayUtc,
} from "../../src/llm/budget";

/**
 * Minimal stand-in for the two drizzle call shapes budget.ts uses:
 *   db.select({...}).from(t).where(...).limit(1)
 *   db.insert(t).values({...}).onConflictDoUpdate({...})
 * Rows are chosen by the table passed to .from(), so both selects in
 * getBudgetState() can be answered by one fake.
 */
function fakeDb(rows: {
  profiles?: Record<string, unknown>[];
  usageDaily?: Record<string, unknown>[];
}) {
  const inserts: { table: unknown; values: Record<string, unknown> }[] = [];
  const db = {
    select() {
      let picked: Record<string, unknown>[] = [];
      const q = {
        from(table: unknown) {
          picked =
            table === profiles
              ? (rows.profiles ?? [])
              : table === usageDaily
                ? (rows.usageDaily ?? [])
                : [];
          return q;
        },
        where: () => q,
        limit: async () => picked,
      };
      return q;
    },
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown>) {
          inserts.push({ table, values });
          return {
            onConflictDoUpdate: async () => undefined,
          };
        },
      };
    },
  };
  return { db: db as unknown as Db, inserts };
}

describe("decideBudget", () => {
  it("blocks a call that would push the day over budget", () => {
    const d = decideBudget({ spentToday: 0.95, dailyBudget: 1.0, estimate: 0.1 });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBeTruthy();
  });

  it("allows a call that still fits inside the budget", () => {
    const d = decideBudget({
      spentToday: 0.95,
      dailyBudget: 1.0,
      estimate: 0.04,
    });
    expect(d.allowed).toBe(true);
    expect(d.reason).toBeNull();
  });

  it("allows a call that lands exactly on the budget", () => {
    expect(
      decideBudget({ spentToday: 0.95, dailyBudget: 1.0, estimate: 0.05 })
        .allowed,
    ).toBe(true);
  });

  it("is not tripped by binary floating point noise", () => {
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE-754
    expect(
      decideBudget({ spentToday: 0.1, dailyBudget: 0.3, estimate: 0.2 })
        .allowed,
    ).toBe(true);
  });

  it("blocks everything when the daily budget is zero", () => {
    expect(
      decideBudget({ spentToday: 0, dailyBudget: 0, estimate: 0.0001 })
        .allowed,
    ).toBe(false);
  });

  it("allows anything when the budget is unlimited", () => {
    expect(
      decideBudget({
        spentToday: 999,
        dailyBudget: UNLIMITED_BUDGET,
        estimate: 999,
      }).allowed,
    ).toBe(true);
  });

  it("reports the remaining headroom", () => {
    const d = decideBudget({
      spentToday: 0.25,
      dailyBudget: 1.0,
      estimate: 0.05,
    });
    expect(d.remainingUsd).toBeCloseTo(0.75, 9);
    expect(d.spentToday).toBe(0.25);
    expect(d.dailyBudget).toBe(1.0);
    expect(d.estimate).toBe(0.05);
  });

  it("treats a negative or non-finite estimate as zero", () => {
    expect(
      decideBudget({ spentToday: 1.0, dailyBudget: 1.0, estimate: -5 }).allowed,
    ).toBe(true);
    expect(
      decideBudget({ spentToday: 1.0, dailyBudget: 1.0, estimate: NaN }).allowed,
    ).toBe(true);
  });

  it("does not leak an email or any identifier into the reason string", () => {
    const d = decideBudget({ spentToday: 2, dailyBudget: 1, estimate: 0.5 });
    expect(d.reason).not.toContain("@");
  });

  it("does not render a real sub-cent estimate as $0.00", () => {
    const d = decideBudget({
      spentToday: 1.0,
      dailyBudget: 1.0,
      estimate: 0.0075,
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("$0.0075");
    expect(d.reason).toContain("$1.00");
  });
});

describe("todayUtc", () => {
  it("formats as YYYY-MM-DD in UTC", () => {
    expect(todayUtc(new Date("2026-08-27T23:59:59.000Z"))).toBe("2026-08-27");
    expect(todayUtc(new Date("2026-01-01T00:00:00.000Z"))).toBe("2026-01-01");
  });
});

describe("getBudgetState", () => {
  it("reads the profile budget and today's spend", async () => {
    const { db } = fakeDb({
      profiles: [{ dailyBudgetUsd: "1.50" }],
      usageDaily: [{ costUsd: "0.250000", calls: 3 }],
    });
    expect(await getBudgetState(db, "user-1")).toEqual({
      dailyBudget: 1.5,
      spentToday: 0.25,
      calls: 3,
    });
  });

  it("falls back to the default budget and zero spend for a fresh user", async () => {
    const { db } = fakeDb({});
    expect(await getBudgetState(db, "user-1")).toEqual({
      dailyBudget: 1.0,
      spentToday: 0,
      calls: 0,
    });
  });
});

describe("checkBudget", () => {
  it("bypasses the budget entirely for the null (owner CLI / eval) user", async () => {
    const { db } = fakeDb({ profiles: [{ dailyBudgetUsd: "0.00" }] });
    const d = await checkBudget(db, null, 5);
    expect(d.allowed).toBe(true);
    expect(d.dailyBudget).toBe(UNLIMITED_BUDGET);
  });

  it("blocks a real user who is over budget", async () => {
    const { db } = fakeDb({
      profiles: [{ dailyBudgetUsd: "1.00" }],
      usageDaily: [{ costUsd: "0.950000", calls: 12 }],
    });
    expect((await checkBudget(db, "user-1", 0.1)).allowed).toBe(false);
    expect((await checkBudget(db, "user-1", 0.04)).allowed).toBe(true);
  });
});

describe("recordUsage", () => {
  it("upserts a usage_daily row with the cost as a 6-decimal string", async () => {
    const { db, inserts } = fakeDb({});
    await recordUsage(db, "user-1", 0.0071234567);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].table).toBe(usageDaily);
    expect(inserts[0].values).toMatchObject({
      userId: "user-1",
      date: todayUtc(),
      costUsd: "0.007123",
      calls: 1,
    });
  });

  it("does nothing for the null user", async () => {
    const { db, inserts } = fakeDb({});
    await recordUsage(db, null, 1.23);
    expect(inserts).toHaveLength(0);
  });

  it("does nothing for a zero-cost, zero-call write", async () => {
    const { db, inserts } = fakeDb({});
    await recordUsage(db, "user-1", 0, 0);
    expect(inserts).toHaveLength(0);
  });
});

describe("BudgetExceededError", () => {
  it("is an LlmError with code budget_exceeded and HTTP 429 semantics", () => {
    const err = new BudgetExceededError("over budget", {
      allowed: false,
      reason: "over budget",
      spentToday: 1,
      dailyBudget: 1,
      estimate: 0.1,
      remainingUsd: 0,
    });
    expect(err.code).toBe("budget_exceeded");
    expect(err.status).toBe(429);
    expect(err.decision.spentToday).toBe(1);
  });
});
