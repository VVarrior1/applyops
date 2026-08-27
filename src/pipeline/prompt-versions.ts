/**
 * Prompt loading + prompt-version registration.
 *
 * Spec §5: "Prompt content is hashed; a `prompt_versions` row is upserted on
 * first use." Every `generations` row points at a `prompt_versions` row, so
 * months later an eval regression can be traced to the exact prompt text that
 * produced it — which only works if the text on disk and the text in the
 * database can never silently disagree.
 *
 * Two functions:
 *   - {@link loadPrompt} reads `src/pipeline/prompts/<step>.v<N>.md`, splits
 *     off the YAML front matter (`step`, `version`) and hashes the body;
 *   - {@link ensurePromptVersion} makes sure a row exists for that exact body
 *     and returns its id, ready to pass to `callStructured()`.
 *
 * Both are cached: the file is read and hashed once per process, and the row
 * id is remembered per database handle, so a batch ranking 200 jobs does one
 * `SELECT` rather than 200.
 *
 * ### Editing a prompt
 *
 * Bump `version` in the front matter. If the body changes while the version
 * does not (a typo fix, or a stale checkout), `ensurePromptVersion` does *not*
 * overwrite the stored row — rewriting it would silently relabel every
 * historical generation. It registers the new body under
 * `<version>+<sha8>` instead, so old generations keep pointing at the text
 * that actually produced them and the drift is visible in the table.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { promptVersions, stepEnum, type Step } from "../db/schema";

/** Every step that has a prompt file — i.e. all of them (spec §5). */
export const PROMPT_STEPS: readonly Step[] = stepEnum.enumValues;

export interface LoadedPrompt {
  step: Step;
  /** The prompt body with the front matter removed. This is the system text. */
  content: string;
  /** Semver from the front matter, e.g. `1.0.0`. */
  version: string;
  /** `sha256(content)` — hashes exactly the bytes sent to the model. */
  sha256: string;
  /** Absolute path of the file it came from (for error messages/debugging). */
  filePath: string;
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

const promptCache = new Map<Step, LoadedPrompt>();

/**
 * Where the `.md` files live at runtime.
 *
 * Under `tsx`/`vitest` the module's own directory is right. Inside a Next.js
 * server bundle `import.meta.url` points at a chunk in `.next/`, so the repo
 * root (`process.cwd()`) is the fallback — and `next.config.ts` traces
 * `src/pipeline/prompts/**` into the deployed function so the files are
 * actually there.
 */
function promptsDir(): string {
  let here: string | null = null;
  try {
    here = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    // A bundler rewrote `import.meta.url` into something that is not a file:
    // URL. Fall through to the cwd-relative candidate.
  }
  const candidates = [
    here ? path.join(here, "prompts") : null,
    path.resolve(process.cwd(), "src/pipeline/prompts"),
  ].filter((dir): dir is string => dir !== null);
  const found = candidates.find((dir) => existsSync(dir));
  if (!found) {
    throw new Error(
      `Prompt directory not found. Looked in: ${candidates.join(", ")}`,
    );
  }
  return found;
}

/**
 * Newest prompt file for a step: `tailor.v2.md` wins over `tailor.v1.md`, so
 * adding a major version is a new file plus a front-matter bump, no code edit.
 */
function newestPromptFile(dir: string, step: Step): { file: string; major: number } {
  const pattern = new RegExp(`^${step}\\.v(\\d+)\\.md$`);
  const matches = readdirSync(dir)
    .map((file) => {
      const m = pattern.exec(file);
      return m ? { file, major: Number(m[1]) } : null;
    })
    .filter((m): m is { file: string; major: number } => m !== null)
    .sort((a, b) => b.major - a.major);

  if (matches.length === 0) {
    throw new Error(
      `No prompt file for step "${step}": expected ${dir}/${step}.v1.md`,
    );
  }
  return matches[0];
}

function parseFrontMatter(raw: string, filePath: string) {
  const match = FRONT_MATTER.exec(raw);
  if (!match) {
    throw new Error(
      `Prompt file ${filePath} is missing its --- front matter block (step, version).`,
    );
  }

  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    if (key) fields[key] = value;
  }

  return { fields, body: raw.slice(match[0].length) };
}

/**
 * Read, validate and hash a step's prompt. Cached per process — the files are
 * immutable at runtime, and a stable hash is what makes a `prompt_versions`
 * row reusable across a whole batch.
 */
