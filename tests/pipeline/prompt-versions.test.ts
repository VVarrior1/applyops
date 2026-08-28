import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  PROMPT_STEPS,
  ensurePromptVersion,
  loadPrompt,
} from "../../src/pipeline/prompt-versions";
import { promptVersions, type Step } from "../../src/db/schema";
import type { Db } from "../../src/db/client";

/**
 * Fake drizzle surface covering exactly what prompt-versions.ts touches:
 *   db.select({...}).from(t).where(...).limit(1)
 *   db.insert(t).values({...}).onConflictDoNothing({target}).returning({...})
 * `select` results are scripted in order, because the fake cannot evaluate a
 * drizzle SQL condition (same approach as tests/llm/call.test.ts).
 */
function fakeDb(script: {
  selects?: Record<string, unknown>[][];
  inserts?: Record<string, unknown>[][];
}) {
  const selects = [...(script.selects ?? [])];
  const inserts = [...(script.inserts ?? [])];
  const inserted: Record<string, unknown>[] = [];
  let selectCalls = 0;

  const db = {
    select() {
      const q = {
        from: () => q,
        where: () => q,
        limit: async () => {
          selectCalls += 1;
          return selects.shift() ?? [];
        },
      };
      return q;
    },
    insert(table: unknown) {
      expect(table).toBe(promptVersions);
      return {
        values(values: Record<string, unknown>) {
          inserted.push(values);
          return {
            onConflictDoNothing: () => ({
              returning: async () => inserts.shift() ?? [],
            }),
          };
        },
      };
    },
  };

  return {
    db: db as unknown as Db,
    inserted,
    get selectCalls() {
      return selectCalls;
    },
  };
}

describe("loadPrompt", () => {
  it("reads the version from the file's front matter", () => {
    // Bumped to 1.2.0 when the prompt gained the `experience` entries
    // (v1 parity — see src/pipeline/schemas.ts).
    expect(loadPrompt("tailor").version).toBe("1.2.0");
  });

  it("returns a stable sha256 across calls", () => {
    const a = loadPrompt("tailor");
    const b = loadPrompt("tailor");
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.sha256).toBe(b.sha256);
  });

  it("hashes exactly the content it returns", () => {
    const p = loadPrompt("tailor");
    expect(createHash("sha256").update(p.content, "utf8").digest("hex")).toBe(
      p.sha256,
    );
  });

  it("strips the front matter from the content", () => {
    const p = loadPrompt("tailor");
    expect(p.content.startsWith("---")).toBe(false);
    expect(p.content).not.toMatch(/^version:/m);
    expect(p.content.length).toBeGreaterThan(200);
  });

  it("loads a distinct, non-empty prompt for every step", () => {
    const shas = new Set<string>();
    for (const step of PROMPT_STEPS) {
      const p = loadPrompt(step);
      expect(p.step).toBe(step);
      expect(p.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(p.content.trim().length).toBeGreaterThan(0);
      shas.add(p.sha256);
    }
    expect(shas.size).toBe(PROMPT_STEPS.length);
  });

  it("tells tailor and suggest to cite only listed fact labels", () => {
    for (const step of ["tailor", "suggest"] as const) {
      expect(loadPrompt(step).content).toMatch(/fact_ids/);
      expect(loadPrompt(step).content.toLowerCase()).toMatch(
        /never invent|do not invent/,
      );
    }
  });

  it("throws a clear error for a step with no prompt file", () => {
    expect(() => loadPrompt("nope" as Step)).toThrow(/prompt file/i);
  });
});

describe("ensurePromptVersion", () => {
  it("inserts the prompt on first use and returns the new row id", async () => {
    const { db, inserted } = fakeDb({ inserts: [[{ id: "pv-new" }]] });
    const id = await ensurePromptVersion(db, "analyze");

    expect(id).toBe("pv-new");
    expect(inserted).toHaveLength(1);
    const prompt = loadPrompt("analyze");
    expect(inserted[0]).toMatchObject({
      step: "analyze",
      version: "1.0.0",
      sha256: prompt.sha256,
      content: prompt.content,
    });
  });

  it("reuses the existing row when the content hash still matches", async () => {
    const prompt = loadPrompt("fit");
    const { db, inserted } = fakeDb({
      selects: [[{ id: "pv-existing", sha256: prompt.sha256 }]],
    });

    expect(await ensurePromptVersion(db, "fit")).toBe("pv-existing");
    expect(inserted).toHaveLength(0);
  });

  it("caches the id so repeat calls make no further queries", async () => {
    const { db, inserted } = fakeDb({ inserts: [[{ id: "pv-cached" }]] });

    expect(await ensurePromptVersion(db, "judge")).toBe("pv-cached");
    expect(await ensurePromptVersion(db, "judge")).toBe("pv-cached");
    expect(await ensurePromptVersion(db, "judge")).toBe("pv-cached");
    expect(inserted).toHaveLength(1);
  });

  it("records a drifted prompt under a content-addressed version instead of rewriting history", async () => {
    const prompt = loadPrompt("suggest");
    const { db, inserted } = fakeDb({
      // 1st select: the stored 1.0.0 row, hashed from older content.
      // 2nd select: no row yet for the suffixed version.
      selects: [[{ id: "pv-old", sha256: "0".repeat(64) }], []],
      inserts: [[{ id: "pv-drifted" }]],
    });

    const id = await ensurePromptVersion(db, "suggest");

    expect(id).toBe("pv-drifted");
    expect(inserted).toHaveLength(1);
    expect(inserted[0].version).toBe(`1.0.0+${prompt.sha256.slice(0, 8)}`);
    expect(inserted[0].sha256).toBe(prompt.sha256);
  });

  it("falls back to a re-select when a concurrent insert won the race", async () => {
    const { db } = fakeDb({
      selects: [[], [{ id: "pv-raced", sha256: "whatever" }]],
      inserts: [[]],
    });

    expect(await ensurePromptVersion(db, "extract_facts")).toBe("pv-raced");
  });

  it("throws rather than returning an empty id when the row cannot be resolved", async () => {
    const { db } = fakeDb({ selects: [[], []], inserts: [[]] });
    await expect(ensurePromptVersion(db, "tailor")).rejects.toThrow(
      /prompt_versions/,
    );
  });
});
