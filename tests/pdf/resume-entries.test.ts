/**
 * The QA blocker this file guards: "the generated resume PDF is not a usable
 * resume … EXPERIENCE and PROJECTS render as anonymous bullet lists with no
 * company, no job title, no dates and no project names, and EDUCATION
 * restates the same two facts three times".
 *
 * So these tests read the *rendered bytes* back (`extractPdfText`, the same
 * extractor onboarding uses on an uploaded resume — i.e. roughly what an ATS
 * sees) rather than asserting on props: a header that renders but does not
 * make it into the PDF's text layer would still be unreadable to a recruiter's
 * parser.
 */

import { describe, expect, it } from "vitest";
import { renderResumePdf } from "@/src/pdf/render";
import {
  dedupeEducationLines,
  extraSections,
  formatDateRange,
} from "@/src/pdf/ResumeDocument";
import { extractPdfText } from "@/src/profile/resume-text";
import type { Fact, TailorOutput } from "@/src/pipeline/schemas";

const PROFILE = {
  name: "Dana Okonkwo",
  email: "dana@okonkwo.dev",
  phone: "555-0143",
  links: ["github.com/danaok"],
};

const TAILOR: TailorOutput = {
  summary: "Backend-leaning new grad with production data-pipeline experience.",
  skills: ["Python", "SQL", "TypeScript"],
  sections: [],
  experience: [
    {
      organization: "City of Calgary",
      role: "Software Engineer (Capstone Project)",
      location: "Calgary, AB",
      start: "September 2025",
      end: "Present",
      bullets: [
        {
          text: "Built an automated pipeline centralizing GHG data from 4 business units.",
          fact_ids: ["F-001"],
        },
      ],
    },
    {
      organization: "DATech",
      role: "Prompt Engineer",
      location: "Remote",
      start: "April 2024",
      end: "March 2025",
      bullets: [
        { text: "Evaluated 1,000+ AI-generated code samples.", fact_ids: ["F-002"] },
      ],
    },
  ],
  projects: [
    {
      name: "KanDoIt",
      technologies: "Next.js, Prisma, PostgreSQL",
      bullets: [
        { text: "Shipped role-based access control over a REST API.", fact_ids: ["F-003"] },
      ],
    },
  ],
};

/** The exact triple QA saw printed three times over. */
const DUPLICATED_EDUCATION: Fact[] = [
  {
    label: "F-010",
    category: "education",
    text: "University of Calgary Bachelor of Science in Computer Science Expected Dec 2026",
  },
  {
    label: "F-011",
    category: "education",
    text: "Coursework: Database Systems, Data Structures & Algorithms, Software Engineering, Operating Systems, Networks",
  },
  {
    label: "F-012",
    category: "education",
    text: "Candidate is pursuing a Bachelor of Science in Computer Science at University of Calgary, expected to graduate December 2026.",
  },
  {
    label: "F-013",
    category: "education",
    text: "Completed coursework in Database Systems, Data Structures & Algorithms, Software Engineering, Operating Systems, and Networks at University of Calgary.",
  },
  {
    label: "F-014",
    category: "education",
    text: "Holds certifications in Microsoft Azure Fundamentals, Machine Learning (Coursera), and Full Stack Web Development (Udemy).",
  },
];

describe("formatDateRange", () => {
  it("joins both ends with an en dash", () => {
    expect(formatDateRange("June 2025", "Present")).toBe("June 2025 – Present");
  });

  it("prints whichever end the facts gave, and nothing when they gave neither", () => {
    expect(formatDateRange("June 2025", "")).toBe("June 2025");
    expect(formatDateRange("", "Dec 2026")).toBe("Dec 2026");
    expect(formatDateRange("", "")).toBe("");
    expect(formatDateRange(undefined, undefined)).toBe("");
  });
});

