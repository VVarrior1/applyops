/**
 * The v1 LaTeX resume pipeline, ported.
 *
 * v1 (`Job_Auto_Apply/lib/latex.ts`) never *generated* a resume. It took the
 * candidate's real, hand-tuned `resume.tex` — Jake's-template style, with the
 * heading, education and experience the owner had spent years wording — and
 * replaced exactly two blocks in it per posting: **Technical Skills** and
 * **Projects**. Then `pdflatex` twice, and optionally a Ghostscript merge with
 * their transcript. Everything else came out byte-identical every time.
 *
 * v2's first cut replaced that with a react-pdf template drawn from the
 * `tailor` step's output alone, which is why the owner reported v2's PDFs as
 * worse than v1's: a generated page cannot reproduce a document its author
 * spent years tuning. This module restores the v1 model on top of v2's data
 * (`resume_bases.latex` + `TailorOutput`).
 *
 * ## What is a faithful port and what had to be adapted
 *
 * Faithful, deliberately unchanged:
 *   - {@link escapeLatex} — same replacement list, same order.
 *   - The two splice regexes ({@link SKILLS_REGEX}, {@link PROJECTS_START_REGEX},
 *     {@link PROJECTS_END_REGEX}) are v1's, character for character. They are
 *     load-bearing: they are what makes "replace two blocks, touch nothing
 *     else" true, and `tests/pdf/latex.test.ts` asserts byte-identity of every
 *     other section against a fixture.
 *   - The emitted `\item \resumeProjectHeading{...}{}` /
 *     `\resumeItemListStart` … `\resumeItemListEnd` block shape.
 *   - `pdflatex -interaction=nonstopmode`, run twice, 60 s each; a PDF that
 *     exists despite a non-zero exit is accepted (LaTeX warns constantly).
 *   - `gs -dBATCH -dNOPAUSE -q -sDEVICE=pdfwrite` to append the transcript.
 *
 * Adapted, because v2's tailored output has a different shape:
 *   - v1 had `top_skills` + `remaining_skills`; v2's `TailorOutput` has one
 *     ordered `skills: string[]`. The "Familiar:" half of the skills line is
 *     no longer a hardcoded constant — it is lifted out of the *base* resume's
 *     own skills block, so a user's own wording survives (v1's list is only
 *     the fallback, see {@link DEFAULT_FAMILIAR_SKILLS}).
 *   - v1 had `selected_projects: {name, technologies, tailored_description}`.
 *     v2's `TailorOutput.projects` is the direct equivalent (added for this
 *     purpose — see `src/pipeline/schemas.ts`), and when a named project also
 *     exists in the base `.tex`, the base's *raw* heading is reused verbatim
 *     rather than re-escaped, so `\href` links and colours survive.
 *   - Generations made before `projects` existed only have a "Projects"
 *     section of loose bullets; {@link deriveProjectsFromSections} maps those
 *     back onto the base's real projects so old rows still render. See its
 *     doc comment for the (deterministic) rule.
 *
 * Everything here is filesystem-and-subprocess only — no database, no network,
 * no LLM. Unit-tested in `tests/pdf/latex.test.ts`.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { TailorOutput } from "../pipeline/schemas";

const execFileAsync = promisify(execFile);

/** v1 ran `pdflatex` twice with a 60 s timeout on each pass. */
export const PDFLATEX_TIMEOUT_MS = 60_000;
/** v1's Ghostscript merge timeout. */
export const GHOSTSCRIPT_TIMEOUT_MS = 30_000;

/**
 * Directories prepended to `PATH` for the `pdflatex`/`gs` lookups.
 *
 * MacTeX installs `pdflatex` into `/Library/TeX/texbin`, which is added to an
 * interactive shell's `PATH` by a `/etc/paths.d` entry — a Next.js server or a
 * launchd-started process inherits none of that. `which pdflatex` succeeding
 * in a terminal therefore says nothing about the app being able to find it,
 * which is exactly the "works on my machine" failure this pipeline must not
 * have. Both {@link isLatexAvailable} and the compile use this same augmented
 * environment so the probe and the real call can never disagree.
 */
