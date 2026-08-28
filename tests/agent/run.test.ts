import { describe, it, expect } from "vitest";
import { applications, outcomeEvents } from "../../src/db/schema";
import type { Db } from "../../src/db/client";
import { ApplyError, applyToApplication, _internal } from "../../src/agent/run";
import { buildApplicantData } from "../../src/agent/ats-fastpath";

/**
 * The two safety-relevant behaviours of `src/agent/run.ts` that do not need a
 * browser: the owner-only guard in `loadApplication`, and `recordOutcome`'s
 * rule that only a status of `applied` is allowed to move the application
 * forward. Everything else in that module drives Playwright and is covered by
 * a live dry run instead.
 *
 * The fake stands in for the drizzle call shapes run.ts actually uses:
 *   db.select({...}).from(t).innerJoin(...)×3.where(...).limit(1)
 *   db.update(t).set({...}).where(...)
 *   db.insert(t).values({...})
 */
function fakeDb(rows: Record<string, unknown>[]) {
  const updates: { table: unknown; values: Record<string, unknown> }[] = [];
  const inserts: { table: unknown; values: Record<string, unknown> }[] = [];
  const db = {
    select() {
      const q = {
        from: () => q,
        innerJoin: () => q,
        where: () => q,
        limit: async () => rows,
      };
      return q;
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where: async () => {
              updates.push({ table, values });
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values: async (values: Record<string, unknown>) => {
          inserts.push({ table, values });
        },
      };
    },
  };
  return { db: db as unknown as Db, updates, inserts };
}

const ownerRow = {
  userId: "user-1",
  resumePdfPath: null,
  jobUrl: "https://job-boards.greenhouse.io/acme/jobs/1",
  jobTitle: "Backend Engineer",
  jobLocation: "Calgary, AB",
  jobRemote: false,
  companyName: "Acme",
  isOwner: true,
  contact: { fullName: "Ada Lovelace", email: "ada@example.test" },
};

describe("applyToApplication — guards before the browser opens", () => {
  it("refuses an application that belongs to a non-owner profile", async () => {
    const { db } = fakeDb([{ ...ownerRow, isOwner: false }]);
    await expect(applyToApplication(db, "app-1")).rejects.toBeInstanceOf(ApplyError);
    await expect(applyToApplication(db, "app-1")).rejects.toThrow(/owner-only/);
  });

  it("refuses an application id that does not exist", async () => {
    const { db } = fakeDb([]);
    await expect(applyToApplication(db, "nope")).rejects.toThrow(/No application nope/);
  });
});

describe("assertApplicable — the contact gate before the browser opens", () => {
  const real = {
    name: "Ada Lovelace",
    email: "ada.lovelace@gmail.com",
    phone: "(587) 891-6940",
    links: ["https://github.com/adalovelace"],
  };
  const dataFor = (contact: Record<string, unknown>) =>
    buildApplicantData({ contact: contact as never, prefs: null });

  it("lets a real contact block through", () => {
    expect(() => _internal.assertApplicable(dataFor(real), real as never)).not.toThrow();
  });

  it("still reports a missing name or email first", () => {
    const noEmail = { ...real, email: "" };
    expect(() => _internal.assertApplicable(dataFor(noEmail), noEmail as never)).toThrow(
      /Profile is missing email/,
    );
  });

  /**
   * The QA row itself. This path *submits* to a real employer, so placeholder
   * identity has to fail before Playwright launches — not get typed into a
   * form and clicked through.
   */
  it("refuses the seed identity QA found in the owner's row", () => {
    const seed = {
      name: "ApplyOps Test Resume",
      email: "candidate@example.com",
      phone: "555-0100",
      links: ["github.com/example-candidate"],
    };
    expect(() => _internal.assertApplicable(dataFor(seed), seed as never)).toThrow(ApplyError);
    expect(() => _internal.assertApplicable(dataFor(seed), seed as never)).toThrow(
      /placeholder|aren't application-ready/i,
    );
  });

  it("refuses a placeholder that hides behind a real-looking name", () => {
    const sneaky = { ...real, email: "candidate@example.com" };
    expect(() => _internal.assertApplicable(dataFor(sneaky), sneaky as never)).toThrow(ApplyError);
  });
});

describe("recordOutcome", () => {
  it("writes the status and one outcome event for an applied run", async () => {
    const { db, updates, inserts } = fakeDb([]);
    await _internal.recordOutcome(db, "app-1", "applied");

    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe(applications);
    expect(updates[0].values).toEqual({ status: "applied" });

    expect(inserts).toHaveLength(1);
    expect(inserts[0].table).toBe(outcomeEvents);
    expect(inserts[0].values).toMatchObject({ applicationId: "app-1", type: "applied" });
  });

  it("writes nothing for a run that did not submit", async () => {
    for (const status of ["skipped", "needs_manual", "failed"] as const) {
      const { db, updates, inserts } = fakeDb([]);
      await _internal.recordOutcome(db, "app-1", status);
      expect(updates, status).toEqual([]);
      expect(inserts, status).toEqual([]);
    }
  });
});
