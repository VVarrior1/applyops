import Link from "next/link";
import { Input } from "@/components/ui/input";

/** "3" | "7" | "14" | "30" (days) or "any" — no lower bound. */
export type PostedFilter = "3" | "7" | "14" | "30" | "any";

/** "mine" (default when the user has a `roles` preference set) or "any" (no title filter). */
export type RolesFilter = "mine" | "any";

export interface JobFiltersValue {
  minScore: number | null;
  remote: "any" | "remote" | "onsite";
  workAuth: string;
  vendor: string;
  /** "my" (default, the user's prefs.countries), "any", "unknown", or one of `userCountries`' codes. */
  country: string;
  /** "worth" (default, hide skip-verdict rows) or "all". */
  verdict: "worth" | "all";
  /** Posted-date window — default "7". */
  posted: PostedFilter;
  /** Free-text search over title OR company name (case-insensitive), trimmed; "" = no search. */
  q: string;
  /** Title-vs-role-family filter (src/rank/role-titles.ts) — default "mine" when the user has `prefs.roles` set. */
  roles: RolesFilter;
}

const POSTED_OPTIONS: { value: PostedFilter; label: string }[] = [
  { value: "3", label: "3 days" },
  { value: "7", label: "7 days" },
  { value: "14", label: "14 days" },
  { value: "30", label: "30 days" },
  { value: "any", label: "Any time" },
];

/** Mirrors `POSTED_OPTIONS`' labels — what the prominent "Posted within: …" line reads. */
export const POSTED_WINDOW_LABEL: Record<PostedFilter, string> = {
  "3": "3 days",
  "7": "7 days",
  "14": "14 days",
  "30": "30 days",
  any: "any time",
};

const WORK_AUTH_OPTIONS: { value: string; label: string }[] = [
  { value: "any", label: "Any work-auth signal" },
  { value: "hires_canadians", label: "Hires Canadians" },
  { value: "tn_friendly", label: "TN friendly" },
  { value: "needs_us_auth", label: "Needs US auth" },
  { value: "unclear", label: "Unclear" },
];

const VENDOR_OPTIONS: { value: string; label: string }[] = [
  { value: "any", label: "Any vendor" },
  { value: "greenhouse", label: "Greenhouse" },
  { value: "lever", label: "Lever" },
  { value: "ashby", label: "Ashby" },
  { value: "recruitee", label: "Recruitee" },
  { value: "personio", label: "Personio" },
  { value: "smartrecruiters", label: "SmartRecruiters" },
  { value: "yc", label: "YC" },
  { value: "other", label: "Other" },
];

/** Shared with the native `<select>`s below — matches `Input`'s own classes so the whole bar reads as one control set. */
const SELECT_CLASSES =
  "h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

/**
 * `/jobs`'s filter bar: search, posted-date window, role family, min score,
 * remote, work-auth, vendor, country, and verdict. A plain `method="GET"`
 * form with native form controls — no client JS, same "the URL is the
 * state" approach the `/funnel` page's group-by toggle already uses, just
 * with more fields than a handful of links can express cleanly.
 * `/jobs/page.tsx` reads the resulting `searchParams` and does the actual
 * filtering server-side. The posted-date window also gets its own
 * always-visible line above the form ("Posted within: …") since it's the
 * one filter most likely to silently narrow the results without the user
 * noticing a `<select>` buried in the bar.
 */
export function JobFilters({
  value,
  userCountries,
  userRoles,
}: {
  value: JobFiltersValue;
  /** The signed-in user's `prefs.countries`, resolved to names — populates the per-country options. */
  userCountries: { code: string; name: string }[];
  /** The signed-in user's `prefs.roles` — labels the "My roles" option and decides whether it's meaningfully different from "Any role". */
  userRoles: string[];
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">
        Posted within:{" "}
        <span className="text-primary">{POSTED_WINDOW_LABEL[value.posted]}</span>
      </p>
      <form
        method="GET"
        className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-3"
      >
        <div className="flex flex-col gap-1">
          <label htmlFor="q" className="text-xs text-muted-foreground">
            Search title or company
          </label>
          <Input
            id="q"
            name="q"
            type="search"
            defaultValue={value.q}
            placeholder="e.g. backend, Acme"
            className="w-44"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="posted" className="text-xs text-muted-foreground">
            Posted within
          </label>
          <select id="posted" name="posted" defaultValue={value.posted} className={SELECT_CLASSES}>
            {POSTED_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="roles" className="text-xs text-muted-foreground">
            Role family
          </label>
          <select id="roles" name="roles" defaultValue={value.roles} className={SELECT_CLASSES}>
            <option value="mine">
              My roles{userRoles.length > 0 ? ` (${userRoles.join(", ")})` : ""}
            </option>
            <option value="any">Any role</option>
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="minScore" className="text-xs text-muted-foreground">
            Min fit score (0–100)
          </label>
          <Input
            id="minScore"
            name="minScore"
            type="number"
            min={0}
            max={100}
            inputMode="numeric"
            defaultValue={value.minScore ?? ""}
            placeholder="0"
            className="w-20"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="remote" className="text-xs text-muted-foreground">
            Remote
          </label>
          <select id="remote" name="remote" defaultValue={value.remote} className={SELECT_CLASSES}>
            <option value="any">Any</option>
            <option value="remote">Remote only</option>
            <option value="onsite">On-site only</option>
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="workAuth" className="text-xs text-muted-foreground">
            Work auth
          </label>
          <select id="workAuth" name="workAuth" defaultValue={value.workAuth} className={SELECT_CLASSES}>
            {WORK_AUTH_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="vendor" className="text-xs text-muted-foreground">
            Vendor
          </label>
          <select id="vendor" name="vendor" defaultValue={value.vendor} className={SELECT_CLASSES}>
            {VENDOR_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="country" className="text-xs text-muted-foreground">
            Country
          </label>
          <select id="country" name="country" defaultValue={value.country} className={SELECT_CLASSES}>
            <option value="my">My countries (default)</option>
            <option value="any">Any country</option>
            <option value="unknown">Unknown only</option>
            {userCountries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name} ({c.code}) only
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="verdict" className="text-xs text-muted-foreground">
            Verdict
          </label>
          <select id="verdict" name="verdict" defaultValue={value.verdict} className={SELECT_CLASSES}>
            <option value="worth">Worth applying (hide skip)</option>
            <option value="all">All, incl. skip</option>
          </select>
        </div>

        <button
          type="submit"
          className="h-8 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/80"
        >
          Apply filters
        </button>
        <Link
          href="/jobs"
          className="text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Clear
        </Link>
      </form>
    </div>
  );
}
