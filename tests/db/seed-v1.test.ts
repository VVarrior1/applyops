import { describe, expect, it } from "vitest";
import { applications, outcomeEvents } from "../../src/db/schema";
import { seedApplications, type Db, type V1ApplicationRow, type V1JobRow } from "../../src/db/seed-v1";

/**
 * A fake `Db` modelling exactly one (user, job) `applications` row — enough
 * to exercise `seedApplications`'s (userId, jobId) dedupe without a real
 * Postgres connection. Same style as `fakeApplicationsDb`
 * (tests/applications/record.test.ts): `.where()` ignores its actual
 * condition and just reads back whatever `current` holds, since this test
 * only ever has one applications row in play.
 */
function fakeSeedDb() {
  let current: { id: string; status: string } | null = null;
  const outcomeEventTypes: string[] = [];
  let nextId = 1;

  const db = {
    select() {
      return {
        from(table: unknown) {
          return {
            where() {
              return {
                async limit() {
                  if (table === applications && current) return [{ id: current.id }];
                  return [];
                },
              };
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values(v: Record<string, unknown>) {
          if (table === applications) {
            return {
              async returning() {
                current = { id: `app-${nextId++}`, status: v.status as string };
                return [{ id: current.id }];
              },
            };
          }
          if (table === outcomeEvents) {
            outcomeEventTypes.push(v.type as string);
            return Promise.resolve([]);
          }
          throw new Error("fakeSeedDb: unexpected insert table");
        },
      };
    },
  };

  return { db: db as unknown as Db, outcomeEventTypes, getCurrent: () => current };
}

function v1AppRow(overrides: Partial<V1ApplicationRow> = {}): V1ApplicationRow {
  return {
    id: "csv-app-1",
    job_id: "v1-job-1",
    tailored_summary: "",
    tailored_skills: "",
    created_at: "2025-01-01T00:00:00Z",
    pdf_path: "",
    ...overrides,
  };
}

function v1JobRow(overrides: Partial<V1JobRow> = {}): V1JobRow {
  return {
    id: "v1-job-1",
    url: "https://example.com/job",
    title: "Software Engineer",
    company: "Acme",
    location: "Remote",
    remote: "true",
    description: "",
    source: "test",
    scraped_at: "2025-01-01T00:00:00Z",
    posted_at: "2025-01-01T00:00:00Z",
    priority_score: "",
    status: "applied",
    applied_at: "",
    notes: "",
    analysis: "",
    ...overrides,
  };
}

describe("seedApplications", () => {
  it("two applications.csv rows for the same job_id produce exactly one applications row (v1 logged one row per resume regeneration, not per real application)", async () => {
    const { db, outcomeEventTypes, getCurrent } = fakeSeedDb();
    // Job already resolved (job-db-1) so the orphan-placeholder branch never
    // runs — this test is about the (userId, jobId) dedupe, not orphans.
    const v1JobIdToDbId = new Map([["v1-job-1", "job-db-1"]]);
    const v1JobIdToRow = new Map([["v1-job-1", v1JobRow()]]);

    const appRows = [
      v1AppRow({ id: "csv-app-1", created_at: "2025-01-01T00:00:00Z" }),
      v1AppRow({ id: "csv-app-2", created_at: "2025-01-02T00:00:00Z" }), // a later resume regeneration of the same application
    ];

    const result = await seedApplications(db, {
      ownerId: "owner-1",
      appRows,
      v1JobIdToRow,
      v1JobIdToDbId,
      companyCache: new Map(),
    });

    expect(result.applicationsCreated).toBe(1);
    expect(getCurrent()).not.toBeNull();
    // One founding `applied` event, not two — the second CSV row was
    // skipped entirely, not merged/updated.
    expect(outcomeEventTypes).toEqual(["applied"]);
  });

  it("skips a row missing id/job_id without creating anything", async () => {
    const { db, outcomeEventTypes } = fakeSeedDb();

    const result = await seedApplications(db, {
      ownerId: "owner-1",
      appRows: [v1AppRow({ job_id: "" })],
      v1JobIdToRow: new Map(),
      v1JobIdToDbId: new Map(),
      companyCache: new Map(),
    });

    expect(result.applicationsCreated).toBe(0);
    expect(outcomeEventTypes).toEqual([]);
  });
});
