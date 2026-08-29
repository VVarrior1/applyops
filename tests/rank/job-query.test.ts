import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies, jobScores } from "../../src/db/schema";
import {
  LEVEL_VALUES,
  levelCondition,
  parseLevel,
  parseSort,
  SORT_LABELS,
  SORT_VALUES,
  sortOrder,
} from "../../src/rank/job-query";

const dialect = new PgDialect();
const text = (q: Parameters<PgDialect["sqlToQuery"]>[0]) => dialect.sqlToQuery(q).sql;

const COLS = {
  fitScore: jobScores.score,
  keywordScore: jobScores.score,
  companyName: companies.name,
};

describe("parseLevel", () => {
  it("defaults to entry", () => {
    expect(parseLevel(undefined)).toBe("entry");
    expect(parseLevel("")).toBe("entry");
    expect(parseLevel("nonsense")).toBe("entry");
    // A value from a different filter must not leak through.
    expect(parseLevel("worth")).toBe("entry");
  });

  it("accepts every documented value", () => {
    for (const value of LEVEL_VALUES) expect(parseLevel(value)).toBe(value);
  });
});

describe("levelCondition", () => {
  it("entry is `= true` only — unknown rows stay out of the default view", () => {
    const q = text(levelCondition("entry")!);
    expect(q).toMatch(/"is_entry_level"\s*=\s*true/);
    expect(q).not.toMatch(/is null/i);
  });

  it("unknown adds the NULL rows but never the confirmed-false ones", () => {
    const q = text(levelCondition("unknown")!);
    expect(q).toMatch(/"is_entry_level"\s*=\s*true/);
    expect(q).toMatch(/"is_entry_level"\s+is null/i);
    expect(q).not.toMatch(/=\s*false/);
  });

  it("any filters nothing", () => {
    expect(levelCondition("any")).toBeNull();
  });
});

describe("parseSort", () => {
  it("defaults to fit", () => {
    expect(parseSort(undefined)).toBe("fit");
    expect(parseSort("")).toBe("fit");
    expect(parseSort("score")).toBe("fit");
    expect(parseSort("COMPANY")).toBe("fit"); // case-sensitive on purpose
  });

  it("accepts every documented value, and every value has a label", () => {
    for (const value of SORT_VALUES) {
      expect(parseSort(value)).toBe(value);
      expect(SORT_LABELS[value]).toBeTruthy();
    }
  });
});

describe("sortOrder", () => {
  it("fit puts scored rows in a block ahead of keyword-only rows, then newest", () => {
    const terms = sortOrder("fit", COLS).map(text);
    expect(terms).toHaveLength(3);
    expect(terms[0]).toMatch(/IS NOT NULL\) DESC/);
    expect(terms[1]).toMatch(/coalesce/i);
    expect(terms[1]).toMatch(/DESC NULLS LAST/);
    expect(terms[2]).toMatch(/"posted_at" DESC NULLS LAST/);
  });

  it("newest and oldest sort by posted_at with NULLs last in both directions", () => {
    expect(sortOrder("newest", COLS).map(text)).toEqual([
      expect.stringMatching(/"posted_at" DESC NULLS LAST/),
    ]);
    expect(sortOrder("oldest", COLS).map(text)).toEqual([
      expect.stringMatching(/"posted_at" ASC NULLS LAST/),
    ]);
  });

  it("company sorts by company name ascending, newest first within a company", () => {
    const terms = sortOrder("company", COLS).map(text);
    expect(terms).toHaveLength(2);
    expect(terms[0]).toMatch(/"name" asc nulls last/i);
    expect(terms[1]).toMatch(/"posted_at" DESC NULLS LAST/);
  });

  it("an unrecognised sort can't reach here, but falls back to fit if it does", () => {
    // parseSort is the gate; this is the belt-and-braces half.
    expect(sortOrder("bogus" as never, COLS)).toHaveLength(3);
  });

  it("every ordering is expressible as SQL (no undefined columns)", () => {
    for (const value of SORT_VALUES) {
      for (const term of sortOrder(value, COLS)) {
        expect(() => text(sql`order by ${term}`)).not.toThrow();
      }
    }
  });
});
