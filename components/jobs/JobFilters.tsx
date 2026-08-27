import Link from "next/link";
import { Input } from "@/components/ui/input";

export interface JobFiltersValue {
  minScore: number | null;
  remote: "any" | "remote" | "onsite";
  workAuth: string;
  vendor: string;
}

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
 * `/jobs`'s filter bar (plan Task 8 Step 3: min score, remote, work-auth,
 * vendor). A plain `method="GET"` form with native form controls — no
 * client JS, same "the URL is the state" approach the `/funnel` page's
 * group-by toggle already uses, just with more fields than a handful of
 * links can express cleanly. `/jobs/page.tsx` reads the resulting
 * `searchParams` and does the actual filtering server-side.
 */
export function JobFilters({ value }: { value: JobFiltersValue }) {
  return (
    <form
      method="GET"
      className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-3"
    >
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
  );
}