export function loadPrompt(step: Step): LoadedPrompt {
  const cached = promptCache.get(step);
  if (cached) return cached;

  const dir = promptsDir();
  const { file, major } = newestPromptFile(dir, step);
  const filePath = path.join(dir, file);
  const raw = readFileSync(filePath, "utf8");
  const { fields, body } = parseFrontMatter(raw, filePath);

  const version = fields.version;
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(
      `Prompt file ${filePath} needs a semver \`version:\` in its front matter (got ${JSON.stringify(version)}).`,
    );
  }
  if (fields.step !== step) {
    throw new Error(
      `Prompt file ${filePath} declares step ${JSON.stringify(fields.step)} but is named for ${step}.`,
    );
  }
  if (Number(version.split(".")[0]) !== major) {
    throw new Error(
      `Prompt file ${filePath} declares version ${version}, which does not match its .v${major}. filename.`,
    );
  }

  const content = body.trim();
  if (!content) {
    throw new Error(`Prompt file ${filePath} has no body below the front matter.`);
  }

  const loaded: LoadedPrompt = {
    step,
    content,
    version,
    sha256: createHash("sha256").update(content, "utf8").digest("hex"),
    filePath,
  };
  promptCache.set(step, loaded);
  return loaded;
}

// ---------------------------------------------------------------------------
// prompt_versions registration
// ---------------------------------------------------------------------------

/**
 * `db → "<step>:<sha256>" → prompt_versions.id`. Keyed on the handle (not a
 * module-level singleton) so a test's fake db, the pooled app connection and a
 * direct CLI connection never share cached ids.
 */
const idCache = new WeakMap<object, Map<string, string>>();

function cacheFor(db: Db): Map<string, string> {
  let map = idCache.get(db as unknown as object);
  if (!map) {
    map = new Map();
    idCache.set(db as unknown as object, map);
  }
  return map;
}

async function findRow(db: Db, step: Step, version: string) {
  const [row] = await db
    .select({ id: promptVersions.id, sha256: promptVersions.sha256 })
    .from(promptVersions)
    .where(and(eq(promptVersions.step, step), eq(promptVersions.version, version)))
    .limit(1);
  return row ?? null;
}

/**
 * Insert-if-absent on the `(step, version)` unique index. `onConflictDoNothing`
 * returns no row when a concurrent writer won the race, so fall back to a
 * re-select rather than failing a whole ranking batch on a lost race.
 */
async function insertRow(
  db: Db,
  values: { step: Step; version: string; sha256: string; content: string },
): Promise<string> {
  const [inserted] = await db
    .insert(promptVersions)
    .values(values)
    .onConflictDoNothing({
      target: [promptVersions.step, promptVersions.version],
    })
    .returning({ id: promptVersions.id });

  if (inserted?.id) return inserted.id;

  const existing = await findRow(db, values.step, values.version);
  if (existing?.id) return existing.id;

  throw new Error(
    `Could not resolve a prompt_versions row for ${values.step} ${values.version}.`,
  );
}

/**
 * Ensure the current prompt for `step` is registered and return its
 * `prompt_versions.id`.
 *
 * Must run **before** the first `callStructured()` for that step:
 * `generations.prompt_version_id` is a real foreign key, so an unregistered
 * prompt fails the insert, not the generation.
 */
export async function ensurePromptVersion(db: Db, step: Step): Promise<string> {
  const prompt = loadPrompt(step);
  const cache = cacheFor(db);
  const key = `${step}:${prompt.sha256}`;
  const cached = cache.get(key);
  if (cached) return cached;

  let version = prompt.version;
  const existing = await findRow(db, step, version);

  if (existing?.sha256 === prompt.sha256) {
    cache.set(key, existing.id);
    return existing.id;
  }

  if (existing) {
    // The file changed without a version bump. Register the new body under a
    // content-addressed version instead of overwriting the row that older
    // generations point at.
    version = `${prompt.version}+${prompt.sha256.slice(0, 8)}`;
    const drifted = await findRow(db, step, version);
    if (drifted?.id) {
      cache.set(key, drifted.id);
      return drifted.id;
    }
  }

  const id = await insertRow(db, {
    step,
    version,
    sha256: prompt.sha256,
    content: prompt.content,
  });
  cache.set(key, id);
  return id;
}

/** Test/CLI helper: forget the on-disk prompt cache (e.g. after editing a file). */
export function clearPromptCache(): void {
  promptCache.clear();
}
