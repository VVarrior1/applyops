import { describe, it, expect } from "vitest";
import { applications, jobs, outcomeEvents } from "../../src/db/schema";
import type { Db } from "../../src/db/client";
import {
  normalizeJobUrl,
  detectAtsSource,
  extractJsonLdJobPosting,
  extractHtmlMeta,
  createManualApplication,
  type PostingDetailsResult,
} from "../../src/funnel/manual-application";

// ---------------------------------------------------------------------------
// normalizeJobUrl
// ---------------------------------------------------------------------------

describe("normalizeJobUrl", () => {
  it("strips utm_* query params", () => {
    expect(normalizeJobUrl("https://boards.greenhouse.io/acme/jobs/1?utm_source=li&utm_medium=social")).toBe(
      "https://boards.greenhouse.io/acme/jobs/1",
    );
  });

  it("strips the fragment", () => {
    expect(normalizeJobUrl("https://example.com/job/1#apply-section")).toBe("https://example.com/job/1");
  });

  it("keeps non-utm query params", () => {
    expect(normalizeJobUrl("https://example.com/job?utm_campaign=x&gh_jid=42")).toBe(
      "https://example.com/job?gh_jid=42",
    );
  });

  it("is a no-op for a URL with nothing to strip", () => {
    expect(normalizeJobUrl("https://jobs.lever.co/acme/abc-123")).toBe("https://jobs.lever.co/acme/abc-123");
  });

  it("strips both utm params and a fragment together", () => {
    expect(normalizeJobUrl("https://example.com/job?utm_source=x&ref=y#section")).toBe(
      "https://example.com/job?ref=y",
    );
  });
});

// ---------------------------------------------------------------------------
// detectAtsSource
// ---------------------------------------------------------------------------