export const LATEX_PATH_DIRS = [
  "/Library/TeX/texbin",
  "/usr/local/texlive/bin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
];

function latexEnv(): NodeJS.ProcessEnv {
  const existing = process.env.PATH ?? "";
  const parts = existing.split(path.delimiter).filter(Boolean);
  for (const dir of LATEX_PATH_DIRS) {
    if (!parts.includes(dir)) parts.push(dir);
  }
  return { ...process.env, PATH: parts.join(path.delimiter) };
}

/**
 * Thrown when a LaTeX render is asked for on a host with no `pdflatex`.
 *
 * A distinct class (rather than a bare `Error`) so callers can tell "this
 * machine cannot do LaTeX, fall back to react-pdf" apart from "this document
 * failed to compile", which is a real bug worth surfacing.
 */
export class LatexUnavailableError extends Error {
  constructor(message?: string) {
    super(
      message ??
        "pdflatex was not found on this host. Install a TeX distribution " +
          "(macOS: MacTeX / BasicTeX, Debian: texlive-latex-recommended) or " +
          "set PDFLATEX_BIN to its full path. Without it, ApplyOps falls back " +
          "to the react-pdf renderer.",
    );
    this.name = "LatexUnavailableError";
  }
}

/** Thrown when `pdflatex` ran but produced no PDF. */
export class LatexCompileError extends Error {
  /** The tail of the `.log`, which is where the real reason lives. */
  readonly log: string;
  constructor(message: string, log: string) {
    super(message);
    this.name = "LatexCompileError";
    this.log = log;
  }
}

function pdflatexBin(): string {
  return process.env.PDFLATEX_BIN?.trim() || "pdflatex";
}

function ghostscriptBin(): string {
  return process.env.GHOSTSCRIPT_BIN?.trim() || "gs";
}

/**
 * v1's `isLatexInstalled()`, renamed to the name the rest of v2 calls it by.
 *
 * Resolved through the same augmented `PATH` the compile uses (see
 * {@link LATEX_PATH_DIRS}), and cached per process: the PDF route calls this
 * on every download and spawning `which` each time is pure latency for an
 * answer that cannot change while the server is up.
 */
let latexAvailable: boolean | undefined;

export async function isLatexAvailable(): Promise<boolean> {
  if (latexAvailable !== undefined) return latexAvailable;
  const bin = pdflatexBin();
  if (path.isAbsolute(bin)) {
    latexAvailable = existsSync(bin);
    return latexAvailable;
  }
  try {
    await execFileAsync("which", [bin], { env: latexEnv(), timeout: 5_000 });
    latexAvailable = true;
  } catch {
    latexAvailable = false;
  }
  return latexAvailable;
}

/** Test seam — forget the cached {@link isLatexAvailable} answer. */
export function resetLatexAvailabilityCache(): void {
  latexAvailable = undefined;
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

/**
 * v1's `escapeLatex`, unchanged — same characters, same order.
 *
 * Including one quirk, deliberately preserved: `\` is rewritten to
 * `\textbackslash{}` *first*, and the `{`/`}` rules then run over the braces
 * that replacement just introduced, so a literal backslash comes out as
 * `\textbackslash\{\}` — valid, safe LaTeX that renders as `\{}` rather
 * than `\`. Every other character is escaped exactly right, resume bullets do
 * not contain backslashes, and changing the order here would change the output
 * of a pipeline whose whole promise is byte-stability. `tests/pdf/latex.test.ts`
 * pins the current behaviour so a future fix is a deliberate one.
 */
export function escapeLatex(text: string): string {
  return text
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/{/g, "\\{")
    .replace(/}/g, "\\}")
    .replace(/\$/g, "\\$")
    .replace(/#/g, "\\#")
    .replace(/&/g, "\\&")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
}

// ---------------------------------------------------------------------------
// Technical Skills
// ---------------------------------------------------------------------------

/**
 * v1's `skillsRegex`, character for character.
 *
 * Three capture groups: everything up to and including the opening
 * `\small{\item{`, the block's current contents, and the closing
 * `}}\end{itemize}`. Only group 2 is replaced, so the `%---...---` banner
 * comment and the `\begin{itemize}` options stay exactly as the author wrote
 * them.
 */
export const SKILLS_REGEX =
  /(%-----------TECHNICAL SKILLS-----------[\s\S]*?\\section{Technical Skills}[\s\S]*?\\begin{itemize}\[leftmargin=0.15in, label={}\]\s*\\small{\\item{\s*)([\s\S]*?)(}\s*}\s*\\end{itemize})/;

/**
 * The "Familiar:" half of v1's skills line. Only a fallback now — a base
 * resume that already has a `\textbf{Familiar}{: ...}` keeps its own list.
 */
export const DEFAULT_FAMILIAR_SKILLS = [
  "C",
  "C++",
  "C#",
  "AWS",
  "CI/CD",
  "Agile Methodologies",
  "UX/UI Principles",
];

const FAMILIAR_LINE_REGEX = /\\textbf\{Familiar\}\{:\s*([^}]*)\}/;