describe("dedupeEducationLines", () => {
  it("drops restatements that add no word the kept lines did not have", () => {
    const lines = dedupeEducationLines(DUPLICATED_EDUCATION);
    expect(lines).toEqual([
      DUPLICATED_EDUCATION[0].text,
      DUPLICATED_EDUCATION[1].text,
      DUPLICATED_EDUCATION[4].text,
    ]);
  });

  it("keeps a second, genuinely different degree", () => {
    const lines = dedupeEducationLines([
      { label: "F-1", category: "education", text: "Bachelor of Science in Computer Science, University of Calgary, 2026" },
      { label: "F-2", category: "education", text: "Master of Science in Computer Science, University of Calgary, 2028" },
    ]);
    expect(lines).toHaveLength(2);
  });

  it("keeps short lines even when every word repeats, and skips blanks", () => {
    const lines = dedupeEducationLines([
      { label: "F-1", category: "education", text: "Dean's List 2024" },
      { label: "F-2", category: "education", text: "Dean's List" },
      { label: "F-3", category: "education", text: "   " },
    ]);
    expect(lines).toEqual(["Dean's List 2024", "Dean's List"]);
  });
});

describe("extraSections", () => {
  it("drops Experience/Projects sections once the structured entries exist", () => {
    const withDupes: TailorOutput = {
      ...TAILOR,
      sections: [
        { heading: "Experience", bullets: [{ text: "dupe", fact_ids: ["F-001"] }] },
        { heading: "Projects", bullets: [{ text: "dupe", fact_ids: ["F-003"] }] },
        { heading: "Education", bullets: [{ text: "dupe", fact_ids: ["F-010"] }] },
        { heading: "Leadership", bullets: [{ text: "kept", fact_ids: ["F-004"] }] },
      ],
    };
    expect(extraSections(withDupes).map((s) => s.heading)).toEqual(["Leadership"]);
  });

  it("keeps a legacy generation's loose Experience section — it is all it has", () => {
    const legacy: TailorOutput = {
      summary: TAILOR.summary,
      skills: TAILOR.skills,
      sections: [
        { heading: "Experience", bullets: [{ text: "Built things.", fact_ids: ["F-001"] }] },
        { heading: "Education", bullets: [{ text: "Studied things.", fact_ids: ["F-010"] }] },
      ],
    };
    expect(extraSections(legacy).map((s) => s.heading)).toEqual(["Experience"]);
  });
});

describe("renderResumePdf — entry headers in the rendered bytes", () => {
  it("prints every employer with its title, location and date range", async () => {
    const pdf = await renderResumePdf({
      profile: PROFILE,
      tailor: TAILOR,
      education: DUPLICATED_EDUCATION,
    });
    const text = (await extractPdfText(pdf)).replace(/\s+/g, " ");

    for (const expected of [
      "City of Calgary",
      "Software Engineer (Capstone Project)",
      "Calgary, AB",
      "September 2025 – Present",
      "DATech",
      "Prompt Engineer",
      "April 2024 – March 2025",
    ]) {
      expect(text).toContain(expected);
    }
  });

  it("prints project names with their stack", async () => {
    const pdf = await renderResumePdf({
      profile: PROFILE,
      tailor: TAILOR,
      education: [],
    });
    const text = (await extractPdfText(pdf)).replace(/\s+/g, " ");
    expect(text).toContain("KanDoIt");
    expect(text).toContain("Next.js, Prisma, PostgreSQL");
  });

  it("prints the degree once, not three times", async () => {
    const pdf = await renderResumePdf({
      profile: PROFILE,
      tailor: TAILOR,
      education: DUPLICATED_EDUCATION,
    });
    const text = (await extractPdfText(pdf)).replace(/\s+/g, " ");
    const degreeMentions = text.match(/Bachelor of Science/g) ?? [];
    expect(degreeMentions).toHaveLength(1);
    expect(text).not.toContain("Candidate is pursuing");
    // The certifications line is not a restatement and must survive.
    expect(text).toContain("Microsoft Azure Fundamentals");
  });

  it("still renders a pre-1.2.0 generation's loose bullets", async () => {
    const legacy: TailorOutput = {
      summary: TAILOR.summary,
      skills: TAILOR.skills,
      sections: [
        {
          heading: "Experience",
          bullets: [{ text: "Built a job-tracking pipeline used daily.", fact_ids: ["F-001"] }],
        },
      ],
    };
    const pdf = await renderResumePdf({ profile: PROFILE, tailor: legacy, education: [] });
    const text = (await extractPdfText(pdf)).replace(/\s+/g, " ");
    expect(text).toContain("Built a job-tracking pipeline used daily.");
  });
});
