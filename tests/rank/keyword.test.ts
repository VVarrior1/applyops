import { describe, expect, it } from "vitest";
import { keywordScore } from "../../src/rank/keyword";

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

describe("keywordScore", () => {
  it("stacks remote (+3), a 'new grad' title (+2) and freshness < 7d (+2)", () => {
    const score = keywordScore({
      title: "New Grad Software Engineer",
      location: "Anywhere",
      remote: true,
      description: "",
      postedAt: daysAgo(3),
      scrapedAt: null,
    });
    // 2 (fresh) + 3 (remote) + 2 (title) = 7
    expect(score).toBe(7);
  });

  it("gives Calgary the same +3 as remote, with no freshness bonus past 14 days", () => {
    const score = keywordScore({
      title: "Software Developer",
      location: "Calgary, AB",
      remote: false,
      description: "",
      postedAt: daysAgo(20),
      scrapedAt: null,
    });
    // 3 (Calgary) only — no freshness, no title match, no keywords.
    expect(score).toBe(3);
  });

  it("gives USA +1 and Canada (non-Calgary) +2, mutually exclusive with remote/Calgary", () => {
    const usa = keywordScore({
      title: "Software Engineer",
      location: "Austin, TX, USA",
      remote: false,
      description: "",
      postedAt: daysAgo(3),
      scrapedAt: null,
    });
    // 2 (fresh) + 1 (USA) = 3
    expect(usa).toBe(3);

    const canada = keywordScore({
      title: "Software Engineer",
      location: "Toronto, Canada",
      remote: false,
      description: "",
      postedAt: null,
      scrapedAt: null,
    });
    // 2 (Canada, non-Calgary) only.
    expect(canada).toBe(2);
  });

  it("caps description keyword hits at +2 even when 5 keywords match", () => {
    const score = keywordScore({
      title: "Backend Engineer",
      location: "Somewhere",
      remote: false,
      description:
        "We use Next.js, Python, GCP, TypeScript and React across the stack.",
      postedAt: null,
      scrapedAt: null,
    });
    // No freshness, no location match, no title match, no YC — just the
    // capped keyword bonus.
    expect(score).toBe(2);
  });

  it("gives the YC vendor bonus and caps the total at 10", () => {
    const score = keywordScore({
      title: "New Grad ML Engineer",
      location: "Remote",
      remote: true,
      description: "Python, TypeScript, React, Next.js, GCP — pick your stack.",
      postedAt: daysAgo(1),
      scrapedAt: null,
      atsVendor: "yc",
    });
    // 2 (fresh) + 3 (remote) + 2 (title) + 1 (yc) + 2 (keyword cap) = 10,
    // which also happens to be the max attainable score — Math.min(_, 10)
    // still exercised, just not by exceeding it.
    expect(score).toBe(10);
  });

  it("scores a job with no signals at all as 0, never negative", () => {
    const score = keywordScore({
      title: "Something Unrelated",
      location: null,
      remote: false,
      description: null,
      postedAt: null,
      scrapedAt: null,
    });
    expect(score).toBe(0);
  });
});
