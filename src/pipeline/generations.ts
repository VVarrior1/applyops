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
 */

/** The columns this needs from a `generations` row. */
export interface GenerationLike {
  step: string;
  createdAt: Date;
}

/**
 * Reduces `rows` (any order, any mix of steps) to the single newest row per
 * step named in `steps`. A step with no matching row is simply absent from
 * the result, not `undefined`-valued — callers use `.get(step)` and treat a
 * miss as "never generated". Rows for a step not in `steps` are ignored, so
 * one query result can be shared by callers that only want a subset.
 *
 * Ties (identical `createdAt`, which Postgres timestamps make possible)
 * keep whichever of the tied rows appears first in `rows` — callers that
 * care about a specific tie-break should pre-sort (e.g. by `id`) before
 * calling this.
 */
export function latestGenerationByStep<T extends GenerationLike>(
  rows: readonly T[],
  steps: readonly string[],
): Map<string, T> {
  const wanted = new Set(steps);
  const latest = new Map<string, T>();
  for (const row of rows) {
    if (!wanted.has(row.step)) continue;
    const current = latest.get(row.step);
    if (!current || row.createdAt.getTime() > current.createdAt.getTime()) {
      latest.set(row.step, row);
    }
  }
  return latest;
}
