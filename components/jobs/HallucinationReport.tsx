import { Badge } from "@/components/ui/badge";
import type { HallucinationReport as HallucinationReportData } from "@/src/pipeline/hallucination";

/**
 * Presentational summary of a `tailor`/`suggest` hallucination check (plan
 * Task 9 Step 2). Lists every unsupported claim the mechanical checker
 * found; `TailorTab` is the one that actually excludes those bullets from
 * the PDF (it owns the per-bullet checkbox state), so this component only
 * reports, it never mutates anything.
 */
export function HallucinationReport({ report }: { report: HallucinationReportData }) {
  if (report.totalClaims === 0) return null;

  const clean = report.unsupported.length === 0;

  return (
    <div
      className={`flex flex-col gap-2 rounded-lg border p-3 ${
        clean ? "border-border" : "border-destructive/30 bg-destructive/5"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">
          {clean
            ? `All ${report.totalClaims} claim${report.totalClaims === 1 ? "" : "s"} are supported by your confirmed facts.`
            : `${report.unsupported.length} of ${report.totalClaims} claim${report.totalClaims === 1 ? "" : "s"} are unsupported and blocked from the PDF.`}
        </p>
        <Badge variant={clean ? "secondary" : "destructive"}>
          {(report.rate * 100).toFixed(0)}% unsupported
        </Badge>
      </div>

      {!clean && (
        <ul className="flex flex-col gap-1.5">
          {report.unsupported.map((claim) => (
            <li key={claim.path} className="text-xs text-destructive">
              <span className="font-mono text-[10px] text-muted-foreground">{claim.path}</span>
              {" — "}
              &ldquo;{claim.text}&rdquo;
              {claim.badIds.length > 0 && (
                <span className="text-muted-foreground">
                  {" "}
                  (cites unknown fact{claim.badIds.length === 1 ? "" : "s"}: {claim.badIds.join(", ")})
                </span>
              )}
              {claim.badIds.length === 0 && (
                <span className="text-muted-foreground"> (no fact cited)</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
