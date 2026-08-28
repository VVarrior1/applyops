/**
 * The base resume's **Technical Skills categories**, read out of the user's
 * own `.tex` and written back into it.
 *
 * ## Why this module exists
 *
 * v1 had exactly one skills shape, hardcoded:
 *
 * ```tex
 * \textbf{Proficient}{: …} \\
 * \textbf{Familiar}{: …}
 * ```
 *
 * and `replaceSkillsSection()` in `src/pdf/latex.ts` flattened the tailor
 * step's `skills: string[]` into it. That was fine while the owner's resume
 * looked like that. It does not any more — the current base resume groups
 * skills the way a reader of *this* candidate's resume should see them:
 *
 * ```tex
 * \textbf{Languages}{: Python, TypeScript/JavaScript, SQL, Java} \\
 * \textbf{Frameworks \& Data}{: Next.js, React, …} \\
 * \textbf{Cloud \& Infrastructure}{: GCP (Vertex AI, BigQuery), Azure, …} \\
 * \textbf{AI/ML}{: LLM \& RAG application design, …; Claude Code, Cursor, MCP}
 * ```
 *
 * Splicing v1's two-line shape over that threw away four hand-chosen
 * categories and replaced them with "Proficient/Familiar" — the exact class of
 * regression the owner reported when v2 first shipped (see the v1-parity note
 * in `src/pdf/latex.ts`). This module makes the categories *data*: the tailor
 * step is told what they are and may only reorder, trim, or add inside them.
 *
 * ## Design notes that are load-bearing
 *
 * - **Labels are unescaped, items are not.** A label is a short human word
 *   that the prompt shows the model and the model must echo back verbatim, so
 *   `Frameworks \& Data` is handed over as `Frameworks & Data` and re-escaped
 *   on the way out. Items are left as the raw LaTeX the author wrote, because
 *   an item may legitimately *be* LaTeX (`C\#`, `\textbf{AWS}`, `\href{…}{…}`)
 *   and a naive unescape/re-escape round trip would mangle it into
 *   `\textbackslash{}textbf\{AWS\}`. {@link renderSkillItem} escapes only the
 *   items that contain no backslash at all — i.e. the plain-text ones a model
 *   returns — which is the same "already-LaTeX when it came from the base
 *   document" rule the old Familiar-line code used.
 * - **A top-level `;` is kept on the item before it.** The owner's AI/ML line
 *   ends `…computer vision (YOLOv8/v11, OpenCV, PyTorch); Claude Code, Cursor,
 *   MCP` — a deliberate "concepts; tools" split. Splitting on `,` and `;`
 *   alike and joining back with `", "` would silently rewrite that punctuation
 *   in the owner's resume. So the tail items become items of their own *and*
 *   the separator survives, by living as a trailing `;` on the item it follows
 *   ({@link splitSkillItems} / {@link renderSkillGroups}). That is what makes
 *   `render(parse(base))` reproduce the block character for character.
 * - **This module imports nothing.** `src/pdf/latex.ts` imports it, so it must
 *   stay a leaf; {@link SKILLS_REGEX} and {@link readBalancedGroup} live here
 *   and are re-exported from `latex.ts` for its existing callers.
 */

/**
 * One `\textbf{Label}{: items}` line of the Technical Skills block.
 *
 * `label` is plain text (LaTeX escapes resolved). `items` are raw LaTeX
 * fragments as the base document wrote them — see the module note above.
 */
export interface SkillGroup {
  label: string;
  items: string[];
}

/**
 * v1's `skillsRegex`, character for character.
 *
 * Three capture groups: everything up to and including the opening
 * `\small{\item{`, the block's current contents, and the closing
 * `}}\end{itemize}`. Only group 2 is ever replaced, so the
 * `%-----------…-----------` banner comment and the `\begin{itemize}` options
 * stay exactly as the author wrote them.
 *
 * Note that group 1 swallows the whitespace after `\small{\item{`, which is
 * why {@link renderSkillGroups} does *not* indent its first line.
 */
export const SKILLS_REGEX =
  /(%-----------TECHNICAL SKILLS-----------[\s\S]*?\\section{Technical Skills}[\s\S]*?\\begin{itemize}\[leftmargin=0.15in, label={}\]\s*\\small{\\item{\s*)([\s\S]*?)(}\s*}\s*\\end{itemize})/;

/**
 * Reads the balanced `{...}` group starting at `src[start]` (which must be
 * `{`). Returns the contents and the index just past the closing brace.
 * Backslash-escaped braces (`\{`, `\}`) do not count toward the balance —
 * `\{` is a literal brace in LaTeX, not a group delimiter.
 */
