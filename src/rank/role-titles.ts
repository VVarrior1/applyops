/**
 * Role-family → title-matching pattern (Jobs page spec item 4). Maps a
 * user's `search_prefs.roles` values (see `ROLE_OPTIONS` in
 * `app/(app)/onboarding/prefs-form.tsx`: SWE, Full-stack, Backend, Frontend,
 * ML/AI, Data, DevOps/SRE, Mobile) to a regex over job titles, so "does this
 * posting's title look like a role this user is searching for?" is answered
 * in one place and shared by:
 *
 *   - `/jobs`'s `roles=mine` filter, as a Postgres regex (`title ~* ...`)
 *   - `src/rank/rank.ts`'s candidate selection, the same SQL condition
 *   - `titleMatchesRoles`, a plain JS predicate for tests/callers with no DB
 *
 * Word boundaries are written with the JS-standard `\b`. JS's `RegExp`
 * engine reads `\b` as a word boundary; Postgres's regex engine (POSIX
 * "Advanced Regular Expressions") does not — there `\b` is the backspace
 * character-entry escape, and the real word-boundary constraint is `\y`
 * (verified against the live DB: `'ML Engineer' ~* '\bml\b'` is false,
 * `'ML Engineer' ~* '\yml\y'` is true). {@link roleTitlePatternSource}
 * therefore builds the one canonical `\b` pattern and swaps it to `\y` only
 * in the string handed to Postgres; {@link roleTitlePattern}'s `RegExp`
 * keeps the original `\b`, which is what JS expects.
 */

/** A role value with no entry here is ignored, not an error — `search_prefs.roles` is user-editable data (see `SavePrefsInput`), not a closed enum enforced at the DB layer. */
const ROLE_PATTERN_BODY: Record<string, string> = {
  SWE: "software (engineer|developer)|swe|\\bsde\\b|engineer\\b",
  "Full-stack": "full-?stack",
  Backend: "back-?end|platform|api|server|infrastructure",
  Frontend: "front-?end|web developer|ui engineer|react",
  "ML/AI": "machine learning|\\bml\\b|\\bai\\b|deep learning|llm|nlp|computer vision",
  Data: "data (engineer|scientist|analyst)|analytics",
  "DevOps/SRE": "devops|sre|site reliability|cloud engineer|platform engineer",
  Mobile: "ios|android|mobile|react native|flutter",
};

/**
 * Combines the recognized roles' pattern bodies into one `\b`-flavored
 * alternation (each role's own body parenthesized so its internal `|`
 * alternatives don't leak into the next role's), or `null` when none of
 * `roles` is recognized — including an empty list.
 */
function combinedPatternBody(roles: readonly string[]): string | null {
  const bodies = roles.map((role) => ROLE_PATTERN_BODY[role]).filter((b): b is string => Boolean(b));
  if (bodies.length === 0) return null;
  const unique = Array.from(new Set(bodies));
  return unique.map((body) => `(?:${body})`).join("|");
}

/**
 * A case-insensitive `RegExp` matching a title that looks like one of
 * `roles`, or `null` when `roles` is empty or none of it is a recognized
 * role family (nothing to build a pattern from).
 */
export function roleTitlePattern(roles: string[]): RegExp | null {
  const body = combinedPatternBody(roles);
  return body === null ? null : new RegExp(body, "i");
}

/**
 * The same pattern as {@link roleTitlePattern}, as a Postgres-`~*`-safe
 * source string — word boundaries rewritten to `\y` (see the file header)
 * — for `/jobs`'s SQL filter and `rank.ts`'s candidate query to bind into
 * `title ~* <this>`. `null` under the same conditions as
 * {@link roleTitlePattern}.
 */
export function roleTitlePatternSource(roles: string[]): string | null {
  const body = combinedPatternBody(roles);
  return body === null ? null : body.replace(/\\b/g, "\\y");
}

/**
 * Whether `title` looks like one of `roles`. `true` when `roles` is empty
 * or none of it is recognized — nothing to filter on means nothing is
 * excluded, the same "no preference = no restriction" convention
 * `countriesAllow` (src/finders/country.ts) uses for an empty countries list.
 */
export function titleMatchesRoles(title: string, roles: string[]): boolean {
  const pattern = roleTitlePattern(roles);
  return pattern === null ? true : pattern.test(title);
}
