import { describe, it, expect } from "vitest";
import { latestGenerationByStep, type GenerationLike } from "../../src/pipeline/generations";

interface Row extends GenerationLike {
  id: string;
}

function row(id: string, step: string, createdAt: string): Row {
  return { id, step, createdAt: new Date(createdAt) };
}

describe("latestGenerationByStep", () => {
  it("picks the newest row per step, regardless of input order", () => {
    const rows = [
      row("tailor-old", "tailor", "2026-01-01T00:00:00Z"),
      row("suggest-new", "suggest", "2026-01-03T00:00:00Z"),
      row("tailor-new", "tailor", "2026-01-02T00:00:00Z"),
      row("suggest-old", "suggest", "2026-01-01T00:00:00Z"),
    ];

    const latest = latestGenerationByStep(rows, ["tailor", "suggest"]);

    expect(latest.get("tailor")?.id).toBe("tailor-new");
    expect(latest.get("suggest")?.id).toBe("suggest-new");
  });

  it("ignores rows for steps not asked for", () => {
    const rows = [
      row("fit-1", "fit", "2026-01-05T00:00:00Z"),
      row("tailor-1", "tailor", "2026-01-01T00:00:00Z"),
    ];

    const latest = latestGenerationByStep(rows, ["tailor", "suggest"]);

    expect(latest.has("fit")).toBe(false);
    expect(latest.get("tailor")?.id).toBe("tailor-1");
  });

  it("has no entry for a step with no rows at all", () => {
    const latest = latestGenerationByStep([row("tailor-1", "tailor", "2026-01-01T00:00:00Z")], [
      "tailor",
      "suggest",
    ]);

    expect(latest.has("suggest")).toBe(false);
  });

  it("returns an empty map for an empty input", () => {
    expect(latestGenerationByStep([], ["tailor", "suggest"]).size).toBe(0);
  });

  it("breaks a tie by keeping whichever row came first in the input", () => {
    const rows = [
      row("first", "tailor", "2026-01-01T00:00:00Z"),
      row("second", "tailor", "2026-01-01T00:00:00Z"),
    ];

    expect(latestGenerationByStep(rows, ["tailor"]).get("tailor")?.id).toBe("first");
  });

  it("a newer failed/unparseable row does not shadow an older good one", () => {
    interface UnusableRow extends Row {
      usable: boolean;
    }
    const rows: UnusableRow[] = [
      { ...row("tailor-good-old", "tailor", "2026-01-01T00:00:00Z"), usable: true },
      { ...row("tailor-bad-new", "tailor", "2026-01-02T00:00:00Z"), usable: false },
      { ...row("suggest-good", "suggest", "2026-01-01T00:00:00Z"), usable: true },
    ];

    const latest = latestGenerationByStep(rows, ["tailor", "suggest"], (r) => r.usable);

    expect(latest.get("tailor")?.id).toBe("tailor-good-old");
    expect(latest.get("suggest")?.id).toBe("suggest-good");
  });

  it("falls back to the newest row when nothing for that step passes isUsable", () => {
    const rows = [
      row("tailor-bad-old", "tailor", "2026-01-01T00:00:00Z"),
      row("tailor-bad-new", "tailor", "2026-01-02T00:00:00Z"),
    ];

    const latest = latestGenerationByStep(rows, ["tailor"], () => false);

    expect(latest.get("tailor")?.id).toBe("tailor-bad-new");
  });

  it("without isUsable, behaves exactly like picking the single newest row", () => {
    const rows = [
      row("tailor-old", "tailor", "2026-01-01T00:00:00Z"),
      row("tailor-new", "tailor", "2026-01-02T00:00:00Z"),
    ];

    expect(latestGenerationByStep(rows, ["tailor"]).get("tailor")?.id).toBe("tailor-new");
  });
});
