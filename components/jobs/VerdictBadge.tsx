import { VERDICT_LABEL, type Verdict } from "@/src/rank/verdict";

/**
 * Shared "is this worth applying to?" badge — used on the Jobs list
 * (`JobList`), the Jobs page header count, and the top of `/jobs/[id]`.
 * Color follows the verdict, not an arbitrary variant: green for `apply`,
 * amber for `maybe`, red for `skip` — one place decides that mapping so all
 * three surfaces read the same way.
 */
const VERDICT_CLASSES: Record<Verdict, string> = {
  apply:
    "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/20",
  maybe: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/20",
  skip: "bg-destructive/10 text-destructive border-destructive/20",
};

export function VerdictBadge({
  verdict,
  reasons,
  className = "",
}: {
  verdict: Verdict;
  /** Full reasons list — rendered as the badge's `title` tooltip. */
  reasons?: string[];
  className?: string;
}) {
  return (
    <span
      title={reasons && reasons.length > 0 ? reasons.join("\n") : undefined}
      className={`inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 rounded-4xl border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${VERDICT_CLASSES[verdict]} ${className}`}
    >
      {VERDICT_LABEL[verdict]}
    </span>
  );
}