/** Splits a rendered `Familiar` line back into individual skill names. */
function parseFamiliar(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Replaces the Technical Skills block, v1's `replaceSkillsSection`.
 *
 * Differences from v1, both forced by v2's data model:
 *   - `skills` is one ordered list (v2's `TailorOutput.skills`) rather than
 *     v1's `top_skills` + `remaining_skills` pair; the concatenation v1 did
 *     has already happened by the time the model answers.
 *   - the Familiar list is read out of the base document instead of being a
 *     constant, so this works for a user who is not the owner. Skills already
 *     claimed as "Familiar" are filtered out of the Proficient list — v1's
 *     rule, generalised past its hardcoded array.
 *
 * Returns `content` unchanged when the base has no Technical Skills block
 * matching the regex (a resume built from a different template), which is the
 * same "leave it alone rather than corrupt it" stance v1 took for projects.
 */
export function replaceSkillsSection(
  content: string,
  skills: readonly string[],
): string {
  const match = content.match(SKILLS_REGEX);
  if (!match) return content;

  const existingFamiliar = match[2].match(FAMILIAR_LINE_REGEX)?.[1];
  const familiarList = existingFamiliar
    ? parseFamiliar(existingFamiliar)
    : DEFAULT_FAMILIAR_SKILLS;
  const familiarLower = new Set(familiarList.map((s) => s.toLowerCase()));

  const proficient = [
    ...new Set(skills.map((s) => s.trim()).filter(Boolean)),
  ].filter((skill) => !familiarLower.has(skill.toLowerCase()));

  // An empty Proficient line would compile to a stray colon; if the tailored
  // skills all turned out to be "Familiar" ones, leave the base alone.
  if (proficient.length === 0) return content;

  const proficientTex = proficient.map(escapeLatex).join(", ");
  // Already-LaTeX when it came from the base document (`C\#`), so only escape
  // the fallback constants.
  const familiarTex = existingFamiliar
    ? existingFamiliar.trim()
    : familiarList.map(escapeLatex).join(", ");

  const newSkillsContent = `\\textbf{Proficient}{: ${proficientTex}} \\\\
    \\textbf{Familiar}{: ${familiarTex}}`;

  return content.replace(SKILLS_REGEX, `$1${newSkillsContent}$3`);
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/**
 * v1's `projectsStartRegex` / `projectsEndRegex`.
 *
 * One mechanical change, semantics identical: v1 wrote `.*?` with the `s`
 * (dotAll) flag, which this repo's `target: ES2017` cannot express. `[\s\S]*?`
 * is the same character class the flag produces, and `PROJECTS_END_REGEX`
 * contains no `.` at all, so the flag was doing nothing there.
 */
export const PROJECTS_START_REGEX =
  /%-----------PROJECTS-----------[\s\S]*?\\section{Projects}\s*\\resumeSubHeadingListStart/;
export const PROJECTS_END_REGEX = /\\resumeSubHeadingListEnd\s*\\end{document}/;

/** v1's closing line, used only when the base has no note of its own. */
export const DEFAULT_PROJECTS_NOTE =
  "\\small{\\item{\\textit{Additional projects available at request, including production apps and ML systems}}}";

/** The most bullets any one project gets — v1 rendered exactly one. */
export const MAX_BULLETS_PER_PROJECT = 3;

/** One `\resumeProjectHeading` block found in a base `.tex`. */
export interface BaseProject {
  /** First argument of `\resumeProjectHeading`, braces excluded, verbatim. */
  headingRaw: string;
  /** Plain-text project name (before the `$|$` technologies separator). */
  name: string;
  /** Plain-text technologies (after the `$|$`), `""` when there is none. */
  technologies: string;
}

/** A project ready to be written into the Projects block. */
export interface ResolvedProject {
  /** Raw LaTeX for the heading argument. Already escaped or reused verbatim. */
  headingRaw: string;
  bullets: string[];
}

/**
 * Reads the balanced `{...}` group starting at `src[start]` (which must be
 * `{`). Returns the contents and the index just past the closing brace.
 * Backslash-escaped braces (`\{`, `\}`) do not count toward the balance —
 * `\{` is a literal brace in LaTeX, not a group delimiter.
 */
function readBalancedGroup(
  src: string,
  start: number,
): { value: string; end: number } | null {
  if (src[start] !== "{") return null;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\") {
      i++; // skip the escaped character, whatever it is
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { value: src.slice(start + 1, i), end: i + 1 };
    }
  }
  return null;
}

/**
 * Strips LaTeX markup down to the text a human reads.
 *
 * `\href` and `\textcolor` lose their *first* argument (a URL and a colour
 * name — neither is text); every other control sequence is simply dropped and
 * its braces fall away, which leaves the argument, and for `\textbf{X}` /
 * `\emph{X}` the argument is exactly the text wanted.
 */
export function latexToPlain(source: string): string {
  return source
    .replace(/\\href\s*\{[^{}]*\}/g, "")
    .replace(/\\textcolor\s*\{[^{}]*\}/g, "")
    .replace(/\\[a-zA-Z]+\s*/g, "")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pulls every `\resumeProjectHeading` out of a base `.tex`'s Projects block.
 *
 * Brace-balanced rather than regex-matched: a heading like
 * `{\textbf{\href{...}{\textcolor{myblue}{CYD Soccer}}} $|$ \emph{Next.js}}`
 * nests four levels deep, and `\{[^}]*\}` would stop at the first `}`.
 */
export function extractBaseProjects(content: string): BaseProject[] {
  const region = projectsRegion(content);
  if (!region) return [];

  const projects: BaseProject[] = [];
  const marker = "\\resumeProjectHeading";
  let cursor = 0;
  for (;;) {
    const at = region.body.indexOf(marker, cursor);
    if (at === -1) break;
    let i = at + marker.length;
    while (i < region.body.length && /\s/.test(region.body[i])) i++;
    const first = readBalancedGroup(region.body, i);
    if (!first) {
      cursor = at + marker.length;
      continue;
    }
    const [namePart, techPart] = first.value.split("$|$");
    projects.push({
      headingRaw: first.value,
      name: latexToPlain(namePart ?? ""),
      technologies: latexToPlain(techPart ?? ""),
    });
    cursor = first.end;
  }
  return projects;
}

/** Locates the Projects block: `{before, body, after}` around it. */
function projectsRegion(
  content: string,
): { start: number; end: number; body: string } | null {
  const startMatch = content.match(PROJECTS_START_REGEX);
  const endMatch = content.match(PROJECTS_END_REGEX);
  if (
    !startMatch ||
    !endMatch ||
    startMatch.index === undefined ||
    endMatch.index === undefined
  ) {
    return null;
  }
  const start = startMatch.index + startMatch[0].length;
  const end = endMatch.index;
  if (end < start) return null;
  return { start, end, body: content.slice(start, end) };
}

/**
 * The base's own closing line ("10+ additional projects…"), if it has one.
 * Reused verbatim so the author's wording and `\vspace` survive.
 */
function extractProjectsNote(body: string): string | null {
  const match = body.match(/(\\vspace\{[^}]*\}\s*)?\\small\{\\item\{\\textit\{[\s\S]*?\}\}\}/);
  return match ? match[0].trim() : null;
}

/**
 * Writes a new Projects block, v1's `replaceProjectsSection`.
 *
 * Splits on the same two regexes v1 used and rebuilds
 * `before + projects + after`, so — exactly as in v1 — the `\section{Projects}`
 * line, the `\resumeSubHeadingListStart`, the closing
 * `\resumeSubHeadingListEnd` and `\end{document}` are all untouched original
 * bytes. Returns `content` unchanged when either marker is missing, which is
 * v1's behaviour (it logged and skipped).
 */
export function replaceProjectsSection(
  content: string,
  projects: readonly ResolvedProject[],
): string {
  const region = projectsRegion(content);
  if (!region || projects.length === 0) return content;

  let block = "";
  for (const project of projects) {
    const items = project.bullets
      .slice(0, MAX_BULLETS_PER_PROJECT)
      .map((bullet) => `      \\resumeItem{${escapeLatex(bullet)}}`)
      .join("\n");
    block += `
  \\item \\resumeProjectHeading
    {${project.headingRaw}}{}
    \\resumeItemListStart
${items}
    \\resumeItemListEnd
`;
  }

  const note = extractProjectsNote(region.body) ?? `\\vspace{4pt}\n  ${DEFAULT_PROJECTS_NOTE}`;
  block += `\n  ${note}\n`;

  return content.slice(0, region.start) + block + "\n" + content.slice(region.end);
}

/** Words too generic to identify a project. */
const NAME_STOPWORDS = new Set([
  "live",
  "http",
  "https",
  "www",
  "com",
  "full",
  "stack",
  "fullstack",
  "app",
  "apps",
  "application",
  "project",
  "platform",
  "system",
  "with",
  "using",
  "the",
  "and",
  "for",
]);

/** Distinctive lowercase tokens from a project name, for fuzzy matching. */
function nameTokens(name: string): string[] {
  return [
    ...new Set(
      name
        .toLowerCase()
        .split(/[^a-z0-9+#.]+/)
        .flatMap((token) => (token.includes(".") ? [token, ...token.split(".")] : [token]))
        .map((token) => token.replace(/^[.]+|[.]+$/g, ""))
        .filter((token) => token.length >= 4 && !NAME_STOPWORDS.has(token)),
    ),
  ];
}

function scoreBulletAgainstProject(bullet: string, project: BaseProject): number {
  const haystack = bullet.toLowerCase();
  return nameTokens(project.name).filter((token) => haystack.includes(token)).length;
}

/**
 * Maps a legacy tailor output — one with a loose "Projects" section and no
 * `projects` field — back onto the base resume's real projects.
 *
 * The rule, deterministic and no-LLM:
 *   1. score every (bullet, base project) pair by how many distinctive words
 *      of the project's name appear in the bullet ("Kanban" → *KanDoIt –
 *      Full-Stack KanBan App"), and assign highest-scoring pairs first, up to
 *      {@link MAX_BULLETS_PER_PROJECT} bullets per project;
 *   2. bullets that named nothing recognisable are dealt out, in the tailor's
 *      own order, to the base projects that are still empty, in the base's
 *      order — the tailor's bullets *are* about the user's real projects, it
 *      just was not asked to say which;
 *   3. base projects that ended up with no bullet are dropped, exactly as v1
 *      dropped projects the model did not select.
 *
 * Output order is the tailor's bullet order, so "most relevant first" is
 * preserved. Returns `[]` when there is nothing to work with, and the caller
 * then leaves the base's Projects block alone rather than emptying it.
 */
export function deriveProjectsFromSections(
  tailor: TailorOutput,
  baseProjects: readonly BaseProject[],
): ResolvedProject[] {
  const section = tailor.sections.find((s) => /project/i.test(s.heading));
  const bullets = section?.bullets.map((b) => b.text) ?? [];
  if (bullets.length === 0 || baseProjects.length === 0) return [];

  const assigned = baseProjects.map(() => [] as { index: number; text: string }[]);
  const claimedBy = new Map<number, number>(); // bullet index -> project index

  const pairs: { bullet: number; project: number; score: number }[] = [];
  bullets.forEach((text, bulletIndex) => {
    baseProjects.forEach((project, projectIndex) => {
      const score = scoreBulletAgainstProject(text, project);
      if (score > 0) pairs.push({ bullet: bulletIndex, project: projectIndex, score });
    });
  });
  pairs.sort((a, b) => b.score - a.score || a.bullet - b.bullet || a.project - b.project);

  for (const pair of pairs) {
    if (claimedBy.has(pair.bullet)) continue;
    if (assigned[pair.project].length >= MAX_BULLETS_PER_PROJECT) continue;
    assigned[pair.project].push({ index: pair.bullet, text: bullets[pair.bullet] });
    claimedBy.set(pair.bullet, pair.project);
  }

  // Step 2: deal the leftovers out to still-empty base projects, in order.
  let nextEmpty = 0;
  bullets.forEach((text, bulletIndex) => {
    if (claimedBy.has(bulletIndex)) return;
    while (nextEmpty < assigned.length && assigned[nextEmpty].length > 0) nextEmpty++;
    if (nextEmpty >= assigned.length) return;
    assigned[nextEmpty].push({ index: bulletIndex, text });
    claimedBy.set(bulletIndex, nextEmpty);
  });

  return assigned
    .map((items, projectIndex) => ({ projectIndex, items }))
    .filter((entry) => entry.items.length > 0)
    .sort((a, b) => Math.min(...a.items.map((i) => i.index)) - Math.min(...b.items.map((i) => i.index)))
    .map((entry) => ({
      headingRaw: baseProjects[entry.projectIndex].headingRaw,
      bullets: entry.items.sort((a, b) => a.index - b.index).map((i) => i.text),
    }));
}

/** Where a rendered Projects block came from — reported back to the caller. */
export type ProjectsSource =
  /** `TailorOutput.projects` — the model named the projects itself. */
  | "tailor"
  /** Legacy output, mapped by {@link deriveProjectsFromSections}. */
  | "derived"
  /** Nothing usable; the base's own Projects block was left in place. */
  | "base";

/**
 * Picks the base heading for a named project, so `\href` links and colours in
 * the user's own document survive tailoring. Falls back to v1's synthesised
 * `\textbf{name} $|$ \emph{technologies}` when the name is not in the base.
 */
function headingFor(
  name: string,
  technologies: string | undefined,
  baseProjects: readonly BaseProject[],
): string {
  const wanted = name.trim().toLowerCase();
  const exact = baseProjects.find((p) => p.name.toLowerCase() === wanted);
  const partial =
    exact ??
    baseProjects.find(
      (p) => p.name.toLowerCase().includes(wanted) || wanted.includes(p.name.toLowerCase()),
    );
  const token =
    partial ??
    baseProjects.find((p) => nameTokens(p.name).some((t) => wanted.includes(t)));
  if (token) return token.headingRaw;
  return `\\textbf{${escapeLatex(name)}} $|$ \\emph{${escapeLatex(technologies ?? "")}}`;
}

/**
 * Turns a tailored output into the Projects block's contents, preferring the
 * model's own `projects` and falling back to the legacy derivation.
 */
export function resolveProjects(
  tailor: TailorOutput,
  baseProjects: readonly BaseProject[],
): { projects: ResolvedProject[]; source: ProjectsSource } {
  if (tailor.projects && tailor.projects.length > 0) {
    return {
      source: "tailor",
      projects: tailor.projects.map((project) => ({
        headingRaw: headingFor(project.name, project.technologies, baseProjects),
        bullets: project.bullets.map((b) => b.text).slice(0, MAX_BULLETS_PER_PROJECT),
      })),
    };
  }
  const derived = deriveProjectsFromSections(tailor, baseProjects);
  return derived.length > 0
    ? { projects: derived, source: "derived" }
    : { projects: [], source: "base" };
}

// ---------------------------------------------------------------------------
// Contact placeholders
// ---------------------------------------------------------------------------

export interface LatexContact {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  links?: string[] | null;
}

/**
 * Fills `{{NAME}}` / `{{EMAIL}}` / `{{PHONE}}` / `{{LINKS}}` placeholders.
 *
 * v1's `resume.tex` has the candidate's heading written directly into the
 * document and its splice never touched it — that is the point of a base
 * resume, and `tests/pdf/latex.test.ts` asserts the heading comes out
 * byte-identical. So this is a no-op for a document like the owner's, and
 * exists only for a *template* base (one a future onboarding flow generates
 * with placeholders rather than a real heading). Contact details are never
 * injected over a heading the user actually wrote.
 */
export function fillContactPlaceholders(content: string, contact?: LatexContact): string {
  if (!contact) return content;
  const links = (contact.links ?? []).filter(Boolean);
  return content
    .replace(/\{\{NAME\}\}/g, escapeLatex(contact.name ?? ""))
    .replace(/\{\{EMAIL\}\}/g, escapeLatex(contact.email ?? ""))
    .replace(/\{\{PHONE\}\}/g, escapeLatex(contact.phone ?? ""))
    .replace(/\{\{LINKS\}\}/g, links.map((l) => escapeLatex(l)).join(" $|$ "));
}

// ---------------------------------------------------------------------------
// The splice
// ---------------------------------------------------------------------------

/**
 * v1's `createTailoredResume`: skills block, then projects block, nothing
 * else. Pure string work — no subprocess, no filesystem — so a test can assert
 * byte-identity of every other section cheaply.
 */
export function spliceTailoredResume(
  baseLatex: string,
  tailor: TailorOutput,
  contact?: LatexContact,
): { tex: string; projectsSource: ProjectsSource } {
  const baseProjects = extractBaseProjects(baseLatex);
  const { projects, source } = resolveProjects(tailor, baseProjects);

  let tex = fillContactPlaceholders(baseLatex, contact);
  tex = replaceSkillsSection(tex, tailor.skills);
  if (projects.length > 0) tex = replaceProjectsSection(tex, projects);

  return { tex, projectsSource: source };
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

/**
 * Compiles a `.tex` string to PDF bytes with `pdflatex`, run twice.
 *
 * v1 compiled in `public/resumes/` and deleted the aux files afterwards; this
 * uses a fresh `mkdtemp` directory per call instead, which is what makes the
 * pipeline safe to run concurrently (two downloads at once in v1 would have
 * fought over `resume.aux`) and leaves nothing behind on a crash path other
 * than a temp dir.
 *
 * Non-zero exit is not automatically failure: LaTeX exits non-zero for
 * warnings it recovered from, and v1 explicitly accepted a PDF that exists
 * anyway. Only "ran, and there is no PDF" is an error — and then the `.log`
 * tail travels with the exception, since that is the only thing that ever
 * explains a LaTeX failure.
 */
export async function compileLatexToPdf(
  tex: string,
  options: { timeoutMs?: number } = {},
): Promise<Buffer> {
  if (!(await isLatexAvailable())) throw new LatexUnavailableError();

  const dir = await mkdtemp(path.join(os.tmpdir(), "applyops-latex-"));
  const base = "resume";
  const texPath = path.join(dir, `${base}.tex`);
  const pdfPath = path.join(dir, `${base}.pdf`);
  const logPath = path.join(dir, `${base}.log`);

  try {
    await writeFile(texPath, tex, "utf-8");

    // Twice, for the cross-references LaTeX resolves on a second pass — v1
    // did the same. Both passes are allowed to "fail"; the PDF is the verdict.
    for (let pass = 0; pass < 2; pass++) {
      try {
        await execFileAsync(pdflatexBin(), ["-interaction=nonstopmode", `${base}.tex`], {
          cwd: dir,
          env: latexEnv(),
          timeout: options.timeoutMs ?? PDFLATEX_TIMEOUT_MS,
        });
      } catch {
        // Swallowed on purpose — checked below by looking for the PDF.
      }
    }

    let pdf: Buffer;
    try {
      pdf = await readFile(pdfPath);
    } catch {
      const log = await readFile(logPath, "utf-8").catch(() => "(no pdflatex log was written)");
      throw new LatexCompileError(
        "pdflatex produced no PDF. The tail of its log follows.",
        log.split("\n").slice(-40).join("\n"),
      );
    }
    return pdf;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * v1's `mergePDFWithTranscript`: append the candidate's transcript to the
 * resume with Ghostscript.
 *
 * Ghostscript rather than a JS PDF library because that is what v1 used and
 * why — university transcripts are routinely owner-password-encrypted, and
 * `gs` re-renders rather than re-packages, so it merges them where
 * pdf-lib-style tools refuse.
 *
 * Returns the un-merged resume (rather than throwing) if `gs` is missing or
 * fails: a transcript is an extra, and losing it must never cost the user
 * their resume. v1 made the same call.
 */
export async function mergeWithTranscript(
  resumePdf: Buffer,
  transcriptPdf: Buffer,
): Promise<{ pdf: Buffer; merged: boolean }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "applyops-gs-"));
  const resumePath = path.join(dir, "resume.pdf");
  const transcriptPath = path.join(dir, "transcript.pdf");
  const outPath = path.join(dir, "merged.pdf");
  try {
    await writeFile(resumePath, resumePdf);
    await writeFile(transcriptPath, transcriptPdf);
    await execFileAsync(
      ghostscriptBin(),
      [
        "-dBATCH",
        "-dNOPAUSE",
        "-q",
        "-sDEVICE=pdfwrite",
        `-sOutputFile=${outPath}`,
        resumePath,
        transcriptPath,
      ],
      { env: latexEnv(), timeout: GHOSTSCRIPT_TIMEOUT_MS },
    );
    const merged = await readFile(outPath);
    return { pdf: merged, merged: true };
  } catch {
    return { pdf: resumePdf, merged: false };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

export interface LatexResumeBase {
  /** The full `.tex` source — `resume_bases.latex`. */
  latex: string;
  /** The transcript to append, already fetched from Storage. */
  transcriptPdf?: Buffer | null;
}

export interface RenderLatexResumeInput {
  base: LatexResumeBase;
  tailor: TailorOutput;
  contact?: LatexContact;
  /**
   * Append `base.transcriptPdf` when there is one. Defaults to `false`: an
   * ATS "resume" field wants a resume, and v1 produced the merged file as a
   * *separate* artifact for the postings that ask for a transcript.
   */
  includeTranscript?: boolean;
  timeoutMs?: number;
}

export interface LatexResumeResult {
  pdf: Buffer;
  /** The spliced `.tex` that produced it — written next to the PDF by the CLI. */
  tex: string;
  projectsSource: ProjectsSource;
  transcriptMerged: boolean;
}

/**
 * Splice, compile, optionally merge — the whole v1 pipeline behind one call.
 *
 * Throws {@link LatexUnavailableError} when the host has no `pdflatex`; the
 * PDF route checks {@link isLatexAvailable} first and falls back to react-pdf
 * rather than letting a download fail because of the host's TeX install.
 */
export async function renderLatexResume(
  input: RenderLatexResumeInput,
): Promise<LatexResumeResult> {
  const { tex, projectsSource } = spliceTailoredResume(
    input.base.latex,
    input.tailor,
    input.contact,
  );

  const compiled = await compileLatexToPdf(tex, { timeoutMs: input.timeoutMs });

  if (input.includeTranscript && input.base.transcriptPdf?.length) {
    const { pdf, merged } = await mergeWithTranscript(compiled, input.base.transcriptPdf);
    return { pdf, tex, projectsSource, transcriptMerged: merged };
  }

  return { pdf: compiled, tex, projectsSource, transcriptMerged: false };
}
