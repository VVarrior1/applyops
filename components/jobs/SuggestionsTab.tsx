"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HallucinationReport } from "./HallucinationReport";
import type { SuggestOutput } from "@/src/pipeline/schemas";
import type { HallucinationReport as HallucinationReportData } from "@/src/pipeline/hallucination";

/** What `/jobs/[id]` loads server-side for the most recent `suggest` generation, if any. */
export interface SuggestInitialGeneration {
  output: SuggestOutput;
  hallucination: HallucinationReportData;
}

export interface SuggestionsTabProps {
  jobId: string;
  initialGeneration: SuggestInitialGeneration | null;
}

async function parseErrorBody(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `Request failed (${res.status}).`;
  } catch {
    return `Request failed (${res.status}).`;
  }
}

const SEVERITY_VARIANT = {
  low: "secondary",
  medium: "default",
  high: "destructive",
} as const;

function FactChips({ ids }: { ids: string[] }) {
  if (ids.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {ids.map((id) => (
        <Badge key={id} variant="outline" className="font-mono text-[10px]">
          {id}
        </Badge>
      ))}
    </div>
  );
}

/**
 * Suggestions tab (plan Task 9 Step 3): gaps with severity badges, what to
 * lead with (fact chips + why), a weekend-build card, likely screening
 * questions, and honest keywords to work in. Purely a read-only report — no
 * bullet is downloaded into anything, so there's nothing here to edit or
 * block, only the hallucination check on `lead_with`/`weekend_build` shown
 * for transparency.
 */
export function SuggestionsTab({ jobId, initialGeneration }: SuggestionsTabProps) {
  const router = useRouter();
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState<SuggestOutput | null>(initialGeneration?.output ?? null);
  const [hallucination, setHallucination] = useState<HallucinationReportData | null>(
    initialGeneration?.hallucination ?? null,
  );

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}/suggest`, { method: "POST" });
      if (!res.ok) {
        setError(await parseErrorBody(res));
        return;
      }
      const body = (await res.json()) as {
        output: SuggestOutput;
        hallucination: HallucinationReportData;
      };
      setOutput(body.output);
      setHallucination(body.hallucination);
      // Refresh server props (plan point 2) so a later reload sees this run.
      router.refresh();
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Button onClick={handleGenerate} disabled={generating}>
          {generating ? "Generating…" : output ? "Regenerate" : "Generate suggestions"}
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}

      {output && (
        <div className="flex flex-col gap-4">
          {hallucination && <HallucinationReport report={hallucination} />}

          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">Gaps</h3>
            {output.gaps.length === 0 ? (
              <p className="text-sm text-muted-foreground">No significant gaps found.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {output.gaps.map((gap, i) => (
                  <div key={i} className="flex flex-col gap-1 rounded-lg border p-2.5">
                    <div className="flex items-center gap-2">
                      <Badge variant={SEVERITY_VARIANT[gap.severity]}>{gap.severity}</Badge>
                      <span className="text-sm font-medium">{gap.requirement}</span>
                    </div>
                    <p className="text-sm text-muted-foreground">{gap.how_to_close}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">Lead with</h3>
            {output.lead_with.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing specific stands out.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {output.lead_with.map((entry, i) => (
                  <div key={i} className="flex flex-col gap-1.5 rounded-lg border p-2.5">
                    <FactChips ids={entry.fact_ids} />
                    <p className="text-sm">{entry.why}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">Weekend build</h3>
            <div className="flex flex-col gap-1.5 rounded-lg border p-2.5">
              <p className="text-sm font-medium">{output.weekend_build.idea}</p>
              <p className="text-sm text-muted-foreground">{output.weekend_build.why}</p>
              <FactChips ids={output.weekend_build.fact_ids} />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">Likely questions</h3>
            <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
              {output.likely_questions.map((question, i) => (
                <li key={i}>{question}</li>
              ))}
            </ul>
          </div>

          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">Keywords to include</h3>
            <div className="flex flex-wrap gap-1.5">
              {output.keywords_to_include.map((keyword) => (
                <Badge key={keyword} variant="secondary">
                  {keyword}
                </Badge>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
