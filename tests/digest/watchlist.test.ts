import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * `data/watchlist.json` is edited by hand (that is the point — the owner adds
 * and drops companies without touching code) and read by a scheduled agent
 * that has no way to report a syntax error back to anyone. These assertions
 * are what turns "the watcher quietly checked 39 companies instead of 40"
 * into a failed CI run.
 */
const watchlist = JSON.parse(
  readFileSync(path.join(process.cwd(), "data/watchlist.json"), "utf8"),
) as {
  companies: {
    name: string;
    hq: string;
    careers_url: string;
    board: { vendor: string; slug: string } | null;
    entry_level_track?: boolean;
  }[];
};

const KNOWN_VENDORS = new Set(["greenhouse", "lever", "ashby", "workday", "smartrecruiters", "recruitee", "personio"]);

describe("data/watchlist.json", () => {
  it("has a usable number of companies", () => {
    expect(watchlist.companies.length).toBeGreaterThanOrEqual(20);
    expect(watchlist.companies.length).toBeLessThanOrEqual(80);
  });

  it("names every company uniquely", () => {
    const names = watchlist.companies.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("gives every company an http(s) careers URL", () => {
    for (const c of watchlist.companies) {
      expect(c.careers_url, c.name).toMatch(/^https:\/\/\S+$/);
    }
  });

  it("uses only vendors the scraper knows about in board hints", () => {
    for (const c of watchlist.companies) {
      if (c.board) expect(KNOWN_VENDORS.has(c.board.vendor), `${c.name}: ${c.board.vendor}`).toBe(true);
    }
  });

  it("stays weighted toward Alberta — the owner is in Calgary and wants same-day local applications", () => {
    const alberta = watchlist.companies.filter((c) => /\bAB\b/.test(c.hq));
    expect(alberta.length).toBeGreaterThanOrEqual(watchlist.companies.length * 0.3);
  });
});
