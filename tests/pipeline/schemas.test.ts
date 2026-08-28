import { describe, it, expect } from "vitest";
import {
  AnalyzeOutput,
  ExtractFactsOutput,
  FitOutput,
  JudgeOutput,
  SuggestOutput,
  TailorOutput,
  FACT_CATEGORIES,
  SCHEMA_BY_STEP,
} from "../../src/pipeline/schemas";
import { stepEnum } from "../../src/db/schema";

describe("TailorOutput", () => {
  const valid = {
    summary: "Backend-leaning new grad with production TypeScript.",
    skills: ["TypeScript", "Postgres"],
    sections: [
      {
        heading: "Projects",
        bullets: [{ text: "Built a thing", fact_ids: ["F-001"] }],
      },
    ],
  };

  it("accepts a well-formed tailor output", () => {
    expect(TailorOutput.parse(valid)).toEqual(valid);
  });

  it("rejects a bullet that is missing fact_ids", () => {
    const bad = {
      ...valid,
      sections: [
        { heading: "Projects", bullets: [{ text: "Built a thing" }] },
      ],
    };
    const result = TailorOutput.safeParse(bad);
    expect(result.success).toBe(false);
    expect(result.error!.issues[0].path).toEqual([
      "sections",
      0,
      "bullets",
      0,
      "fact_ids",
    ]);
  });

  it("accepts an empty fact_ids array (the hallucination checker flags it, not the schema)", () => {
    const bullet = { text: "Built a thing", fact_ids: [] };
    const parsed = TailorOutput.parse({
      ...valid,
      sections: [{ heading: "Projects", bullets: [bullet] }],
    });
    expect(parsed.sections[0].bullets[0].fact_ids).toEqual([]);
  });

  it("still parses a stored output written before `projects` existed", () => {
    // The PDF route re-parses whatever the client submits, including tailor
    // generations from before v1-parity added `projects`. Making that field
    // required would 400 every one of them.
    const parsed = TailorOutput.parse(valid);
    expect(parsed.projects).toBeUndefined();
  });

  it("accepts the v1-parity `projects` list", () => {
    const parsed = TailorOutput.parse({
      ...valid,
      projects: [
        {
          name: "KanDoIt",
          technologies: "Next.js, Prisma",
          bullets: [{ text: "Built a Kanban app", fact_ids: ["F-002"] }],
        },
      ],
    });
    expect(parsed.projects?.[0].name).toBe("KanDoIt");
  });
});

describe("AnalyzeOutput", () => {
  const valid = {
    requirements: [{ text: "3 years of Go", must_have: true }],
    nice_to_have: ["Kubernetes"],
    seniority: "mid",
    years_min: 3,
    work_auth_signal: "unclear",
    keywords: ["go", "grpc"],
    summary: "Backend role on the payments team.",
  };

  it("accepts a well-formed analysis", () => {
    expect(AnalyzeOutput.parse(valid).seniority).toBe("mid");
  });

  it("rejects a work_auth_signal outside the DB enum", () => {
    expect(
      AnalyzeOutput.safeParse({ ...valid, work_auth_signal: "maybe" }).success,
    ).toBe(false);
  });

  it("rejects a requirement missing must_have", () => {
    expect(
      AnalyzeOutput.safeParse({
        ...valid,
        requirements: [{ text: "3 years of Go" }],
      }).success,
    ).toBe(false);
  });

  it("rejects negative years_min", () => {
    expect(AnalyzeOutput.safeParse({ ...valid, years_min: -1 }).success).toBe(
      false,
    );
  });
});

describe("FitOutput", () => {
  const valid = {
    score: 72,
    matched: [{ requirement: "3 years of Go", fact_ids: ["F-001"] }],
    gaps: ["No Kubernetes"],
    rationale: "Strong backend signal, no infra work.",
  };

  it("accepts a score in range", () => {
    expect(FitOutput.parse(valid).score).toBe(72);
  });

  it("rejects a score above 100", () => {
    expect(FitOutput.safeParse({ ...valid, score: 101 }).success).toBe(false);
  });

  it("rejects a fractional score", () => {
    expect(FitOutput.safeParse({ ...valid, score: 72.5 }).success).toBe(false);
  });
});

describe("SuggestOutput", () => {
  const valid = {
    gaps: [
      { requirement: "3 years Go", severity: "high", how_to_close: "Build one." },
    ],
    lead_with: [{ fact_ids: ["F-001"], why: "Closest match." }],
    weekend_build: { idea: "Ship a service", why: "Covers the gap", fact_ids: ["F-001"] },
    likely_questions: ["Tell me about a hard bug."],
    keywords_to_include: ["Go"],
  };

  it("accepts a well-formed suggestion set", () => {
    expect(SuggestOutput.parse(valid).gaps[0].severity).toBe("high");
  });

  it("rejects an unknown severity", () => {
    expect(
      SuggestOutput.safeParse({
        ...valid,
        gaps: [{ requirement: "x", severity: "catastrophic", how_to_close: "y" }],
      }).success,
    ).toBe(false);
  });
});

describe("JudgeOutput", () => {
  const valid = {
    grounding: 5,
    coverage: 4,
    specificity: 3,
    stuffing_penalty: 5,
    rationale: "Every bullet cited a fact.",
  };

  it("accepts 1-5 integer scores", () => {
    expect(JudgeOutput.parse(valid).grounding).toBe(5);
  });

  it("rejects a score of 0 and a score of 6", () => {
    expect(JudgeOutput.safeParse({ ...valid, grounding: 0 }).success).toBe(false);
    expect(JudgeOutput.safeParse({ ...valid, coverage: 6 }).success).toBe(false);
  });
});

describe("ExtractFactsOutput", () => {
  it("accepts the documented fact categories", () => {
    for (const category of FACT_CATEGORIES) {
      const parsed = ExtractFactsOutput.parse({
        facts: [{ category, text: "did a thing", evidence_span: "did a thing" }],
      });
      expect(parsed.facts[0].category).toBe(category);
    }
  });

  it("rejects an unknown category", () => {
    expect(
      ExtractFactsOutput.safeParse({
        facts: [{ category: "hobby", text: "x", evidence_span: "x" }],
      }).success,
    ).toBe(false);
  });

  it("requires the quoted resume span", () => {
    expect(
      ExtractFactsOutput.safeParse({ facts: [{ category: "skill", text: "x" }] })
        .success,
    ).toBe(false);
  });
});

describe("SCHEMA_BY_STEP", () => {
  it("has an entry for every step in the DB enum", () => {
    expect(Object.keys(SCHEMA_BY_STEP).sort()).toEqual(
      [...stepEnum.enumValues].sort(),
    );
  });
});
