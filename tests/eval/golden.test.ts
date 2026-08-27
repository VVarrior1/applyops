import { describe, it, expect } from "vitest";
import {
  candidateTier,
  chooseCandidates,
  diversityKey,
  roundRobinByBucket,
  titleFamily,
  type GoldenCandidate,
} from "../../src/eval/golden";

function candidate(
  jobId: string,
  overrides: Partial<GoldenCandidate> = {},
): GoldenCandidate {
  return {
    jobId,
    title: "Software Engineer",
    vendor: "greenhouse",
    remote: false,
    workAuthSignal: "hires_canadians",
    descriptionLength: 2000,
    ...overrides,
  };
}

describe("titleFamily", () => {
  it("classifies the families the golden set spreads over", () => {
    expect(titleFamily("Senior Backend Engineer")).toBe("backend");
    expect(titleFamily("Front End Developer, Growth")).toBe("frontend");
    expect(titleFamily("Machine Learning Engineer II")).toBe("ml-ai");
    expect(titleFamily("Data Scientist - Personalization")).toBe("data-science");
    expect(titleFamily("Data Engineer, RBC Amplify 2026")).toBe("data-engineering");
    expect(titleFamily("Corporate Data Analytics Summer Student")).toBe("analyst");
    expect(titleFamily("Site Reliability Engineer")).toBe("devops-infra");
    expect(titleFamily("Security Engineer, AppSec")).toBe("security");
    expect(titleFamily("iOS Engineer")).toBe("mobile");
    expect(titleFamily("Technical Content Writer")).toBe("writing");
    expect(titleFamily("Appeals Associate (French)")).toBe("support-ops");
    expect(titleFamily("Software Engineer, Intern")).toBe("software-general");
    expect(titleFamily("Global Travel Concierge")).toBe("support-ops");
  });

  it("prefers the more specific family when a title matches two", () => {
    // "Machine Learning Engineer" contains "engineer" but is not generic.
    expect(titleFamily("Machine Learning Engineer")).toBe("ml-ai");
    expect(titleFamily("Data Platform Engineer")).toBe("data-engineering");
  });

  it("is total — an empty or odd title still gets a bucket", () => {
    expect(titleFamily("")).toBe("other");
    expect(titleFamily("Dropbox")).toBe("other");
  });
});

describe("diversityKey", () => {
  it("combines all four dimensions", () => {
    expect(
      diversityKey(candidate("a", { vendor: "lever", remote: true, workAuthSignal: "tn_friendly", title: "Backend Engineer" })),
    ).toBe("vendor:lever | remote:true | auth:tn_friendly | family:backend");
  });

  it("gives nulls their own named buckets rather than dropping them", () => {
    const key = diversityKey(candidate("a", { remote: null, workAuthSignal: null }));
    expect(key).toContain("remote:unknown");
    expect(key).toContain("auth:unclear");
  });
});

describe("candidateTier", () => {
  it("separates substantive postings from title-only stubs", () => {
    expect(candidateTier(candidate("a", { descriptionLength: 2000 }), 400)).toBe(0);
    expect(candidateTier(candidate("b", { descriptionLength: 17 }), 400)).toBe(1);
    expect(candidateTier(candidate("c", { descriptionLength: 400 }), 400)).toBe(0);
  });
});

describe("roundRobinByBucket", () => {
  it("takes one item per bucket before taking a second from any", () => {
    const items = [
      { id: "a1", k: "a" },
      { id: "a2", k: "a" },
      { id: "a3", k: "a" },
      { id: "b1", k: "b" },
      { id: "c1", k: "c" },
    ];
    const picked = roundRobinByBucket(items, (i) => i.k, 4).map((i) => i.id);
    expect(picked.slice(0, 3).sort()).toEqual(["a1", "b1", "c1"]);
    expect(picked[3]).toBe("a2");
  });

  it("stops when every bucket is exhausted", () => {
    const items = [{ id: "a1", k: "a" }, { id: "b1", k: "b" }];
    expect(roundRobinByBucket(items, (i) => i.k, 10)).toHaveLength(2);
  });

  it("returns nothing for a non-positive n", () => {
    expect(roundRobinByBucket([{ id: "a1", k: "a" }], (i) => i.k, 0)).toEqual([]);
  });

  it("is deterministic for the same input", () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ id: `i${i}`, k: `k${i % 4}` }));
    const once = roundRobinByBucket(items, (i) => i.k, 7).map((i) => i.id);
    const twice = roundRobinByBucket(items, (i) => i.k, 7).map((i) => i.id);
    expect(once).toEqual(twice);
  });

  it("honours the rank comparator inside a bucket", () => {
    const items = [
      { id: "short", k: "a", len: 10 },
      { id: "long", k: "a", len: 900 },
    ];
    const picked = roundRobinByBucket(items, (i) => i.k, 1, (x, y) => y.len - x.len);
    expect(picked[0].id).toBe("long");
  });
});

describe("chooseCandidates", () => {
  it("spreads the picks across vendor × remote × auth × family", () => {
    const pool: GoldenCandidate[] = [
      candidate("g-be-1", { vendor: "greenhouse", title: "Backend Engineer" }),
      candidate("g-be-2", { vendor: "greenhouse", title: "Backend Engineer" }),
      candidate("g-be-3", { vendor: "greenhouse", title: "Backend Engineer" }),
      candidate("l-fe-1", { vendor: "lever", title: "Frontend Engineer" }),
      candidate("a-ml-1", { vendor: "ashby", title: "ML Engineer", remote: true }),
    ];
    const picked = chooseCandidates(pool, 3).map((c) => c.jobId);
    expect(new Set(picked).size).toBe(3);
    // One from each distinct bucket before a second from the crowded one.
    expect(picked).toContain("l-fe-1");
    expect(picked).toContain("a-ml-1");
  });

  it("takes every substantive posting before any title-only stub", () => {
    const pool = [
      candidate("thin-1", { descriptionLength: 20, title: "Backend Engineer" }),
      candidate("thin-2", { descriptionLength: 20, title: "Frontend Engineer" }),
      candidate("rich-1", { descriptionLength: 3000, title: "Data Engineer" }),
      candidate("rich-2", { descriptionLength: 3000, title: "Security Engineer" }),
    ];
    const picked = chooseCandidates(pool, 3).map((c) => c.jobId);
    expect(picked.slice(0, 2).sort()).toEqual(["rich-1", "rich-2"]);
    expect(picked).toHaveLength(3);
    expect(picked[2]).toMatch(/^thin-/);
  });

  it("returns fewer than n when the corpus cannot fill the set", () => {
    expect(chooseCandidates([candidate("only")], 40)).toHaveLength(1);
    expect(chooseCandidates([], 40)).toEqual([]);
  });

  it("prefers the richest posting inside a bucket", () => {
    const pool = [
      candidate("small", { descriptionLength: 600 }),
      candidate("big", { descriptionLength: 6000 }),
    ];
    expect(chooseCandidates(pool, 1)[0].jobId).toBe("big");
  });
});
