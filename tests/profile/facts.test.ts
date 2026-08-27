import { describe, it, expect } from "vitest";
import {
  applications,
  approvals,
  generations,
  jobScores,
  jobs,
  outcomeEvents,
  profileFacts,
  profiles,
  searchPrefs,
  usageDaily,
} from "../../src/db/schema";
import type { Db } from "../../src/db/client";
import {
  deleteFact,
  deleteUserData,
  formatFactLabel,
  getConfirmedFacts,
  getPrefs,
  labelFacts,
  listFactRecords,
  maxFactLabelNumber,
  upsertFacts,
  upsertPrefs,
} from "../../src/profile/facts";

describe("formatFactLabel / maxFactLabelNumber", () => {
  it("zero-pads to three digits", () => {
    expect(formatFactLabel(4)).toBe("F-004");
    expect(formatFactLabel(14)).toBe("F-014");
    expect(formatFactLabel(1000)).toBe("F-1000");
  });

  it("finds the highest numeric suffix, ignoring malformed labels", () => {
    expect(maxFactLabelNumber(["F-001", "F-014", "F-003"])).toBe(14);
    expect(maxFactLabelNumber([])).toBe(0);
    expect(maxFactLabelNumber(["not-a-label", "F-abc"])).toBe(0);
  });
});

describe("labelFacts", () => {
  it("labels F-004, F-005 for labelFacts(3, [{text:'x'},{text:'y'}])", () => {
    const result = labelFacts(3, [{ text: "x" }, { text: "y" }]);
    expect(result.map((f) => f.label)).toEqual(["F-004", "F-005"]);
  });

  it("preserves every other field on the input", () => {
    const result = labelFacts(0, [{ text: "Built X", category: "project" }]);
    expect(result[0]).toEqual({ text: "Built X", category: "project", label: "F-001" });
  });

  it("starts from F-001 when existingMax is 0", () => {
    const result = labelFacts(0, [{ text: "a" }]);
    expect(result[0].label).toBe("F-001");
  });
});

// ---------------------------------------------------------------------------
// A minimal fake drizzle surface, in the style established by
// tests/llm/call.test.ts and tests/pipeline/steps.test.ts: `.where()` is a
// pass-through (tests seed exactly the rows a call should see), and
// `insert()`/`delete()`/`update()` just record what they were asked to do.
// ---------------------------------------------------------------------------

function fakeFactsDb(seed: { existingLabels?: string[] } = {}) {
  const upserted: Record<string, unknown>[] = [];
  const deletedLabels: string[] = [];
  // Tracks every label that has ever been successfully written, so
  // `onConflictDoNothing` can simulate a real unique-index collision (used
  // by the "does not overwrite on a label collision" test below).
  const labels = new Set(seed.existingLabels ?? []);

  const db = {
    select() {
      const rows = [...labels].map((label) => ({ label }));
      const q = {
        from: () => q,
        where: () => q,
        orderBy: () => q,
        limit: async () => rows,
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve),
      };
      return q;
    },
    insert() {
      return {
        values(values: Record<string, unknown>) {
          return {
            onConflictDoUpdate(opts: { set: Record<string, unknown> }) {
              const merged = { ...values, ...opts.set };
              upserted.push(merged);
              labels.add(merged.label as string);
              return {
                returning: async () => [
                  {
                    label: merged.label,
                    category: merged.category,
                    text: merged.text,
                    source: merged.source,
                    confirmed: merged.confirmed,
                  },
                ],
              };
            },
            onConflictDoNothing() {
              return {
                returning: async () => {
                  // A real unique-index conflict: the label was already
                  // taken (by a "concurrent" writer in the test, or by an
                  // earlier call in this same batch) — insert is a no-op,
                  // matching real Postgres `ON CONFLICT DO NOTHING`.
                  if (labels.has(values.label as string)) return [];
                  labels.add(values.label as string);
                  upserted.push(values);
                  return [
                    {
                      label: values.label,
                      category: values.category,
                      text: values.text,
                      source: values.source,
                      confirmed: values.confirmed,
                    },
                  ];
                },
              };
            },
          };
        },
      };
    },
    delete() {
      return {
        where: async () => {
          // deleteFact's where() carries the label being removed; the fake
          // can't introspect the drizzle condition object, so the label is
          // recorded by the caller in the test instead where needed.
          deletedLabels.push("(deleted)");
          return [];
        },
      };
    },
  };

  return { db: db as unknown as Db, upserted, deletedLabels };
}

