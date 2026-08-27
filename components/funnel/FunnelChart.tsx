import type { FunnelRow } from "@/src/funnel/derive";

/**
 * CSS-only bar visualization for one funnel row's stage counts — plan Task
 * 10 Step 2: "table + simple bar chart (no external chart lib; CSS bars)".
 * Each bar's width is that stage's count as a fraction of the row's
 * `applied` total, so bars are directly comparable across rows even though
 * each row can have a different number of applications.
 */
const BARS: { key: "applied" | "responded" | "interviewing" | "offers"; label: string; className: string }[] = [
  { key: "applied", label: "Applied", className: "bg-muted-foreground/40" },
  { key: "responded", label: "Responded", className: "bg-primary/60" },
  { key: "interviewing", label: "Interviewing", className: "bg-primary" },
  { key: "offers", label: "Offers", className: "bg-emerald-500" },
];

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export function FunnelChart({ rows }: { rows: FunnelRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No applications yet — nothing to chart.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {rows.map((row) => {
        const [ciLower, ciUpper] = row.responseRateCi95;
        return (
          <div key={row.key} className="flex flex-col gap-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 text-sm">
              <span className="font-medium">{row.key}</span>
              <span className="text-muted-foreground">
                {row.applied} applied · response {pct(row.responseRate)} (CI{" "}
                {Math.round(ciLower * 100)}–{Math.round(ciUpper * 100)}%) · interview{" "}
                {pct(row.interviewRate)}
              </span>
            </div>
            <div className="flex flex-col gap-1">
              {BARS.map((bar) => {
                const count = row[bar.key];
                const width = row.applied > 0 ? (count / row.applied) * 100 : 0;
                return (
                  <div key={bar.key} className="flex items-center gap-2">
                    <span className="w-24 shrink-0 text-xs text-muted-foreground">
                      {bar.label}
                    </span>
                    <div className="h-3 flex-1 overflow-hidden rounded-full bg-muted">
                      <div
                        className={`h-full rounded-full ${bar.className}`}
                        style={{ width: `${width}%` }}
                      />
                    </div>
                    <span className="w-6 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                      {count}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
