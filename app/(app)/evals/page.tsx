import Link from "next/link";
import { requireOwner } from "@/src/auth/require";
import { getDb } from "@/src/db/client";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { defaultModelForStep } from "@/src/llm/defaults";
import { goldenSetSummary } from "@/src/eval/golden";
import { listEvalRuns, type EvalRunListItem } from "@/src/eval/runner";

/**
 * `/evals` — owner-only (spec §7). Every run the harness has ever recorded,
 * newest first, plus the trend of mean judge score for the step's current
 * default model. Numbers come straight out of `eval_runs.metrics`: a run's
 * result must not change because the code that computed it did.
 */

const STEP = "tailor" as const;

function fmt(value: number | null | undefined, digits = 2): string {
  if (value == null || Number.isNaN(value)) return "—";
  return value.toFixed(digits);
}

function usd(value: number | null): string {
  if (value == null) return "—";
  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
}

function ms(value: number | null): string {
  return value == null ? "—" : `${Math.round(value)}`;
}

/**
 * Mean-score trend, drawn server-side as an inline SVG — no chart library, no
 * client bundle, and it degrades to a single dot when there is one run.
 */
function TrendChart({ runs }: { runs: EvalRunListItem[] }) {
  const points = runs
    .filter((run) => run.meanScore != null)
    .slice()
    .reverse()
    .map((run) => ({ at: run.createdAt.getTime(), score: run.meanScore as number, run }));

  if (points.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No scored runs yet for this model.
      </p>
    );
  }

  const width = 640;
  const height = 140;
  const pad = { top: 12, right: 12, bottom: 20, left: 28 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;

  // Fixed 1–5 y-axis: the rubric's range, so two charts are comparable and a
  // one-run chart doesn't look like a cliff.
  const yFor = (score: number) => pad.top + innerH - ((score - 1) / 4) * innerH;
  const xFor = (index: number) =>
    pad.left + (points.length === 1 ? innerW / 2 : (index / (points.length - 1)) * innerW);

  const path = points
    .map((point, i) => `${i === 0 ? "M" : "L"}${xFor(i).toFixed(1)},${yFor(point.score).toFixed(1)}`)
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-36 w-full"
      role="img"
      aria-label={`Mean judge score over ${points.length} runs`}
    >
      {[1, 2, 3, 4, 5].map((tick) => (
        <g key={tick}>
          <line
            x1={pad.left}
            x2={width - pad.right}
            y1={yFor(tick)}
            y2={yFor(tick)}
            className="stroke-border"
            strokeWidth={1}
          />
          <text
            x={pad.left - 6}
            y={yFor(tick) + 3}
            textAnchor="end"
            className="fill-muted-foreground text-[9px]"
          >
            {tick}
          </text>
        </g>
      ))}
      <path d={path} fill="none" className="stroke-primary" strokeWidth={2} />
      {points.map((point, i) => (
        <circle
          key={point.run.id}
          cx={xFor(i)}
          cy={yFor(point.score)}
          r={point.run.baseline ? 4.5 : 3}
          className={point.run.baseline ? "fill-primary" : "fill-background stroke-primary"}
          strokeWidth={2}
        >
          <title>
            {`${point.run.createdAt.toISOString().slice(0, 16).replace("T", " ")} — ${point.score.toFixed(2)}${
              point.run.baseline ? " (baseline)" : ""
            }`}
          </title>
        </circle>
      ))}
    </svg>
  );
}

export default async function EvalsPage() {
  await requireOwner();
  const db = getDb();

  const [runs, golden] = await Promise.all([listEvalRuns(db, 50), goldenSetSummary(db, STEP)]);

  const defaultModel = defaultModelForStep(STEP);
  const trendRuns = runs.filter((run) => run.step === STEP && run.modelId === defaultModel);

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Evals</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every eval run over the golden set. Mean score is the mean of the four judge
            axes (1–5); the gate fails a PR at &gt; 2% hallucination or a CI entirely below
            zero.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <div className="text-right text-sm">
            <div className="font-medium tabular-nums">
              {golden.graded}/{golden.total} graded
            </div>
            <div className="text-xs text-muted-foreground">golden set ({STEP})</div>
          </div>
          <Link href="/evals/grade" className={buttonVariants({ size: "sm" })}>
            Grade items
          </Link>
        </div>
      </header>

      <section className="rounded-lg border p-4">
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold">Mean score over time</h2>
          <span className="text-xs text-muted-foreground">
            {STEP} · {defaultModel} (current default)
          </span>
        </div>
        <TrendChart runs={trendRuns} />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Runs</h2>
        {runs.length === 0 ? (
          <p className="rounded-lg border p-6 text-sm text-muted-foreground">
            No runs yet. Run{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              npm run eval -- --step tailor --items 5
            </code>
            .
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 text-left font-medium">Date</th>
                  <th className="px-3 py-2 text-left font-medium">Step</th>
                  <th className="px-3 py-2 text-left font-medium">Model</th>
                  <th className="px-3 py-2 text-right font-medium" title="Items scored (of items attempted)">
                    n
                  </th>
                  <th className="px-3 py-2 text-right font-medium">Mean</th>
                  <th className="px-3 py-2 text-right font-medium">Halluc.</th>
                  <th className="px-3 py-2 text-right font-medium">κ</th>
                  <th className="px-3 py-2 text-right font-medium">Cost</th>
                  <th className="px-3 py-2 text-right font-medium">p50 / p95</th>
                  <th className="px-3 py-2 text-left font-medium">vs baseline</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => {
                  const halluc = run.hallucinationRate;
                  return (
                    <tr key={run.id} className="border-b last:border-b-0">
                      <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                        {run.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                        {run.baseline ? (
                          <Badge className="ml-2" variant="secondary">
                            baseline
                          </Badge>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">{run.step}</td>
                      <td className="px-3 py-2 font-mono text-xs">{run.modelId}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {run.itemCount ?? "—"}
                        {run.failedItems ? (
                          // n is the *scored* count; without this a 40-item run
                          // where 37 items errored looks like a clean 3-item run.
                          <div
                            className="text-[10px] font-normal text-destructive"
                            title={`${run.failedItems} of ${run.itemsAttempted ?? "?"} items failed and were not scored`}
                          >
                            {run.failedItems} failed
                          </div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-medium">
                        {fmt(run.meanScore)}
                      </td>
                      <td
                        className={`px-3 py-2 text-right tabular-nums ${
                          halluc != null && halluc > 0.02 ? "text-destructive" : ""
                        }`}
                      >
                        {halluc == null ? "—" : `${(halluc * 100).toFixed(2)}%`}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {run.kappa == null ? (
                          <span className="text-xs text-muted-foreground">pending grades</span>
                        ) : (
                          fmt(run.kappa)
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{usd(run.costUsd)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-xs">
                        {ms(run.p50Ms)} / {ms(run.p95Ms)} ms
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {run.vsBaseline ? (
                          <span
                            className={
                              run.vsBaseline.ci95[1] < 0
                                ? "text-destructive"
                                : run.vsBaseline.ci95[0] > 0
                                  ? "text-emerald-600 dark:text-emerald-400"
                                  : "text-muted-foreground"
                            }
                          >
                            {run.vsBaseline.diff >= 0 ? "+" : ""}
                            {fmt(run.vsBaseline.diff)} [{fmt(run.vsBaseline.ci95[0])},{" "}
                            {fmt(run.vsBaseline.ci95[1])}]
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
