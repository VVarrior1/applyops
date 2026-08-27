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

/**
 * Categories collapsed to a chip summary by default (when they have enough
 * facts to be worth collapsing — see `COLLAPSED_PREVIEW_COUNT`). Exported so
 * the onboarding facts review and the settings facts editor share this
 * single policy instead of each declaring their own copy that can drift.
 */
const COLLAPSED_BY_DEFAULT = new Set(["skill"]);

/**
 * How many facts to show as preview chips in a collapsed section before the
 * "Show all N" control. Also used as the threshold below which a
 * default-collapsed category isn't collapsed at all — collapsing 3 chips
 * behind a "Show all 3" button that reveals the same 3 items is pointless.
 */
export const COLLAPSED_PREVIEW_COUNT = 8;

/**
 * Whether `category` should render collapsed-by-default, given it has
 * `count` facts. Small groups (at or under `COLLAPSED_PREVIEW_COUNT`) are
 * never collapsed since there's nothing to hide.
 */
export function isCollapsedByDefault(category: string, count: number): boolean {
  return COLLAPSED_BY_DEFAULT.has(category) && count > COLLAPSED_PREVIEW_COUNT;
}

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