describe("upsertFacts", () => {
  it("assigns new labels continuing from the user's current max", async () => {
    const { db, upserted } = fakeFactsDb({ existingLabels: ["F-001", "F-003"] });

    const saved = await upsertFacts(db, "user-1", [
      { category: "project", text: "Shipped a thing" },
      { category: "skill", text: "TypeScript" },
    ]);

    expect(saved.map((f) => f.label)).toEqual(["F-004", "F-005"]);
    expect(upserted).toHaveLength(2);
    expect(upserted[0]).toMatchObject({ confirmed: true, source: "manual" });
  });

  it("updates in place when a fact already carries a label", async () => {
    const { db, upserted } = fakeFactsDb({ existingLabels: ["F-001"] });

    const saved = await upsertFacts(db, "user-1", [
      { label: "F-001", category: "skill", text: "Edited text" },
    ]);

    expect(saved).toEqual([
      { label: "F-001", category: "skill", text: "Edited text", source: "manual", confirmed: true },
    ]);
    expect(upserted).toHaveLength(1);
  });

  it("returns [] for an empty batch without touching the database", async () => {
    const { db, upserted } = fakeFactsDb();
    const saved = await upsertFacts(db, "user-1", []);
    expect(saved).toEqual([]);
    expect(upserted).toHaveLength(0);
  });

  it("marks resume-sourced facts with source='resume_upload' when given", async () => {
    const { db, upserted } = fakeFactsDb();
    await upsertFacts(db, "user-1", [
      { category: "experience", text: "Did a thing", source: "resume_upload" },
    ]);
    expect(upserted[0]).toMatchObject({ source: "resume_upload" });
  });

  it("retries onto the next free label instead of overwriting when a concurrent writer already took the computed one", async () => {
    // Seed F-001..F-003 as already taken, as if a concurrent request wrote
    // F-004 the instant after this batch's up-front SELECT read max=3 —
    // upsertFacts's first attempt at F-004 must collide (onConflictDoNothing
    // returns no row) and retry at F-005, not silently overwrite F-004.
    const { db, upserted } = fakeFactsDb({ existingLabels: ["F-001", "F-002", "F-003", "F-004"] });

    const saved = await upsertFacts(db, "user-1", [{ category: "skill", text: "Rust" }]);

    expect(saved.map((f) => f.label)).toEqual(["F-005"]);
    // F-004 was never touched by this call — only F-005 was actually inserted.
    expect(upserted).toHaveLength(1);
    expect(upserted[0]).toMatchObject({ label: "F-005" });
  });

  it("preserves input order across a mixed batch of edits and new facts", async () => {
    const { db } = fakeFactsDb({ existingLabels: ["F-001"] });

    const saved = await upsertFacts(db, "user-1", [
      { label: "F-001", category: "skill", text: "Edited" },
      { category: "project", text: "New one" },
    ]);

    expect(saved.map((f) => f.label)).toEqual(["F-001", "F-002"]);
  });
});

function fakeReadDb(rows: Record<string, unknown>[]) {
  const db = {
    select() {
      const q = {
        from: () => q,
        where: () => q,
        orderBy: () => q,
        limit: async () => rows,
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve),
      };
      return q;
    },
  };
  return db as unknown as Db;
}

describe("getConfirmedFacts", () => {
  it("returns rows in {label, category, text} shape", async () => {
    const db = fakeReadDb([
      { label: "F-001", category: "experience", text: "Built payment APIs" },
    ]);
    const facts = await getConfirmedFacts(db, "user-1");
    expect(facts).toEqual([{ label: "F-001", category: "experience", text: "Built payment APIs" }]);
  });
});

describe("listFactRecords", () => {
  it("returns rows with source and confirmed included", async () => {
    const db = fakeReadDb([
      { label: "F-001", category: "skill", text: "TypeScript", source: "manual", confirmed: true },
    ]);
    const facts = await listFactRecords(db, "user-1");
    expect(facts).toEqual([
      { label: "F-001", category: "skill", text: "TypeScript", source: "manual", confirmed: true },
    ]);
  });
});

describe("getPrefs", () => {
  it("returns null when the user has no search_prefs row", async () => {
    const db = fakeReadDb([]);
    expect(await getPrefs(db, "user-1")).toBeNull();
  });

  it("returns the row when one exists", async () => {
    const db = fakeReadDb([{ userId: "user-1", remote: "remote" }]);
    expect(await getPrefs(db, "user-1")).toEqual({ userId: "user-1", remote: "remote" });
  });
});

describe("upsertPrefs", () => {
  it("fills in defaults for omitted fields", async () => {
    let captured: Record<string, unknown> | undefined;
    const db = {
      insert() {
        return {
          values(values: Record<string, unknown>) {
            captured = values;
            return {
              onConflictDoUpdate: () => ({ returning: async () => [values] }),
            };
          },
        };
      },
    } as unknown as Db;

    const saved = await upsertPrefs(db, "user-1", { roles: ["SWE"] });

    expect(captured).toMatchObject({
      userId: "user-1",
      roles: ["SWE"],
      locations: [],
      remote: "any",
      seniority: [],
      workAuth: null,
      keywords: [],
      excludedCompanies: [],
    });
    expect(saved).toBe(captured);
  });
});

