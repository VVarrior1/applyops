/**
 * The single-column react-pdf resume template — plan Task 9 Step 1.
 *
 * Layout mirrors v1's `resume.tex` order (see the v1 code map: "sections in
 * order: Technical Skills, Education, Experience, Projects"): header →
 * summary → skills → education (fixed, from the user's confirmed
 * `education`-category facts) → experience → projects → any extra sections
 * the `tailor` step produced, in the order it produced them.
 *
 * ## Entries, not anonymous bullets
 *
 * Experience and Projects are rendered from `TailorOutput.experience` and
 * `TailorOutput.projects`, which carry the *identity* of each entry —
 * employer, job title, location, date range; project name and stack — so the
 * page reads like v1's `\resumeSubheading` blocks and an ATS can parse an
 * employment history out of it. A `tailor` generation written before those
 * fields existed has neither, and falls back to its loose `sections` bullets
 * (which is exactly what it used to render).
 *
 * This component renders exactly what it is given — it does not itself run
 * the hallucination check. `renderResumePdf()`'s caller (`app/api/jobs/[id]/
 * pdf/route.ts`) is responsible for stripping unsupported bullets first
 * (`stripUnsupportedBullets()` in `src/pipeline/hallucination.ts`), so no
 * unverified claim can reach a PDF regardless of what a client sends.
 */

import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import { isExperienceHeading, isProjectsHeading } from "./headings";
import type { CitedBullet, Fact, TailorOutput } from "../pipeline/schemas";

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
  entry: {
    marginBottom: 7,
  },
  entryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  entryOrg: {
    fontSize: 10.5,
    fontFamily: "Helvetica-Bold",
    flex: 1,
    paddingRight: 8,
  },
  entryDates: {
    fontSize: 9.5,
    color: "#333333",
    textAlign: "right",
  },
  entryRole: {
    fontSize: 10,
    fontFamily: "Helvetica-Oblique",
    flex: 1,
    paddingRight: 8,
  },
  entryLocation: {
    fontSize: 9.5,
    fontFamily: "Helvetica-Oblique",
    color: "#333333",
    textAlign: "right",
  },
  projectName: {
    fontSize: 10.5,
    fontFamily: "Helvetica-Bold",
  },
  projectStack: {
    fontSize: 9.5,
    fontFamily: "Helvetica-Oblique",
    color: "#333333",
  },
  bulletList: {
    marginTop: 2,
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
  educationDegree: {
    fontSize: 10.5,
    fontFamily: "Helvetica-Bold",
    lineHeight: 1.4,
    marginBottom: 2,
  },
});

function nonEmpty(value: string | undefined | null): string {
  return (value ?? "").trim();
}

/** `June 2025 – Present`, `June 2025`, `Present`, or `""`. */
export function formatDateRange(start?: string, end?: string): string {
  const from = nonEmpty(start);
  const to = nonEmpty(end);
  if (from && to) return `${from} – ${to}`;
  return from || to;
}

function ContactLine({ profile }: { profile: ResumeProfile }) {
  const parts = [profile.email, profile.phone, ...profile.links].filter(
    (part) => part && part.trim().length > 0,
  );
  if (parts.length === 0) return null;
  return <Text style={styles.contactLine}>{parts.join("  |  ")}</Text>;
}

