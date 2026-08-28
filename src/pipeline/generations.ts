/**
 * Reducing a job's generation history down to "the current result" — spec:
 * `/jobs/[id]` loads, server-side, "the LATEST persisted results for this
 * user+job ... tailor and suggest from the generations table (step + jobId
 * + userId, newest)".
 *
 * `generations` keeps every run (spec: it is the audit trail, not a
 * one-row-per-job cache the way `job_scores` is), so picking "the current
 * one" per step is application logic, not a schema constraint. This module
 * is that logic: a single query pulls every `tailor`/`suggest` generation
 * for a job+user in one round trip, and {@link latestGenerationByStep}
 * reduces it in memory rather than issuing one `ORDER BY ... LIMIT 1`
 * per step. Pure and DB-free — unit-tested in
 * `tests/pipeline/generations.test.ts`.
 *
 * Callers should already be filtering the query itself to rows that
 * *could* be a real result (`error IS NULL AND output IS NOT NULL` — a
 * terminal LLM failure is recorded as a generations row with a null
 * output and a populated `error`, and it must never be able to outrank an
 * older, actually-usable row just because it's newer). `isUsable` below is
 * the second, in-memory line of defense: even a successfully-stored row
 * can fail to satisfy the *current* Zod schema after that schema grows a
 * field, and a query-level filter can't see that.
 */

/** The columns this needs from a `generations` row. */
export interface GenerationLike {
  step: string;
  createdAt: Date;
}

/**
 * Reduces `rows` (any order, any mix of steps) to the single best row per
 * step named in `steps`. A step with no matching row is simply absent from
 * the result, not `undefined`-valued — callers use `.get(step)` and treat a
 * miss as "never generated". Rows for a step not in `steps` are ignored, so
 * one query result can be shared by callers that only want a subset.
 *
 * "Best" means: sort that step's rows newest-first, then take the first
 * one `isUsable` accepts. This lets a newer row that fails validation
 * (e.g. its stored `output` no longer matches the current Zod schema) fall
 * back to an older row that still parses, instead of shadowing it. Without
 * an `isUsable` (the default accepts every row), this is just "the single
 * newest row per step" — the original behavior.
 *
 * Ties (identical `createdAt`, which Postgres timestamps make possible)
 * keep whichever of the tied rows appears first in `rows` — callers that
 * care about a specific tie-break should pre-sort (e.g. by `id`) before
 * calling this.
 */
export function latestGenerationByStep<T extends GenerationLike>(
  rows: readonly T[],
  steps: readonly string[],
  isUsable: (row: T) => boolean = () => true,
): Map<string, T> {
  const wanted = new Set(steps);
  const byStep = new Map<string, T[]>();
  for (const row of rows) {
    if (!wanted.has(row.step)) continue;
    const list = byStep.get(row.step);
    if (list) {
      list.push(row);
    } else {
      byStep.set(row.step, [row]);
    }
  }

  const latest = new Map<string, T>();
  for (const [step, list] of byStep) {
    // Stable sort: ties keep their relative order from `rows`, matching
    // the documented tie-break.
    const newestFirst = [...list].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const usable = newestFirst.find(isUsable);
    // Nothing passed `isUsable` — still surface the newest row rather than
    // dropping the step entirely; callers that safeParse it themselves
    // will get the same "invalid" outcome either way, and a caller that
    // doesn't care about validity (the default) always hits the branch
    // above.
    latest.set(step, usable ?? newestFirst[0]);
  }
  return latest;
}
