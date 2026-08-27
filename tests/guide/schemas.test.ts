import { describe, it, expect } from "vitest";
import { GuideOutput } from "../../src/pipeline/schemas";
import {
  checkGuideCitations,
  stripUnsupportedGuideClaims,
} from "../../src/pipeline/steps/guide";

/** A complete, well-formed guide — the shape the `guide` step must produce. */
const SAMPLE = {
  where_you_stand:
    "You are a credible new-grad backend candidate in Calgary and a plausible one in Toronto. Your booking platform is the only thing on your profile with real users, and it is doing most of the work.",
  strengths: [
    { text: "You have shipped a service with real users, not a course project.", fact_ids: ["F-014"] },
    { text: "You have written Go professionally, which most new grads have not.", fact_ids: ["F-002", "F-014"] },
  ],
  realistic_targets: {
    role_types: ["Backend Engineer, New Grad", "Software Engineer I", "Platform Engineer"],
    company_types: ["Series B fintech", "Energy-tech scale-ups", "US companies hiring Canada-remote"],
    geographies: [
      {
        region: "Calgary",
        why: "You are already here and the energy-tech scene hires new grads.",
        notes_for_canadians: "Not applicable — this is Canada.",
      },
      {
        region: "US remote",
        why: "The postings match your stack and pay more.",
        notes_for_canadians:
          "TN is not sponsorship: a support letter plus inspection at pre-clearance, no lottery. Some employers still decline it.",
      },
    ],
  },
  gaps: [
    {
      gap: "No distributed systems work on the profile",
      why_it_matters: "It is the first thing a platform screen asks about.",
      how_to_close: "Add a queue-backed worker to the booking platform over two weekends.",
      effort: "weeks",
    },
  ],
  plan_30_60_90: {
    days_30: [
      {
        action: "Rewrite the resume around the booking platform's numbers.",
        why: "It is the strongest thing you have and it is currently third on the page.",
        fact_ids: ["F-014"],
      },
      {
        action: "Apply to 8 postings a week.",
        why: "Enough volume to learn from, few enough to tailor each one.",
        fact_ids: [],
      },
    ],
    days_60: [
      {
        action: "Ship the queue-backed worker and write it up.",
        why: "It closes the distributed-systems gap with something you can demo.",
        fact_ids: ["F-014"],
      },
    ],
    days_90: [
      {
        action: "Start applying to US-remote postings with the TN line in the cover note.",
        why: "By then the profile supports the higher bar those roles set.",
        fact_ids: [],
      },
    ],
  },
  interview_prep_focus: [
    {
      topic: "Systems design at the one-service scale",
      why: "Every posting you are targeting screens on it and your profile does not evidence it.",
      resources_hint: "Whiteboard your own booking platform, then break it deliberately.",
    },
  ],
  positioning_tips: [
    "Move the booking platform above coursework on the resume.",
    "Add one line: Canadian citizen, TN-eligible, no sponsorship required.",
  ],
  application_cadence: {
    per_week: 8,
    rationale: "Tailoring each application takes about an hour and you are still in classes.",
  },
  market_notes: ["New-grad backend postings in Calgary skew to fintech and energy tech."],
  caveats: ["This assumes you graduate in December and can start immediately."],
};

describe("GuideOutput", () => {
  it("parses a complete guide", () => {
    const parsed = GuideOutput.parse(SAMPLE);
    expect(parsed.strengths).toHaveLength(2);
    expect(parsed.gaps[0].effort).toBe("weeks");
    expect(parsed.realistic_targets.geographies[1].notes_for_canadians).toMatch(/TN/);
    expect(parsed.plan_30_60_90.days_30).toHaveLength(2);
    expect(parsed.application_cadence.per_week).toBe(8);
  });

  it("rejects an unknown effort band", () => {
    const bad = {
      ...SAMPLE,
      gaps: [{ ...SAMPLE.gaps[0], effort: "years" }],
    };
    expect(GuideOutput.safeParse(bad).success).toBe(false);
  });

  it("rejects a geography with no work-authorization note", () => {
    const bad = {
      ...SAMPLE,
      realistic_targets: {
        ...SAMPLE.realistic_targets,
        geographies: [{ region: "Toronto", why: "Deepest market." }],
      },
    };
    expect(GuideOutput.safeParse(bad).success).toBe(false);
  });

  it("rejects a non-integer application cadence", () => {
    const bad = {
      ...SAMPLE,
      application_cadence: { per_week: 8.5, rationale: "why" },
    };
    expect(GuideOutput.safeParse(bad).success).toBe(false);
  });
});