export function readBalancedGroup(
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

/** The escapes a *label* may plausibly carry, and their plain-text reading. */
const LABEL_UNESCAPES: [RegExp, string][] = [
  [/\\&/g, "&"],
  [/\\%/g, "%"],
  [/\\#/g, "#"],
  [/\\_/g, "_"],
  [/\\\$/g, "$"],
];

/**
 * `Frameworks \& Data` → `Frameworks & Data`.
 *
 * Only the escapes, deliberately: unlike `latexToPlain()` this leaves macros
 * and braces alone, because it runs on labels (which have neither) and, in the
 * react-pdf renderer, on item text that `latexToPlain()` has already stripped.
 */
export function unescapeLatexSpecials(text: string): string {
  let out = text;
  for (const [pattern, replacement] of LABEL_UNESCAPES) {
    out = out.replace(pattern, replacement);
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Escapes the LaTeX specials in text that is known to be plain.
 *
 * Deliberately *not* `escapeLatex()` from `src/pdf/latex.ts`: that one starts
 * by turning every `\` into `\textbackslash{}`, which is right for a bullet
 * the model wrote and catastrophic for a fragment copied out of the user's own
 * `.tex`. Callers here only reach this for strings with no backslash in them.
 */
function escapePlain(text: string): string {
  return text
    .replace(/([&%#_$])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
}

/** `Frameworks & Data` → `Frameworks \& Data` (a no-op if already LaTeX). */
export function renderLabel(label: string): string {
  const trimmed = label.trim();
  return trimmed.includes("\\") ? trimmed : escapePlain(trimmed);
}

/**
 * One skill item, ready for the document.
 *
 * Passed through untouched when it contains a backslash — then it came out of
 * the base `.tex` and is already valid LaTeX. Escaped otherwise, because then
 * it is plain text a model returned and an unescaped `&` or `#` in it would
 * fail the compile (and take the download down to the react-pdf fallback).
 */
export function renderSkillItem(item: string): string {
  const trimmed = item.trim();
  return trimmed.includes("\\") ? trimmed : escapePlain(trimmed);
}

/**
 * Splits one `\textbf{…}{: HERE}` payload into individual skills.
 *
 * Splits on top-level `,` and `;` only: depth is tracked through `(…)`, `{…}`
 * and `[…]`, so `GCP (Vertex AI, BigQuery)` stays one item and a macro
 * argument never splits. A `;` boundary is preserved as a trailing `;` on the
 * item before it — see the module note.
 */
export function splitSkillItems(payload: string): string[] {
  const items: string[] = [];
  let current = "";
  let depth = 0;

  const push = (suffix = "") => {
    const trimmed = current.trim();
    if (trimmed) items.push(trimmed + suffix);
    current = "";
  };

  for (let i = 0; i < payload.length; i++) {
    const ch = payload[i];
    if (ch === "\\") {
      // An escaped character is literal — `\{` is not a group, `\&` is an
      // ampersand — so copy the pair over without touching the depth.
      current += ch + (payload[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth = Math.max(0, depth - 1);

    if (depth === 0 && ch === ",") {
      push();
      continue;
    }
    if (depth === 0 && ch === ";") {
      push(";");
      continue;
    }
    current += ch;
  }
  push();
  return items;
}

/**
 * Every `\textbf{Label}{: …}` line inside the Technical Skills block.
 *
 * Scans the block sequentially rather than with a global regex: a value may
 * itself contain `\textbf{…}`, and only a sequential scan that jumps the
 * cursor past each consumed value can tell a *line label* from a macro inside
 * a line.
 *
 * Returns `[]` — never throws — when the document has no Technical Skills
 * block, or has one written in some other shape (a bare comma list, a
 * `tabular`). Every caller's answer to that is "leave the base alone and use
 * the old flat path".
 */
export function parseSkillGroups(latexBase: string): SkillGroup[] {
  const match = latexBase.match(SKILLS_REGEX);
  if (!match) return [];
  return parseSkillGroupsFromBlock(match[2]);
}

/** {@link parseSkillGroups} for a block body already carved out of a `.tex`. */
export function parseSkillGroupsFromBlock(block: string): SkillGroup[] {
  const groups: SkillGroup[] = [];
  const marker = "\\textbf";
  let cursor = 0;

  for (;;) {
    const at = block.indexOf(marker, cursor);
    if (at === -1) break;

    let i = at + marker.length;
    while (i < block.length && /\s/.test(block[i])) i++;
    const labelGroup = readBalancedGroup(block, i);
    if (!labelGroup) {
      cursor = at + marker.length;
      continue;
    }

    let j = labelGroup.end;
    while (j < block.length && /\s/.test(block[j])) j++;
    const valueGroup = readBalancedGroup(block, j);
    if (!valueGroup) {
      // `\textbf{X}` with no `{: …}` after it — a bold word in prose, not a
      // category line. Skip the label and keep scanning from just past it.
      cursor = labelGroup.end;
      continue;
    }

    const value = valueGroup.value.trimStart();
    if (!value.startsWith(":")) {
      cursor = labelGroup.end;
      continue;
    }

    const label = unescapeLatexSpecials(labelGroup.value);
    if (label) {
      groups.push({ label, items: splitSkillItems(value.slice(1)) });
    }
    cursor = valueGroup.end;
  }

  return groups;
}

export interface RenderSkillGroupsOptions {
  /**
   * Indent for every line *after* the first. The first line is not indented
   * because {@link SKILLS_REGEX}'s first capture group already ends with the
   * whitespace that follows `\small{\item{`.
   */
  indent?: string;
}

/**
 * Renders groups back into the body of the Technical Skills itemize.
 *
 * Lines are joined with ` \\` + newline + indent, the last line carrying no
 * separator — the shape the owner's resume is written in, and the shape
 * `\small{\item{ … }}` needs for the line breaks to appear at all.
 *
 * Groups with no items are dropped: `\textbf{Languages}{: }` compiles to a
 * bold word and a stray colon.
 */
export function renderSkillGroups(
  groups: readonly SkillGroup[],
  options: RenderSkillGroupsOptions = {},
): string {
  const indent = options.indent ?? "    ";
  const lines = groups
    .map((group) => ({
      label: renderLabel(group.label),
      items: group.items.map(renderSkillItem).filter(Boolean),
    }))
    .filter((group) => group.label && group.items.length > 0)
    .map((group) => `\\textbf{${group.label}}{: ${joinSkillItems(group.items)}}`);

  return lines
    .map((line, i) => (i === 0 ? line : indent + line))
    .join(" \\\\\n");
}

/**
 * `", "` between items, but a single space after an item that already ends in
 * `;` — that is how the semicolon the author wrote survives the round trip
 * without a `;,` ever appearing.
 */
function joinSkillItems(items: readonly string[]): string {
  return items.reduce(
    (acc, item, i) =>
      i === 0 ? item : acc + (acc.endsWith(";") ? " " : ", ") + item,
    "",
  );
}

/** Normalized form used to match a model's label against the base's. */
export function labelKey(label: string): string {
  return unescapeLatexSpecials(label).toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * `skill_groups` flattened into the flat `skills: string[]` every pre-existing
 * consumer (the react-pdf fallback's one-line Skills row, the Tailor tab's
 * chips, `eval`/`bench` reporting) still reads. Order is preserved and
 * duplicates are dropped; a trailing `;` — punctuation that only means
 * anything inside a rendered line — is stripped.
 */
export function flattenSkillGroups(groups: readonly SkillGroup[]): string[] {
  const seen = new Set<string>();
  const flat: string[] = [];
  for (const group of groups) {
    for (const item of group.items) {
      const skill = item.trim().replace(/;$/, "").trim();
      if (!skill) continue;
      const key = skill.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      flat.push(skill);
    }
  }
  return flat;
}

/**
 * Merges a tailored set of groups onto the base's.
 *
 * The base decides which groups exist, their order, and how each label is
 * spelled — the model only gets to say what is *in* a group it was shown. A
 * label the base does not have is dropped (and named in `ignored`, which the
 * splice logs): the alternative, trusting it, is a model inventing a
 * "Leadership" skills category on the owner's resume.
 *
 * A group the model said nothing about keeps the base's items untouched, so a
 * partial answer degrades to "less tailoring", never to "a missing category".
 */
export function mergeSkillGroups(
  baseGroups: readonly SkillGroup[],
  tailored: readonly SkillGroup[],
): { groups: SkillGroup[]; ignored: string[] } {
  const byKey = new Map<string, SkillGroup>();
  const ignored: string[] = [];

  for (const group of tailored) {
    const key = labelKey(group.label);
    if (!key) continue;
    if (!baseGroups.some((base) => labelKey(base.label) === key)) {
      ignored.push(group.label);
      continue;
    }
    if (!byKey.has(key)) byKey.set(key, group);
  }

  const groups = baseGroups.map((base) => {
    const replacement = byKey.get(labelKey(base.label));
    const items = (replacement?.items ?? [])
      .map((item) => item.trim())
      .filter(Boolean);
    // An empty group from the model means "I dropped everything here", which
    // for a category the author put on their own resume is far more likely to
    // be a lapse than a judgement. Keep the base's list.
    return items.length > 0 ? { label: base.label, items } : base;
  });

  return { groups, ignored };
}

/**
 * True when a base's skills block is v1's `Proficient` / `Familiar` pair —
 * the shape `replaceSkillsSection()` was written for, and the only one whose
 * contents were never the author's own categorisation.
 *
 * The distinction matters because "the base has `\textbf{…}{: …}` lines" is
 * true of both shapes. A v1-shaped base keeps v1's behaviour (the flat
 * tailored list is written straight into `Proficient`); anything else is a
 * categorisation its author chose, which a flat list must never overwrite.
 */
export function isLegacySkillsShape(groups: readonly SkillGroup[]): boolean {
  if (groups.length === 0) return false;
  return groups.every((group) => {
    const key = labelKey(group.label);
    return key === "proficient" || key === "familiar";
  });
}
