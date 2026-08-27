import { describe, it, expect } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { generations, promptVersions } from "../../src/db/schema";
import { DEFAULT_MODEL_BY_STEP, JUDGE_MODEL_ID } from "../../src/llm/defaults";
import type { Db } from "../../src/db/client";
import { loadPrompt } from "../../src/pipeline/prompt-versions";
import type { AnalyzeOutput, Fact, FitOutput } from "../../src/pipeline/schemas";
import {
  runAnalyze,
  runExtractFacts,
  runFit,
  runJudge,
  runSuggest,
  runTailor,
} from "../../src/pipeline/steps";

/**
 * Fake drizzle surface: prompt-versions inserts, generations inserts, and the
 * budget's select (never reached here — every call runs with userId null).
 */
function fakeDb() {
  const inserted: { table: unknown; values: Record<string, unknown> }[] = [];
  let n = 0;
  const db = {
    select() {
      const q = { from: () => q, where: () => q, limit: async () => [] };
      return q;
    },
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown>) {
          inserted.push({ table, values });
          const id =
            table === promptVersions ? `pv-${++n}` : `gen-${++n}`;
          return {
            returning: async () => [{ id }],
            onConflictDoNothing: () => ({ returning: async () => [{ id }] }),
            onConflictDoUpdate: async () => undefined,
          };
        },
      };
    },
  };
  return {
    db: db as unknown as Db,
    inserted,
    generationRows: () =>
      inserted.filter((i) => i.table === generations).map((i) => i.values),
    promptVersionRows: () =>
      inserted.filter((i) => i.table === promptVersions).map((i) => i.values),
  };
}

/**
 * Mock model that always replies with `json`, capturing what it was sent.
 * The captured shape is declared structurally rather than imported from
 * `@ai-sdk/provider-v3`: that package is only a transitive dependency of `ai`
 * and must not be imported directly (see tests/llm/call.test.ts).
 */
type CapturedCall = { prompt: { role: string; content: unknown }[] };

