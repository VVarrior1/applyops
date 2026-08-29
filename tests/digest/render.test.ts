import { describe, it, expect } from "vitest";
import { digestPayloadSchema, MAX_DIGEST_JOBS } from "@/src/digest/schema";
import { digestSubject, renderDigestHtml, renderDigestText } from "@/src/digest/render";

/** A minimal valid job; spread over it to vary one field at a time. */
function job(overrides: Record<string, unknown> = {}) {
  return {
    company: "Jobber",
    title: "Software Engineer I",
    url: "https://careers.getjobber.com/jobs/123",
    location: "Edmonton, AB · Hybrid",
    postedAt: "Posted today",
    summary: "Backend work on the scheduling service in TypeScript and Postgres.",
    whyYouQualify: ["Next.js/TypeScript at CYD Soccer Academy"],
    gaps: ["Asks for 2 years professional experience"],
    score: 78,
    ...overrides,
  };
}

function parse(jobs: unknown[], rest: Record<string, unknown> = {}) {
  return digestPayloadSchema.parse({ date: "2026-08-29", checked: 35, unreachable: [], jobs, ...rest });
}

describe("digest schema", () => {
  it("rejects a non-http job link", () => {
    const bad = digestPayloadSchema.safeParse({ checked: 1, jobs: [job({ url: "javascript:alert(1)" })] });
    expect(bad.success).toBe(false);
  });

  it("rejects more jobs than the cap", () => {
    const many = Array.from({ length: MAX_DIGEST_JOBS + 1 }, () => job());
    expect(digestPayloadSchema.safeParse({ checked: 1, jobs: many }).success).toBe(false);
  });

  it("defaults the optional descriptive fields", () => {
    const parsed = digestPayloadSchema.parse({
      jobs: [{ company: "A", title: "B", url: "https://x.test/1", summary: "s", score: 50 }],
    });
    expect(parsed.jobs[0].whyYouQualify).toEqual([]);
    expect(parsed.jobs[0].gaps).toEqual([]);
    expect(parsed.checked).toBe(0);
  });
});

describe("renderDigestHtml", () => {
  it("escapes HTML in model-supplied text", () => {
    const html = renderDigestHtml(parse([job({ title: '<script>alert("x")</script>' })]));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("includes the apply link as an href and as visible text", () => {
    const html = renderDigestHtml(parse([job()]));
    expect(html).toContain('href="https://careers.getjobber.com/jobs/123"');
    expect(html.match(/careers\.getjobber\.com/g)!.length).toBeGreaterThanOrEqual(2);
  });

  it("orders jobs by score, highest first", () => {
    const html = renderDigestHtml(
      parse([job({ company: "Low", score: 40 }), job({ company: "High", score: 90 })]),
    );
    expect(html.indexOf("High")).toBeLessThan(html.indexOf("Low"));
  });

  it("names unreachable companies rather than hiding them", () => {
    const html = renderDigestHtml(parse([job()], { unreachable: ["Benevity", "Symend"] }));
    expect(html).toContain("Benevity");
    expect(html).toContain("Symend");
  });

  it("renders an empty digest without crashing", () => {
    const html = renderDigestHtml(parse([]));
    expect(html).toContain("Nothing new cleared the bar");
  });
});

describe("renderDigestText", () => {
  it("carries the apply URL and both bullet sections", () => {
    const text = renderDigestText(parse([job()]));
    expect(text).toContain("Apply: https://careers.getjobber.com/jobs/123");
    expect(text).toContain("Why you qualify:");
    expect(text).toContain("Gaps:");
  });
});

describe("digestSubject", () => {
  it("leads with the count and the top match", () => {
    const subject = digestSubject(
      parse([job({ company: "Low", score: 40 }), job({ company: "High", score: 90 })]),
    );
    expect(subject).toBe("2 new roles — top: Software Engineer I at High");
  });

  it("uses the singular form for one job", () => {
    expect(digestSubject(parse([job()]))).toBe("1 new role: Software Engineer I at Jobber");
  });

  it("says so when there is nothing", () => {
    expect(digestSubject(parse([]))).toBe("No new entry-level postings — 2026-08-29");
  });
});
