/**
 * Redaction helpers for public-facing surfaces — spec §9: "Public `/results`:
 * owner's funnel with company names replaced by `Company #n` ... no company
 * names, no job titles beyond role family." Pure, no I/O: every caller
 * (`src/funnel/public-results.ts`, which feeds both `/results`'s page and its
 * public API route) supplies plain data pulled from the DB and gets back
 * display-safe labels. Nothing here writes to the database or changes what is
 * stored — only what a public, unauthenticated visitor is shown.
 */

export interface RedactableCompany {
  company: string;
}

/**
 * Replaces each item's company name with a stable `Company #n` label,
 * numbered by order of first appearance (1-based). The same employer
 * mentioned more than once always gets the same number, so a reader can
 * still see "this employer came up twice" without learning who it is.
 *
 * Matching is case- and whitespace-insensitive ("Stripe" / " stripe " /
 * "STRIPE" are the same company) since that's the kind of inconsistency
 * that shows up in scraped/imported company names.
 *
 * `redactCompanies([{company:'Stripe'},{company:'Stripe'},{company:'Shopify'}])`
 * → `['Company #1', 'Company #1', 'Company #2']`
 */
export function redactCompanies<T extends RedactableCompany>(items: readonly T[]): string[] {
  const numberByName = new Map<string, number>();

  return items.map((item) => {
    const key = item.company.trim().toLowerCase();
    let n = numberByName.get(key);
    if (n == null) {
      n = numberByName.size + 1;
      numberByName.set(key, n);
    }
    return `Company #${n}`;
  });
}

/**
 * Coarse, publishable role category for a job title — the "role family"
 * spec §9 allows on `/results` in place of the actual title (e.g. "Senior
 * Backend Engineer at a specific employer" reveals more than a public page
 * should; "Backend" doesn't). Matched by keyword, most-specific bucket
 * first: broader engineering titles (like "DevOps *Engineer*" or "Data
 * *Engineer*") would otherwise fall into the generic "Software Engineering"
 * catch-all, which is why that one is checked last.
 *
 * Advisory only, same spirit as `src/finders/filters.ts`'s heuristics: a
 * title this doesn't recognize lands in `"Other"` rather than guessing.
 */
export function roleFamily(title: string): string {
  const t = title.toLowerCase();

  const buckets: [RegExp, string][] = [
    [/\b(data scientist|data science|machine learning|\bml\b|\bai\b|artificial intelligence|data engineer)\b/, "Data / ML"],
    [/\b(data analyst|analytics|business intelligence|\bbi\b)\b/, "Data / Analytics"],
    [/\b(product manager|product owner|\bpm\b)\b/, "Product"],
    [/\b(designer|\bux\b|\bui\b|user experience|user interface)\b/, "Design"],
    [/\b(devops|\bsre\b|site reliability|platform engineer|infrastructure|cloud engineer)\b/, "DevOps / Infra"],
    [/\b(security engineer|appsec|infosec|cybersecurity)\b/, "Security"],
    [/\b(\bqa\b|quality assurance|\bsdet\b|test engineer)\b/, "QA / Test"],
    [/\b(mobile|\bios\b|android)\b/, "Mobile"],
    [/\b(full[\s-]?stack)\b/, "Full Stack"],
    [/\b(front[\s-]?end)\b/, "Frontend"],
    [/\b(back[\s-]?end)\b/, "Backend"],
    [/\b(software engineer|software developer|\bswe\b|developer|engineer)\b/, "Software Engineering"],
  ];

  for (const [pattern, family] of buckets) {
    if (pattern.test(t)) return family;
  }
  return "Other";
}