describe("detectAtsSource", () => {
  it("matches boards.greenhouse.io", () => {
    expect(detectAtsSource("https://boards.greenhouse.io/stripe/jobs/7532733")).toEqual({
      vendor: "greenhouse",
      slug: "stripe",
      id: "7532733",
    });
  });

  it("matches job-boards.greenhouse.io (newer host)", () => {
    expect(detectAtsSource("https://job-boards.greenhouse.io/anthropic/jobs/6789")).toEqual({
      vendor: "greenhouse",
      slug: "anthropic",
      id: "6789",
    });
  });

  it("matches jobs.lever.co", () => {
    expect(detectAtsSource("https://jobs.lever.co/palantir/ac978161-6f46-4f6b-ad9e-a258e642751c")).toEqual({
      vendor: "lever",
      slug: "palantir",
      id: "ac978161-6f46-4f6b-ad9e-a258e642751c",
    });
  });

  it("matches jobs.lever.co with a trailing /apply segment", () => {
    expect(detectAtsSource("https://jobs.lever.co/palantir/ac978161-6f46-4f6b-ad9e-a258e642751c/apply")).toEqual({
      vendor: "lever",
      slug: "palantir",
      id: "ac978161-6f46-4f6b-ad9e-a258e642751c",
    });
  });

  it("matches jobs.ashbyhq.com", () => {
    expect(detectAtsSource("https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245")).toEqual({
      vendor: "ashby",
      slug: "ramp",
      id: "34413f8d-26bf-4bbc-8ade-eb309a0e2245",
    });
  });

  it("returns null for a non-ATS URL", () => {
    expect(detectAtsSource("https://example.com/careers/job/123")).toBeNull();
  });

  it("returns null for a malformed URL", () => {
    expect(detectAtsSource("not a url")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HTML / JSON-LD extraction
// ---------------------------------------------------------------------------

describe("extractJsonLdJobPosting", () => {
  it("extracts title/company/location/description from a JobPosting script tag", () => {
    const html = `<html><head>
      <script type="application/ld+json">
        {"@context":"https://schema.org","@type":"JobPosting","title":"Software Engineer",
         "hiringOrganization":{"@type":"Organization","name":"Acme Robotics"},
         "jobLocation":{"@type":"Place","address":{"addressLocality":"Toronto","addressRegion":"ON","addressCountry":"CA"}},
         "description":"<p>Build cool stuff.</p>"}
      </script>
      </head><body></body></html>`;

    expect(extractJsonLdJobPosting(html)).toEqual({
      title: "Software Engineer",
      company: "Acme Robotics",
      location: "Toronto, ON, CA",
      description: "Build cool stuff.",
    });
  });

  it("finds a JobPosting nested inside an @graph array", () => {
    const html = `<script type="application/ld+json">
      {"@graph":[{"@type":"WebPage","name":"Careers"},{"@type":"JobPosting","title":"Data Scientist","hiringOrganization":{"name":"Graphify"},"description":"Model things."}]}
    </script>`;

    expect(extractJsonLdJobPosting(html)).toEqual({
      title: "Data Scientist",
      company: "Graphify",
      location: null,
      description: "Model things.",
    });
  });

  it("returns null when there is no JobPosting JSON-LD", () => {
    const html = `<script type="application/ld+json">{"@type":"WebPage","name":"Careers"}</script>`;
    expect(extractJsonLdJobPosting(html)).toBeNull();
  });

  it("skips a malformed JSON-LD block instead of throwing", () => {
    const html = `<script type="application/ld+json">{not valid json</script>`;
    expect(extractJsonLdJobPosting(html)).toBeNull();
  });
});

describe("extractHtmlMeta", () => {
  it("reads og:title, og:site_name and og:description", () => {
    const html = `<html><head>
      <title>Ignored Title | Careers</title>
      <meta property="og:title" content="Senior Backend Engineer" />
      <meta property="og:site_name" content="Widgetco" />
      <meta property="og:description" content="Join our team &amp; build widgets." />
    </head><body></body></html>`;

    expect(extractHtmlMeta(html)).toEqual({
      title: "Senior Backend Engineer",
      company: "Widgetco",
      location: null,
      description: "Join our team & build widgets.",
    });
  });

  it("falls back to the plain <title> tag and meta description when there are no og: tags", () => {
    const html = `<html><head>
      <title>Frontend Developer at Smallco</title>
      <meta name="description" content="We are hiring a frontend developer.">
    </head><body></body></html>`;

    expect(extractHtmlMeta(html)).toEqual({
      title: "Frontend Developer at Smallco",
      company: null,
      location: null,
      description: "We are hiring a frontend developer.",
    });
  });

  it("returns all nulls for a page with no useful tags", () => {
    const html = `<html><head></head><body><p>Nothing here.</p></body></html>`;
    expect(extractHtmlMeta(html)).toEqual({ title: null, company: null, location: null, description: null });
  });
});

// ---------------------------------------------------------------------------
// createManualApplication — idempotency, with a mocked Db
// ---------------------------------------------------------------------------

/**
 * A fake `Db` modelling exactly one existing `jobs` row (so
 * `createManualApplication`'s "reuse the existing job" branch is always
 * taken and no network fetch or company upsert ever runs) and at most one
 * `applications` row for it — same single-row style as `fakeApplicationsDb`
 * in tests/applications/record.test.ts.
 */
function fakeManualDb(jobRow: { id: string; url: string }) {
  let application: { id: string; userId: string; jobId: string; status: string } | null = null;
  const events: Array<{ type: string; occurredAt: Date; notes?: string | null }> = [];
  let nextAppId = 1;

  const db = {
    select() {
      return {
        from(table: unknown) {
          return {
            where() {
              return {
                async limit() {
                  if (table === jobs) return [{ id: jobRow.id }];
                  if (table === applications && application) return [{ id: application.id }];
                  return [];
                },
                orderBy() {
                  return Promise.resolve(events.map((e) => ({ type: e.type, occurredAt: e.occurredAt })));
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
              onConflictDoNothing() {
                return {
                  async returning() {
                    if (application) return [];
                    application = {
                      id: `app-${nextAppId++}`,
                      userId: v.userId as string,
                      jobId: v.jobId as string,
                      status: (v.status as string) ?? "applied",
                    };
                    return [{ id: application.id }];
                  },
                };
              },
            };
          }
          if (table === outcomeEvents) {
            events.push({
              type: v.type as string,
              occurredAt: (v.occurredAt as Date) ?? new Date(),
              notes: (v.notes as string | null | undefined) ?? null,
            });
            return Promise.resolve([]);
          }
          throw new Error("fakeManualDb: unexpected insert table");
        },
      };
    },
    update(table: unknown) {
      return {
        set(patch: { status?: string }) {
          return {
            async where() {
              if (table === applications && application && patch.status) {
                application.status = patch.status;
              }
              return [];
            },
          };
        },
      };
    },
    async transaction(fn: (tx: unknown) => Promise<unknown>) {
      return fn(db);
    },
  };

  return {
    db: db as unknown as Db,
    getApplication: () => application,
    getEvents: () => events,
  };
}

/** Never called in these tests (the fake db always has the job pre-seeded,
 * so `createManualApplication` never reaches the "create a new job" /
 * fetch-details branch) — present only to satisfy the deps type and fail
 * loudly if that assumption ever breaks. */
const unusedFetchPostingDetails = async (): Promise<PostingDetailsResult> => {
  throw new Error("fetchPostingDetails should not be called when the job already exists");
};

describe("createManualApplication", () => {
  it("creates the application + founding applied event for a URL whose job already exists", async () => {
    const { db, getApplication, getEvents } = fakeManualDb({ id: "job-1", url: "https://example.com/job/1" });

    const result = await createManualApplication(
      db,
      "user-1",
      { url: "https://example.com/job/1" },
      { fetchPostingDetails: unusedFetchPostingDetails },
    );

    expect(result.existing).toBe(false);
    expect(getApplication()).toMatchObject({ jobId: "job-1", userId: "user-1", status: "applied" });
    expect(getEvents().map((e) => e.type)).toEqual(["applied"]);
  });

  it("a second call for the same (user, job) is idempotent: returns the existing row, no duplicate event", async () => {
    const { db, getEvents } = fakeManualDb({ id: "job-1", url: "https://example.com/job/1" });

    const first = await createManualApplication(
      db,
      "user-1",
      { url: "https://example.com/job/1" },
      { fetchPostingDetails: unusedFetchPostingDetails },
    );
    const second = await createManualApplication(
      db,
      "user-1",
      { url: "https://example.com/job/1?utm_source=resubmit" }, // same job after normalization
      { fetchPostingDetails: unusedFetchPostingDetails },
    );

    expect(second.existing).toBe(true);
    expect(second.id).toBe(first.id);
    expect(getEvents().map((e) => e.type)).toEqual(["applied"]); // no second event logged
  });

  it("a non-default status logs an extra outcome event and recomputes applications.status", async () => {
    const { db, getApplication, getEvents } = fakeManualDb({ id: "job-1", url: "https://example.com/job/1" });

    await createManualApplication(
      db,
      "user-1",
      { url: "https://example.com/job/1", status: "interviewing" },
      { fetchPostingDetails: unusedFetchPostingDetails },
    );

    expect(getEvents().map((e) => e.type)).toEqual(["applied", "interview"]);
    expect(getApplication()?.status).toBe("interviewing");
  });

  it("backdates the founding event to the given appliedAt and attaches notes", async () => {
    const { db, getEvents } = fakeManualDb({ id: "job-1", url: "https://example.com/job/1" });
    const appliedAt = new Date("2026-06-01T00:00:00Z");

    await createManualApplication(
      db,
      "user-1",
      { url: "https://example.com/job/1", appliedAt, notes: "found via a friend" },
      { fetchPostingDetails: unusedFetchPostingDetails },
    );

    expect(getEvents()[0]).toMatchObject({ occurredAt: appliedAt, notes: "found via a friend" });
  });
});