describe("deleteFact", () => {
  it("returns true when a row was removed, false otherwise", async () => {
    const removed = {
      db: {
        delete: () => ({ where: () => ({ returning: async () => [{ label: "F-001" }] }) }),
      } as unknown as Db,
    };
    expect(await deleteFact(removed.db, "user-1", "F-001")).toBe(true);

    const notFound = {
      db: { delete: () => ({ where: () => ({ returning: async () => [] }) }) } as unknown as Db,
    };
    expect(await deleteFact(notFound.db, "user-1", "F-999")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deleteUserData: order matters (children before parents), and
// `jobs.analysis_generation_id` must be nulled before the generation it
// points at is deleted — assert the exact operation sequence.
// ---------------------------------------------------------------------------

function fakeDeleteDb(seed: {
  applicationRows?: { id: string }[];
  generationRows?: { id: string }[];
}) {
  const log: string[] = [];
  const rowsByTable = new Map<unknown, Record<string, unknown>[]>([
    [applications, seed.applicationRows ?? []],
    [generations, seed.generationRows ?? []],
  ]);
  const nameByTable = new Map<unknown, string>([
    [applications, "applications"],
    [approvals, "approvals"],
    [outcomeEvents, "outcome_events"],
    [jobScores, "job_scores"],
    [usageDaily, "usage_daily"],
    [generations, "generations"],
    [jobs, "jobs"],
    [profileFacts, "profile_facts"],
    [searchPrefs, "search_prefs"],
    [profiles, "profiles"],
  ]);

  const db = {
    select() {
      let picked: Record<string, unknown>[] = [];
      const q = {
        from(table: unknown) {
          picked = rowsByTable.get(table) ?? [];
          return q;
        },
        where: () => q,
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(picked).then(resolve),
      };
      return q;
    },
    delete(table: unknown) {
      return {
        where: async () => {
          log.push(`delete:${nameByTable.get(table)}`);
          return [];
        },
      };
    },
    update(table: unknown) {
      return {
        set: () => ({
          where: async () => {
            log.push(`update:${nameByTable.get(table)}`);
            return [];
          },
        }),
      };
    },
    // deleteUserData wraps its DB work in `db.transaction(async (tx) => …)`.
    // The fake has no real BEGIN/COMMIT semantics to model — it just runs
    // the callback against itself, which is enough to exercise the delete
    // order the real transaction body issues its statements in.
    async transaction(fn: (tx: unknown) => Promise<void>) {
      return fn(db);
    },
  };

  return { db: db as unknown as Db, log };
}

describe("deleteUserData", () => {
  it("deletes application-dependent rows, nulls stale job→generation links, then deletes generations and the profile — in that order", async () => {
    const { db, log } = fakeDeleteDb({
      applicationRows: [{ id: "app-1" }],
      generationRows: [{ id: "gen-1" }],
    });
    const storageLog: string[] = [];

    await deleteUserData(db, "user-1", {
      _internal: {
        deleteResumeObjects: async () => {
          storageLog.push("storage:deleteAll");
        },
      },
    });

    expect(log).toEqual([
      "delete:approvals",
      "delete:outcome_events",
      "delete:applications",
      "delete:job_scores",
      "delete:usage_daily",
      "update:jobs",
      "delete:generations",
      "delete:profile_facts",
      "delete:search_prefs",
      "delete:profiles",
    ]);
    expect(storageLog).toEqual(["storage:deleteAll"]);
  });

  it("skips the applications/approvals/outcome_events branch when the user has no applications", async () => {
    const { db, log } = fakeDeleteDb({ applicationRows: [], generationRows: [] });

    await deleteUserData(db, "user-1", { _internal: { deleteResumeObjects: async () => {} } });

    expect(log).toEqual([
      "delete:job_scores",
      "delete:usage_daily",
      "delete:generations",
      "delete:profile_facts",
      "delete:search_prefs",
      "delete:profiles",
    ]);
  });

  it("runs the storage cleanup before touching the database, and aborts the whole deletion (no DB row touched) when it fails", async () => {
    const { db, log } = fakeDeleteDb({ applicationRows: [], generationRows: [] });

    await expect(
      deleteUserData(db, "user-1", {
        _internal: {
          deleteResumeObjects: async () => {
            throw new Error("storage is down");
          },
        },
      }),
    ).rejects.toThrow("storage is down");

    // Nothing in Postgres was touched — the account is fully intact for a
    // retry, rather than half-deleted with an orphaned resume left behind.
    expect(log).toEqual([]);
  });

  it("still deletes everything when the storage cleanup succeeds", async () => {
    const { db, log } = fakeDeleteDb({ applicationRows: [], generationRows: [] });
    const storageLog: string[] = [];

    await deleteUserData(db, "user-1", {
      _internal: {
        deleteResumeObjects: async () => {
          storageLog.push("storage:deleteAll");
        },
      },
    });

    expect(storageLog).toEqual(["storage:deleteAll"]);
    expect(log).toContain("delete:profiles");
  });
});
