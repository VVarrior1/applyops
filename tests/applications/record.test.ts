import { describe, expect, it } from "vitest";
import { applications, outcomeEvents } from "../../src/db/schema";
import type { Db } from "../../src/db/client";
import { countsAsApplied } from "../../src/rank/candidates";
import { recordApplication } from "../../src/applications/record";

/**
 * A fake `Db` that models exactly one `applications` row (single user+job
 * pair), enough to exercise `recordApplication`'s insert-vs-reactivate
 * branches without a real Postgres connection — same style as
 * `fakeDeleteDb` in tests/profile/facts.test.ts.
 */
function fakeApplicationsDb() {
  let current: { id: string; status: string; tailorGenerationId: string | null } | null = null;
  const outcomeEventTypes: string[] = [];
  let nextId = 1;

  const db = {
    insert(table: unknown) {
      return {
        values(v: { status?: string; tailorGenerationId?: string | null; type?: string }) {
          if (table === applications) {
            return {
              onConflictDoNothing() {
                return {
                  async returning() {
                    if (current) return []; // unique-index conflict — existing row wins
                    current = {
                      id: `app-${nextId++}`,
                      status: v.status ?? "applied",
                      tailorGenerationId: v.tailorGenerationId ?? null,
                    };
                    return [{ id: current.id }];
                  },
                };
              },
            };
          }
          if (table === outcomeEvents) {
            outcomeEventTypes.push(v.type as string);
            return Promise.resolve([]);
          }
          throw new Error("fakeApplicationsDb: unexpected insert table");
        },
      };
    },
    select() {
      return {
        from(table: unknown) {
          return {
            where() {
              return {
                async limit() {
                  if (table === applications && current) {
                    return [{ id: current.id, status: current.status }];
                  }
                  return [];
                },
              };
            },
          };
        },
      };
    },
    update(table: unknown) {
      return {
        set(patch: Partial<{ status: string; tailorGenerationId: string | null }>) {
          return {
            async where() {
              if (table === applications && current) {
                current = { ...current, ...patch };
              }
              return [];
            },
          };
        },
      };
    },
    // recordApplication wraps its work in `db.transaction(async (tx) => …)`
    // — no real BEGIN/COMMIT semantics to model, just run the callback
    // against the same fake so the statement sequence is exercised.
    async transaction(fn: (tx: unknown) => Promise<unknown>) {
      return fn(db);
    },
  };

  return {
    db: db as unknown as Db,
    outcomeEventTypes,
    getCurrent: () => current,
  };
}

describe("recordApplication", () => {
  it("creates the row + founding applied event for a never-applied job", async () => {
    const { db, outcomeEventTypes, getCurrent } = fakeApplicationsDb();

    const result = await recordApplication(db, { userId: "user-1", jobId: "job-1" });

    expect(result.created).toBe(true);
    expect(getCurrent()?.status).toBe("applied");
    expect(outcomeEventTypes).toEqual(["applied"]);
  });

  it("a second apply on an already-applied job is an idempotent no-op (double-click/retry)", async () => {
    const { db, outcomeEventTypes } = fakeApplicationsDb();

    const first = await recordApplication(db, { userId: "user-1", jobId: "job-1" });
    const second = await recordApplication(db, { userId: "user-1", jobId: "job-1" });

    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    expect(outcomeEventTypes).toEqual(["applied"]); // no second event logged
  });

  it("apply -> withdraw -> re-apply reactivates the same row: status back to applied, job hidden from /jobs again", async () => {
    const { db, outcomeEventTypes, getCurrent } = fakeApplicationsDb();

    const first = await recordApplication(db, { userId: "user-1", jobId: "job-1" });
    expect(countsAsApplied(getCurrent()!.status)).toBe(true);

    // Simulate a withdrawal the way `logOutcome` (src/funnel/outcomes.ts)
    // would: a new `withdrawn` outcome_events row, status recomputed to
    // `withdrawn`. The job now reappears on /jobs (countsAsApplied: false).
    const withdrawn = getCurrent()!;
    withdrawn.status = "withdrawn";
    outcomeEventTypes.push("withdrawn");
    expect(countsAsApplied(withdrawn.status)).toBe(false);

    const second = await recordApplication(db, { userId: "user-1", jobId: "job-1" });

    // The round-trip this fix is for: re-applying must not silently no-op.
    expect(second.created).toBe(true);
    expect(second.id).toBe(first.id); // same row, reactivated — not a new one
    expect(getCurrent()?.status).toBe("applied");
    expect(countsAsApplied(getCurrent()!.status)).toBe(true); // hidden from /jobs again
    expect(outcomeEventTypes).toEqual(["applied", "withdrawn", "applied"]);

    // A further click after the re-apply is the idempotent no-op case again.
    const third = await recordApplication(db, { userId: "user-1", jobId: "job-1" });
    expect(third.created).toBe(false);
    expect(outcomeEventTypes).toEqual(["applied", "withdrawn", "applied"]);
  });

  it("reactivating also resets tailorGenerationId to the run that triggered the re-apply", async () => {
    const { db, getCurrent } = fakeApplicationsDb();

    await recordApplication(db, { userId: "user-1", jobId: "job-1", tailorGenerationId: "gen-old" });
    getCurrent()!.status = "withdrawn";

    await recordApplication(db, { userId: "user-1", jobId: "job-1", tailorGenerationId: "gen-new" });

    expect(getCurrent()?.tailorGenerationId).toBe("gen-new");
  });
});