function replyWith(json: unknown) {
  const calls: CapturedCall[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      calls.push(options as unknown as CapturedCall);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(json) }],
        finishReason: { unified: "stop" as const, raw: "end_turn" },
        usage: {
          inputTokens: { total: 1200, noCache: 1200, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 300, text: 300, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  return {
    model,
    /** Everything the model was sent, as one searchable string. */
    sent: () => JSON.stringify(calls),
    systemOf: (i = 0) =>
      (calls[i].prompt.find((m) => m.role === "system")?.content ?? "") as string,
  };
}

const FACTS: Fact[] = [
  { label: "F-001", category: "experience", text: "Built payment APIs at Acme" },
  { label: "F-002", category: "project", text: "Shipped a booking platform for 100+ weekly users" },
];

const ANALYSIS: AnalyzeOutput = {
  requirements: [{ text: "3 years of Go", must_have: true }],
  nice_to_have: ["Kubernetes"],
  seniority: "mid",
  years_min: 3,
  work_auth_signal: "unclear",
  keywords: ["go", "payments"],
  summary: "Backend role on the payments team.",
};

const FIT: FitOutput = {
  score: 64,
  matched: [{ requirement: "3 years of Go", fact_ids: ["F-001"] }],
  gaps: ["No Kubernetes"],
  rationale: "Strong payments signal, no infra work.",
};

const ANALYZE_JSON: AnalyzeOutput = ANALYSIS;

describe("runAnalyze", () => {
  it("registers the prompt version, sends the posting, and records a generation", async () => {
    const { db, generationRows, promptVersionRows } = fakeDb();
    const { model, sent, systemOf } = replyWith(ANALYZE_JSON);

    const result = await runAnalyze(db, {
      job: {
        title: "Backend Engineer",
        company: "Acme",
        description: "You will build payment services in Go.",
        location: "Calgary, AB",
        remote: true,
      },
      jobId: "22222222-2222-4222-8222-222222222222",
      _internal: { model },
    });

    expect(result.output.seniority).toBe("mid");
    expect(result.generationId).toBe("gen-2");
    expect(result.costUsd).toBeGreaterThan(0);

    // prompt_versions row registered before the generation (FK order).
    expect(promptVersionRows()).toHaveLength(1);
    expect(promptVersionRows()[0]).toMatchObject({
      step: "analyze",
      sha256: loadPrompt("analyze").sha256,
    });

    expect(systemOf()).toBe(loadPrompt("analyze").content);
    expect(sent()).toContain("Backend Engineer");
    expect(sent()).toContain("payment services in Go");

    const gen = generationRows()[0];
    expect(gen).toMatchObject({
      step: "analyze",
      modelId: DEFAULT_MODEL_BY_STEP.analyze,
      promptVersionId: "pv-1",
      jobId: "22222222-2222-4222-8222-222222222222",
      userId: null,
    });
  });
});

describe("runFit", () => {
  it("renders facts as `LABEL | category | text` lines and includes the prefs", async () => {
    const { db } = fakeDb();
    const { model, sent } = replyWith(FIT);

    const result = await runFit(db, {
      analysis: ANALYSIS,
      facts: FACTS,
      prefs: { roles: ["Backend"], remote: "remote", excludedCompanies: ["Initech"] },
      userId: null,
      job: { title: "Backend Engineer", company: "Acme" },
      _internal: { model },
    });

    expect(result.output.score).toBe(64);
    expect(sent()).toContain(
      "F-002 | project | Shipped a booking platform for 100+ weekly users",
    );
    expect(sent()).toContain("Will not work for: Initech");
    expect(sent()).toContain("3 years of Go");
  });

  it("tells the model plainly when the user has no confirmed facts", async () => {
    const { db } = fakeDb();
    const { model, sent } = replyWith(FIT);

    await runFit(db, {
      analysis: ANALYSIS,
      facts: [],
      userId: null,
      _internal: { model },
    });

    expect(sent()).toContain("no confirmed facts on file");
  });
});

describe("runTailor", () => {
  const grounded = {
    summary: "Backend engineer with payments experience.",
    skills: ["Go", "Postgres"],
    sections: [
      {
        heading: "Experience",
        bullets: [
          { text: "Built payment APIs at Acme", fact_ids: ["F-001"] },
          { text: "Shipped a booking platform", fact_ids: ["F-002"] },
        ],
      },
    ],
  };

  it("returns a clean hallucination report when every bullet cites a real fact", async () => {
    const { db } = fakeDb();
    const { model, sent, systemOf } = replyWith(grounded);

    const result = await runTailor(db, {
      analysis: ANALYSIS,
      facts: FACTS,
      fit: FIT,
      userId: null,
      _internal: { model },
    });

    expect(result.hallucination).toEqual({
      totalClaims: 2,
      unsupported: [],
      rate: 0,
    });
    expect(systemOf()).toBe(loadPrompt("tailor").content);
    // The fit assessment is passed through to the tailor step.
    expect(sent()).toContain("Fit score: 64/100");
  });

  it("flags an invented fact id and an uncited bullet", async () => {
    const { db } = fakeDb();
    const { model } = replyWith({
      ...grounded,
      sections: [
        {
          heading: "Experience",
          bullets: [
            { text: "Built payment APIs at Acme", fact_ids: ["F-001"] },
            { text: "Led a team of 12", fact_ids: ["F-404"] },
            { text: "Won an award", fact_ids: [] },
          ],
        },
      ],
    });

    const result = await runTailor(db, {
      analysis: ANALYSIS,
      facts: FACTS,
      fit: FIT,
      userId: null,
      _internal: { model },
    });

    expect(result.hallucination.totalClaims).toBe(3);
    expect(result.hallucination.unsupported.map((u) => u.path)).toEqual([
      "sections[0].bullets[1]",
      "sections[0].bullets[2]",
    ]);
    expect(result.hallucination.rate).toBeCloseTo(2 / 3, 3);
  });

  it("uses the default tailor model", async () => {
    const { db, generationRows } = fakeDb();
    const { model } = replyWith(grounded);

    await runTailor(db, {
      analysis: ANALYSIS,
      facts: FACTS,
      userId: null,
      _internal: { model },
    });

    expect(generationRows()[0].modelId).toBe(DEFAULT_MODEL_BY_STEP.tailor);
  });
});

describe("runSuggest", () => {
  it("checks citations on lead_with and weekend_build", async () => {
    const { db } = fakeDb();
    const { model } = replyWith({
      gaps: [{ requirement: "3 years Go", severity: "high", how_to_close: "Port a service." }],
      lead_with: [{ fact_ids: ["F-001"], why: "Closest match." }],
      weekend_build: { idea: "Port the booking API to Go", why: "Closes the gap", fact_ids: ["F-999"] },
      likely_questions: ["Tell me about a hard bug."],
      keywords_to_include: ["go"],
    });

    const result = await runSuggest(db, {
      analysis: ANALYSIS,
      facts: FACTS,
      fit: FIT,
      userId: null,
      _internal: { model },
    });

    expect(result.hallucination.totalClaims).toBe(2);
    expect(result.hallucination.unsupported).toEqual([
      { path: "weekend_build", text: "Port the booking API to Go", badIds: ["F-999"] },
    ]);
  });
});

describe("runJudge", () => {
  it("defaults to the fixed judge model and shows the tailored JSON with its fact ids", async () => {
    const { db, generationRows } = fakeDb();
    const { model, sent } = replyWith({
      grounding: 5,
      coverage: 4,
      specificity: 4,
      stuffing_penalty: 5,
      rationale: "Every bullet cited a listed fact.",
    });

    const result = await runJudge(db, {
      job: { title: "Backend Engineer", company: "Acme", description: "Go services." },
      facts: FACTS,
      tailor: {
        summary: "s",
        skills: ["Go"],
        sections: [{ heading: "Experience", bullets: [{ text: "b", fact_ids: ["F-001"] }] }],
      },
      _internal: { model },
    });

    expect(result.output.grounding).toBe(5);
    expect(generationRows()[0].modelId).toBe(JUDGE_MODEL_ID);
    expect(sent()).toContain("fact_ids");
    expect(sent()).toContain("F-001");
  });
});

describe("runExtractFacts", () => {
  it("sends the resume text and returns parsed facts", async () => {
    const { db, generationRows } = fakeDb();
    const { model, sent } = replyWith({
      facts: [
        {
          category: "experience",
          text: "Built payment APIs at Acme using Go",
          evidence_span: "Built payment APIs at Acme using Go",
        },
      ],
    });

    const result = await runExtractFacts(db, {
      resumeText: "EXPERIENCE\nBuilt payment APIs at Acme using Go",
      userId: null,
      _internal: { model },
    });

    expect(result.output.facts[0].category).toBe("experience");
    expect(sent()).toContain("Built payment APIs at Acme using Go");
    expect(generationRows()[0].step).toBe("extract_facts");
  });

  it("truncates an enormous resume rather than paying for it", async () => {
    const { db } = fakeDb();
    const { model, sent } = replyWith({ facts: [] });

    await runExtractFacts(db, {
      resumeText: "x".repeat(50_000),
      userId: null,
      _internal: { model },
    });

    expect(sent()).toContain("truncated at 24000 characters");
    expect(sent().length).toBeLessThan(40_000);
  });
});