describe("checkGuideCitations", () => {
  const labels = new Set(["F-002", "F-014"]);

  it("passes a fully grounded guide", () => {
    const report = checkGuideCitations(GuideOutput.parse(SAMPLE), labels);
    expect(report.unsupported).toEqual([]);
    expect(report.rate).toBe(0);
    // 2 strengths + 4 plan actions
    expect(report.totalClaims).toBe(6);
  });

  it("flags a strength with no citation at all", () => {
    const guide = GuideOutput.parse({
      ...SAMPLE,
      strengths: [{ text: "You are a strong communicator.", fact_ids: [] }],
    });
    const report = checkGuideCitations(guide, labels);
    expect(report.unsupported).toHaveLength(1);
    expect(report.unsupported[0].path).toBe("strengths[0]");
    expect(report.unsupported[0].badIds).toEqual([]);
  });

  it("flags an invented label anywhere, including on a plan action", () => {
    const guide = GuideOutput.parse({
      ...SAMPLE,
      plan_30_60_90: {
        ...SAMPLE.plan_30_60_90,
        days_60: [
          { action: "Extend the ML pipeline.", why: "Builds on your work.", fact_ids: ["F-099"] },
        ],
      },
    });
    const report = checkGuideCitations(guide, labels);
    expect(report.unsupported.map((c) => c.path)).toEqual(["plan_30_60_90.days_60[0]"]);
    expect(report.unsupported[0].badIds).toEqual(["F-099"]);
  });

  it("does not flag an uncited plan action — it makes no claim about the candidate", () => {
    const guide = GuideOutput.parse(SAMPLE);
    const report = checkGuideCitations(guide, labels);
    const uncited = guide.plan_30_60_90.days_30[1];
    expect(uncited.fact_ids).toEqual([]);
    expect(report.unsupported).toEqual([]);
  });

  it("accepts a label in the wrong case", () => {
    const guide = GuideOutput.parse({
      ...SAMPLE,
      strengths: [{ text: "Shipped a real service.", fact_ids: [" f-014 "] }],
    });
    expect(checkGuideCitations(guide, labels).unsupported).toEqual([]);
  });
});

describe("stripUnsupportedGuideClaims", () => {
  const labels = new Set(["F-014"]);

  it("removes exactly the unsupported claims and leaves the rest", () => {
    const guide = GuideOutput.parse({
      ...SAMPLE,
      strengths: [
        { text: "Grounded.", fact_ids: ["F-014"] },
        { text: "Invented.", fact_ids: ["F-404"] },
      ],
    });
    const report = checkGuideCitations(guide, labels);
    const stripped = stripUnsupportedGuideClaims(guide, report);

    expect(stripped.strengths).toHaveLength(1);
    expect(stripped.strengths[0].text).toBe("Grounded.");
    // Everything else survives untouched.
    expect(stripped.where_you_stand).toBe(guide.where_you_stand);
    expect(stripped.gaps).toEqual(guide.gaps);
  });

  it("returns the same object when nothing is unsupported", () => {
    const guide = GuideOutput.parse(SAMPLE);
    const report = checkGuideCitations(guide, new Set(["F-002", "F-014"]));
    expect(stripUnsupportedGuideClaims(guide, report)).toBe(guide);
  });
});
