import { describe, it, expect } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { jobs, profileFacts, evalRuns } from "../../src/db/schema";

describe("db schema", () => {
  it("jobs has a unique index on url", () => {
    const { indexes } = getTableConfig(jobs);
    const urlIndex = indexes.find((idx) =>
      idx.config.columns.some((c) => "name" in c && c.name === "url"),
    );
    expect(urlIndex).toBeDefined();
    expect(urlIndex?.config.unique).toBe(true);
  });

  it("profile_facts has a unique index on (user_id, label)", () => {
    const { indexes } = getTableConfig(profileFacts);
    const compound = indexes.find((idx) => {
      const names = idx.config.columns
        .filter((c): c is { name: string } => "name" in c)
        .map((c) => c.name);
      return (
        names.length === 2 &&
        names.includes("user_id") &&
        names.includes("label")
      );
    });
    expect(compound).toBeDefined();
    expect(compound?.config.unique).toBe(true);
  });

  it("eval_runs has a baseline column", () => {
    const { columns } = getTableConfig(evalRuns);
    const baseline = columns.find((c) => c.name === "baseline");
    expect(baseline).toBeDefined();
  });
});
