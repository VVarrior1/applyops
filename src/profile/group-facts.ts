/**
 * Groups a flat list of facts by category for display.
 *
 * The owner's resume produces facts skewed heavily toward one category (32
 * "skill" out of 49 total) — rendering that as one flat list buries
 * experience, project, and education entries under a wall of skills (plan
 * Task 17). This module is the pure, presentation-agnostic grouping used by
 * both the onboarding facts review and the settings facts editor so they
 * stay in sync on section order and don't each reinvent it.
 *
 * Pure and generic over any fact-like shape that carries at least a
 * `category` string, so it works directly against the onboarding review's
 * local draft shape and the settings editor's persisted-row shape without
 * either one converting to a shared type first.
 */

/** Fixed section order: substantive categories first, high-volume "skill" last. */
const CATEGORY_ORDER = ["experience", "project", "education", "other", "skill"] as const;

const CATEGORY_LABELS: Record<string, string> = {
  experience: "Experience",
  project: "Projects",
  education: "Education",
  other: "Other",
  skill: "Skills",
};

export interface CategorizedFact {
  category: string;
}

export interface FactGroup<T extends CategorizedFact> {
  category: string;
  label: string;
  count: number;
  facts: T[];
}

function labelFor(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

/**
 * Groups `facts` by `.category`, ordered experience → project → education →
 * other → skill. A category with no facts is omitted entirely (the caller
 * never has to filter out a zero-count group). Any category outside that
 * fixed set — there shouldn't be any, `FACT_CATEGORIES` in
 * `src/pipeline/schemas.ts` defines exactly these five, but this is
 * user-adjacent data — is appended after, in first-seen order, so nothing is
 * ever silently dropped.
 */
export function groupFacts<T extends CategorizedFact>(facts: readonly T[]): FactGroup<T>[] {
  const buckets = new Map<string, T[]>();
  for (const fact of facts) {
    const bucket = buckets.get(fact.category);
    if (bucket) {
      bucket.push(fact);
    } else {
      buckets.set(fact.category, [fact]);
    }
  }

  const knownOrder = CATEGORY_ORDER as readonly string[];
  const extraCategories = [...buckets.keys()].filter((c) => !knownOrder.includes(c));
  const order = [...CATEGORY_ORDER, ...extraCategories];

  const groups: FactGroup<T>[] = [];
  for (const category of order) {
    const bucket = buckets.get(category);
    if (!bucket || bucket.length === 0) continue;
    groups.push({ category, label: labelFor(category), count: bucket.length, facts: bucket });
  }
  return groups;
}