function Bullets({ bullets }: { bullets: CitedBullet[] }) {
  if (bullets.length === 0) return null;
  return (
    <View style={styles.bulletList}>
      {bullets.map((bullet, i) => (
        <View key={i} style={styles.bulletRow}>
          <Text style={styles.bulletMark}>•</Text>
          <Text style={styles.bulletText}>{bullet.text}</Text>
        </View>
      ))}
    </View>
  );
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

// ---------------------------------------------------------------------------
// Education
// ---------------------------------------------------------------------------

const MONTHS: Record<string, string> = {
  jan: "january",
  feb: "february",
  mar: "march",
  apr: "april",
  jun: "june",
  jul: "july",
  aug: "august",
  sep: "september",
  sept: "september",
  oct: "october",
  nov: "november",
  dec: "december",
};

/**
 * Words that carry no information about *which* education fact this is. They
 * are the connective tissue extraction adds when it restates a line ("the
 * candidate is pursuing…", "completed coursework in…"), and leaving them in
 * would make two restatements of the same degree look distinct.
 */
const EDUCATION_FILLER = new Set([
  "a", "an", "and", "the", "at", "in", "of", "on", "to", "with", "for", "from",
  "is", "was", "are", "as", "his", "her", "their",
  "candidate", "currently", "expected", "expects", "graduate", "graduating",
  "graduation", "completed", "completing", "complete", "pursuing", "pursued",
  "studying", "studied", "holds", "hold", "held", "earned", "earning",
  "received", "including", "includes", "include", "also", "degree", "student",
]);

/** Lowercased, depunctuated, month-expanded, crudely singularised. */
function educationToken(raw: string): string {
  const word = raw.toLowerCase().replace(/[^a-z0-9+#]/g, "");
  if (!word) return "";
  const month = MONTHS[word];
  if (month) return month;
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) {
    return word.slice(0, -1);
  }
  return word;
}

function educationTokens(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.split(/[\s,;/()]+/)) {
    const token = educationToken(raw);
    if (token && !EDUCATION_FILLER.has(token)) seen.add(token);
  }
  return [...seen];
}

/**
 * Drop education facts that say nothing the earlier ones did not.
 *
 * `extract_facts` happily emits the same degree three times — the degree line,
 * a sentence restating it ("Candidate is pursuing a Bachelor of Science… ,
 * expected to graduate December 2026."), and a sentence restating the
 * coursework line — because each is a genuinely separate span of the source
 * resume. Printed verbatim, that is the same two facts three times on a page
 * that is meant to be scanned in six seconds.
 *
 * The rule is deliberately strict: a line is dropped only when **every** one
 * of its meaningful words has already appeared in a line that was kept (and
 * it has at least three of them). "Master of Science" after "Bachelor of
 * Science" introduces `master` and survives; "Completed coursework in X, Y and
 * Z at University of Calgary" after both a degree line and a coursework line
 * introduces nothing and does not. No model call, no fuzzy threshold to tune.
 */
export function dedupeEducationLines(education: Fact[]): string[] {
  const kept: string[] = [];
  const seen = new Set<string>();

  for (const fact of education) {
    const text = nonEmpty(fact.text);
    if (!text) continue;
    const tokens = educationTokens(text);
    const novel = tokens.filter((token) => !seen.has(token));
    if (tokens.length >= 3 && novel.length === 0) continue;
    kept.push(text);
    for (const token of tokens) seen.add(token);
  }

  return kept;
}

function EducationSection({ education }: { education: Fact[] }) {
  const lines = dedupeEducationLines(education);
  if (lines.length === 0) return null;
  return (
    <View style={styles.section}>
      <Text style={styles.sectionHeading}>Education</Text>
      {lines.map((line, i) => (
        <Text key={i} style={i === 0 ? styles.educationDegree : styles.educationLine}>
          {line}
        </Text>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Experience / Projects
// ---------------------------------------------------------------------------

function ExperienceSection({
  entries,
}: {
  entries: NonNullable<TailorOutput["experience"]>;
}) {
  if (entries.length === 0) return null;
  return (
    <View style={styles.section}>
      <Text style={styles.sectionHeading}>Experience</Text>
      {entries.map((entry, i) => {
        const dates = formatDateRange(entry.start, entry.end);
        const role = nonEmpty(entry.role);
        const location = nonEmpty(entry.location);
        return (
          <View key={i} style={styles.entry} wrap={false}>
            <View style={styles.entryRow}>
              <Text style={styles.entryOrg}>{entry.organization}</Text>
              {dates.length > 0 && <Text style={styles.entryDates}>{dates}</Text>}
            </View>
            {(role.length > 0 || location.length > 0) && (
              <View style={styles.entryRow}>
                <Text style={styles.entryRole}>{role}</Text>
                {location.length > 0 && (
                  <Text style={styles.entryLocation}>{location}</Text>
                )}
              </View>
            )}
            <Bullets bullets={entry.bullets} />
          </View>
        );
      })}
    </View>
  );
}

function ProjectsSection({
  projects,
}: {
  projects: NonNullable<TailorOutput["projects"]>;
}) {
  if (projects.length === 0) return null;
  return (
    <View style={styles.section}>
      <Text style={styles.sectionHeading}>Projects</Text>
      {projects.map((project, i) => {
        const stack = nonEmpty(project.technologies);
        return (
          <View key={i} style={styles.entry} wrap={false}>
            <Text>
              <Text style={styles.projectName}>{project.name}</Text>
              {stack.length > 0 && <Text style={styles.projectStack}>{`  |  ${stack}`}</Text>}
            </Text>
            <Bullets bullets={project.bullets} />
          </View>
        );
      })}
    </View>
  );
}

function TailorSection({
  heading,
  bullets,
}: {
  heading: string;
  bullets: CitedBullet[];
}) {
  if (bullets.length === 0) return null;
  return (
    <View style={styles.section} wrap={false}>
      <Text style={styles.sectionHeading}>{heading}</Text>
      <Bullets bullets={bullets} />
    </View>
  );
}

function headingIs(heading: string, ...names: string[]): boolean {
  const normalized = heading.trim().toLowerCase();
  return names.some((name) => normalized === name);
}

/**
 * Which loose `sections` still deserve a block of their own.
 *
 * "Education" never does: this template writes Education from the caller's
 * confirmed `education` facts, so a model-produced Education section can only
 * duplicate it. "Experience" and "Projects" do not either *once the structured
 * `experience`/`projects` arrays are populated* — the same bullets with their
 * employer and project names attached are already on the page. For a
 * pre-1.2.0 generation those arrays are empty, and the loose sections are all
 * there is, so they stay.
 */
export function extraSections(tailor: TailorOutput) {
  const hasExperience = (tailor.experience ?? []).length > 0;
  const hasProjects = (tailor.projects ?? []).length > 0;
  return tailor.sections.filter((section) => {
    if (headingIs(section.heading, "education")) return false;
    // The predicates are shared with the derivation in `./base-entries.ts` on
    // purpose: a section may only be suppressed here if that code consumed it,
    // and may only be consumed there if this code suppresses it. When the two
    // disagreed, "Relevant Projects" was consumed *and* kept and every bullet
    // printed twice.
    if (hasExperience && isExperienceHeading(section.heading)) return false;
    if (hasProjects && isProjectsHeading(section.heading)) return false;
    return true;
  });
}

/**
 * The PDF's `Title` metadata — what a recruiter's viewer shows in its window
 * chrome and what an ATS often files the document under.
 *
 * Built from the name rather than interpolated blindly: `${name} — Resume`
 * on an empty name produced a document literally titled " — Resume", and on
 * the seed row QA hit it produced "ApplyOps Test Resume — Resume". The name
 * itself is now guaranteed real by the `checkContact()` gate in
 * `app/api/jobs/[id]/pdf/route.ts`; this only keeps the *shape* of the title
 * sane when the renderer is driven directly (the CLI, tests).
 */
export function documentTitle(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "Resume";
  // Accent-folded so "Résumé" counts too — a name that already says "resume"
  // should not become "… Resume — Resume".
  const folded = trimmed
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return folded.includes("resume") ? trimmed : `${trimmed} — Resume`;
}

/** The react-pdf `Document` element `renderResumePdf()` renders to a Buffer. */
export function ResumeDocument({ profile, tailor, education }: RenderResumeInput) {
  const experience = tailor.experience ?? [];
  const projects = tailor.projects ?? [];

  return (
    <Document title={documentTitle(profile.name)} author={profile.name.trim() || undefined}>
      <Page size="LETTER" style={styles.page}>
        <Text style={styles.name}>{profile.name || "Resume"}</Text>
        <ContactLine profile={profile} />

        {tailor.summary && <Text style={styles.summary}>{tailor.summary}</Text>}

        <SkillsSection skills={tailor.skills} />
        <EducationSection education={education} />
        <ExperienceSection entries={experience} />
        <ProjectsSection projects={projects} />

        {extraSections(tailor).map((section, i) => (
          <TailorSection key={i} heading={section.heading} bullets={section.bullets} />
        ))}
      </Page>
    </Document>
  );
}
