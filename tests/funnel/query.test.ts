import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../src/db/schema";
import { attachFunnelEvents, buildOwnerApplicationRowsQuery, type OwnerApplicationRow } from "../../src/funnel/query";

/**
 * A disconnected `postgres-js` `drizzle()` instance — `postgres()` opens no
 * socket until a query actually runs, so this builds real SQL text via
 * `.toSQL()` without a live Postgres anywhere. Shared across this file's
 * tests and closed in `afterAll` so vitest doesn't warn about a leftover
 * handle.
 */
const client = postgres("postgres://fake:fake@127.0.0.1:1/fakedb", {
  prepare: false,
  connect_timeout: 1,
});
const disconnectedDb = drizzle(client, { schema });

afterAll(async () => {
  await client.end({ timeout: 0 });
});

/**
 * Regression test for the QA finding (Aug 2026): `/funnel` and the guide's
 * `loadUserFunnel` queried `applications` directly, with no join to `jobs`
 * and no `isPlaceholder` filter, so a v1-migration orphan application kept
 * inflating their counts after `/results` was fixed to exclude it. Asserts
 * against the real generated SQL — not a fake `Db` that would just
 * hard-code the same filter the code under test is supposed to apply, and
 * so could never catch it going missing again.
 */
describe("buildOwnerApplicationRowsQuery", () => {
  it("inner-joins jobs and filters is_placeholder = false", () => {
    const query = buildOwnerApplicationRowsQuery(disconnectedDb, "user-1");
    const { sql, params } = query.toSQL();

    expect(sql).toMatch(/inner join "jobs"/i);
    expect(sql).toMatch(/"jobs"\."is_placeholder" = \$\d+/);
    expect(sql).toContain('"applications"."user_id" = $1');
    expect(params).toEqual(["user-1", false]);
  });
});

describe("attachFunnelEvents", () => {
  function row(overrides: Partial<OwnerApplicationRow> = {}): OwnerApplicationRow {
    return {
      id: "app-1",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      jobId: "job-1",
      promptVersion: null,
      ...overrides,
    };
  }

  /** Fake `Db` for just the `outcome_events` select `attachFunnelEvents` issues. */
  function fakeEventsDb(events: { applicationId: string; type: string; occurredAt: Date }[]) {
    return {
      select() {
        return {
          from() {
            return { where: async () => events };
          },
        };
      },
    } as unknown as Parameters<typeof attachFunnelEvents>[0];
  }

  it("groups multiple events per application and preserves rows with none", async () => {
    const db = fakeEventsDb([
      { applicationId: "app-1", type: "applied", occurredAt: new Date("2026-01-01T00:00:00Z") },
      { applicationId: "app-1", type: "response", occurredAt: new Date("2026-01-05T00:00:00Z") },
    ]);
    const appRows = [row({ id: "app-1" }), row({ id: "app-2" })];

    const result = await attachFunnelEvents(db, appRows);

    expect(result.find((r) => r.id === "app-1")?.events.map((e) => e.type)).toEqual([
      "applied",
      "response",
    ]);
    expect(result.find((r) => r.id === "app-2")?.events).toEqual([]);
  });

  it("short-circuits with no query when appRows is empty", async () => {
    let queried = false;
    const db = {
      select() {
        queried = true;
        throw new Error("should not query outcome_events for an empty appRows");
      },
    } as unknown as Parameters<typeof attachFunnelEvents>[0];

    const result = await attachFunnelEvents(db, []);

    expect(result).toEqual([]);
    expect(queried).toBe(false);
  });
});
