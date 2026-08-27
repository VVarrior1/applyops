/**
 * The single-column react-pdf resume template — plan Task 9 Step 1.
 *
 * Layout mirrors v1's `resume.tex` order (see the v1 code map:
 * "sections in order: Technical Skills, Education, Experience, Projects"):
 * header → summary → skills → education (fixed, from the user's confirmed
 * `education`-category facts) → the `tailor` step's own sections (typically
 * Experience then Projects), rendered in the order the model produced them
 * since `TailorOutput.sections` is already "ordered by relevance to the
 * posting" (`src/pipeline/schemas.ts`).
 *
 * This component renders exactly what it is given — it does not itself run
 * the hallucination check. `renderResumePdf()`'s caller (`app/api/jobs/[id]/
 * pdf/route.ts`) is responsible for stripping unsupported bullets first
 * (`stripUnsupportedBullets()` in `src/pipeline/hallucination.ts`), so no
 * unverified claim can reach a PDF regardless of what a client sends.
 */

import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { Fact, TailorOutput } from "../pipeline/schemas";

export interface ResumeProfile {
  name: string;
  email: string;
  phone: string;
  links: string[];
}

export interface RenderResumeInput {
  profile: ResumeProfile;
  tailor: TailorOutput;
  education: Fact[];
}

const styles = StyleSheet.create({
  page: {
    paddingTop: 36,
    paddingBottom: 36,
    paddingHorizontal: 42,
    fontSize: 10,
    fontFamily: "Helvetica",
    color: "#1a1a1a",
  },
  name: {
    fontSize: 20,
    fontFamily: "Helvetica-Bold",
    marginBottom: 3,
  },
  contactLine: {
    fontSize: 9,
    color: "#444444",
    marginBottom: 12,
  },
  summary: {
    fontSize: 10,
    lineHeight: 1.4,
    marginBottom: 12,
  },
  sectionHeading: {
    fontSize: 11,
    fontFamily: "Helvetica-Bold",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    borderBottomWidth: 1,
    borderBottomColor: "#1a1a1a",
    paddingBottom: 2,
    marginBottom: 6,
  },
  section: {
    marginBottom: 12,
  },
  skillsLine: {
    fontSize: 10,
    lineHeight: 1.5,
  },
  subheading: {
    fontSize: 10,
    fontFamily: "Helvetica-Bold",
    marginBottom: 2,
  },
  bulletRow: {
    flexDirection: "row",
    marginBottom: 2,
    paddingRight: 4,
  },
  bulletMark: {
    width: 10,
    fontSize: 10,
  },
  bulletText: {
    flex: 1,
    fontSize: 10,
    lineHeight: 1.35,
  },
  educationLine: {
    fontSize: 10,
    lineHeight: 1.4,
    marginBottom: 2,
  },
});

function ContactLine({ profile }: { profile: ResumeProfile }) {
  const parts = [profile.email, profile.phone, ...profile.links].filter(
    (part) => part && part.trim().length > 0,
  );
  if (parts.length === 0) return null;
  return <Text style={styles.contactLine}>{parts.join("  |  ")}</Text>;
}

function SkillsSection({ skills }: { skills: string[] }) {
  if (skills.length === 0) return null;
  return (
    <View style={styles.section}>
      <Text style={styles.sectionHeading}>Skills</Text>
      <Text style={styles.skillsLine}>{skills.join("  •  ")}</Text>
    </View>
  );
}

function EducationSection({ education }: { education: Fact[] }) {
  if (education.length === 0) return null;
  return (
    <View style={styles.section}>
      <Text style={styles.sectionHeading}>Education</Text>
      {education.map((fact) => (
        <Text key={fact.label} style={styles.educationLine}>
          {fact.text}
        </Text>
      ))}
    </View>
  );
}

function TailorSection({
  heading,
  bullets,
}: {
  heading: string;
  bullets: TailorOutput["sections"][number]["bullets"];
}) {
  if (bullets.length === 0) return null;
  return (
    <View style={styles.section} wrap={false}>
      <Text style={styles.sectionHeading}>{heading}</Text>
      {bullets.map((bullet, i) => (
        <View key={i} style={styles.bulletRow}>
          <Text style={styles.bulletMark}>•</Text>
          <Text style={styles.bulletText}>{bullet.text}</Text>
        </View>
      ))}
    </View>
  );
}

/**
 * The `tailor` prompt (`src/pipeline/prompts/tailor.v1.md`) explicitly lists
 * "Education" as a typical section heading the model may produce, but this
 * template already renders a dedicated, fixed Education block from the
 * caller's `education: Fact[]` — so a model-produced "Education" section
 * would duplicate it verbatim. Filtered out here rather than in the prompt
 * (owned by a different task): whatever the model puts in it is redundant
 * with the confirmed education facts, never complementary.
 */
function isEducationHeading(heading: string): boolean {
  return heading.trim().toLowerCase() === "education";
}

/** The react-pdf `Document` element `renderResumePdf()` renders to a Buffer. */
export function ResumeDocument({ profile, tailor, education }: RenderResumeInput) {
  const nonEducationSections = tailor.sections.filter(
    (section) => !isEducationHeading(section.heading),
  );

  return (
    <Document title={`${profile.name} — Resume`.trim()}>
      <Page size="LETTER" style={styles.page}>
        <Text style={styles.name}>{profile.name || "Resume"}</Text>
        <ContactLine profile={profile} />

        {tailor.summary && <Text style={styles.summary}>{tailor.summary}</Text>}

        <SkillsSection skills={tailor.skills} />
        <EducationSection education={education} />

        {nonEducationSections.map((section, i) => (
          <TailorSection key={i} heading={section.heading} bullets={section.bullets} />
        ))}
      </Page>
    </Document>
  );
}
