/**
 * Run artifacts (spec §7): `eval-report.json` for machines — the CI gate, a
 * diff between two runs, a future dashboard — and `eval-report.html` for the
 * human who has to decide whether a red gate is a real regression.
 *
 * The HTML is a single self-contained file with inline CSS and no scripts: it
 * has to survive being uploaded as a CI artifact and opened from a `file://`
 * URL, where a CDN stylesheet would silently vanish.
 */

import fs from "node:fs";
import path from "node:path";
import type { EvalResultRow, EvalRunSummary } from "./runner";

export interface WrittenReports {
  json: string;
  html: string;
}

/** The exact JSON shape written to disk — the CI gate reads this. */
export interface EvalReportJson {
  generatedAt: string;
  summary: Omit<EvalRunSummary, "results">;
  results: EvalResultRow[];
}

export function buildReportJson(
  summary: EvalRunSummary,
  perItem: readonly EvalResultRow[],
): EvalReportJson {
  // `results` is stripped from the summary so the file has exactly one copy of
  // the per-item rows.
  const { results: _attached, ...rest } = summary;
  return {
    generatedAt: new Date().toISOString(),
    summary: rest,
    results: [...perItem],
  };
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmt(value: number | null | undefined, digits = 2): string {
  if (value == null || Number.isNaN(value)) return "—";
  return value.toFixed(digits);
}

function usd(value: number): string {
  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
}

/** Colour a mean score 1–5 the way the page reads it: red low, green high. */
function scoreClass(score: number | null): string {
  if (score == null) return "muted";
  if (score >= 4.25) return "good";
  if (score >= 3.5) return "ok";
  return "bad";
}

export function renderReportHtml(
  summary: EvalRunSummary,
  perItem: readonly EvalResultRow[],
): string {
  const ci = summary.vsBaseline;
  const cards: Array<[string, string, string]> = [
    ["Mean judge score", fmt(summary.meanScore), `${summary.n} items scored`],
    [
      "Hallucination rate",
      `${(summary.hallucinationRate * 100).toFixed(2)}%`,
      "unsupported claims ÷ all claims",
    ],
    [
      "Judge vs human κ",
      summary.kappa == null ? "n/a — AI-judged" : fmt(summary.kappa),
      `${summary.gradedItems} graded items`,
    ],
    ["Cost", usd(summary.costUsd), `${usd(summary.costUsd / Math.max(1, summary.n))} / item`],
    ["Latency p50", `${Math.round(summary.p50Ms)} ms`, `p95 ${Math.round(summary.p95Ms)} ms`],
    [
      "vs baseline",
      ci ? `${ci.diff >= 0 ? "+" : ""}${fmt(ci.diff)}` : "no baseline",
      ci ? `95% CI [${fmt(ci.ci95[0])}, ${fmt(ci.ci95[1])}]` : "run with --baseline to set one",
    ],
  ];

  const rows = perItem
    .map((row) => {
      const badge = row.error
        ? `<span class="pill bad">failed</span>`
        : row.hallucinationCount > 0
          ? `<span class="pill warn">${row.hallucinationCount}/${row.totalClaims} unsupported</span>`
          : `<span class="pill good">clean</span>`;
      const axes = row.judgeScores
        ? `${row.judgeScores.grounding} / ${row.judgeScores.coverage} / ${row.judgeScores.specificity} / ${row.judgeScores.stuffing_penalty}`
        : "—";
      const human = row.humanGrades
        ? `${row.humanGrades.grounding} / ${row.humanGrades.coverage} / ${row.humanGrades.specificity} / ${row.humanGrades.stuffing_penalty}`
        : "—";
      return `<tr>
  <td><div class="title">${escapeHtml(row.title)}</div><div class="sub">${escapeHtml(row.company)}</div></td>
  <td class="num ${scoreClass(row.meanScore)}">${fmt(row.meanScore)}</td>
  <td class="num">${axes}</td>
  <td class="num">${human}</td>
  <td>${badge}</td>
  <td class="num">${usd(row.costUsd)}</td>
  <td class="num">${row.latencyMs == null ? "—" : `${Math.round(row.latencyMs)} ms`}</td>
</tr>${
        row.error
          ? `<tr class="errorrow"><td colspan="7">${escapeHtml(row.error)}</td></tr>`
          : ""
      }`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Eval run — ${escapeHtml(summary.step)} · ${escapeHtml(summary.modelId)}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff; --fg: #14161a; --muted: #6b7280; --line: #e5e7eb;
    --card: #f8fafc; --good: #15803d; --ok: #a16207; --bad: #b91c1c; --warn: #b45309;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b0d10; --fg: #e8eaed; --muted: #9aa1ab; --line: #23262b;
      --card: #14171b; --good: #4ade80; --ok: #fbbf24; --bad: #f87171; --warn: #fbbf24;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 2rem 1.25rem 4rem; background: var(--bg); color: var(--fg);
         font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 1080px; margin: 0 auto; }
  h1 { font-size: 1.35rem; margin: 0 0 .25rem; letter-spacing: -0.01em; }
  .meta { color: var(--muted); font-size: .82rem; margin-bottom: 1.5rem; }
  .meta code { font-size: .78rem; }
  .cards { display: grid; gap: .75rem; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); margin-bottom: 2rem; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: .85rem .95rem; }
  .card .label { color: var(--muted); font-size: .72rem; text-transform: uppercase; letter-spacing: .04em; }
  .card .value { font-size: 1.5rem; font-weight: 600; margin: .15rem 0; font-variant-numeric: tabular-nums; }
  .card .sub { color: var(--muted); font-size: .75rem; }
  table { width: 100%; border-collapse: collapse; font-size: .85rem; }
  th { text-align: left; color: var(--muted); font-weight: 500; font-size: .72rem;
       text-transform: uppercase; letter-spacing: .04em; padding: .5rem .6rem; border-bottom: 1px solid var(--line); }
  td { padding: .55rem .6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .title { font-weight: 500; }
  .sub { color: var(--muted); font-size: .78rem; }
  .good { color: var(--good); } .ok { color: var(--ok); } .bad { color: var(--bad); } .muted { color: var(--muted); }
  .pill { display: inline-block; padding: .1rem .45rem; border-radius: 999px; font-size: .72rem;
          border: 1px solid currentColor; }
  .pill.good { color: var(--good); } .pill.warn { color: var(--warn); } .pill.bad { color: var(--bad); }
  .errorrow td { color: var(--bad); font-size: .78rem; padding-top: 0; border-bottom: 1px solid var(--line); }
  footer { color: var(--muted); font-size: .75rem; margin-top: 2rem; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(summary.step)} · ${escapeHtml(summary.modelId)}${summary.baseline ? " · baseline" : ""}</h1>
  <p class="meta">
    run <code>${escapeHtml(summary.runId)}</code> · ${escapeHtml(summary.createdAt)} ·
    judge <code>${escapeHtml(summary.judgeModelId)}</code> ·
    git <code>${escapeHtml(summary.gitSha ?? "unknown")}</code> ·
    ${summary.itemsAttempted} items attempted, ${summary.failedItems} failed
  </p>
  <section class="cards">
    ${cards
      .map(
        ([label, value, sub]) => `<div class="card">
      <div class="label">${escapeHtml(label)}</div>
      <div class="value">${escapeHtml(value)}</div>
      <div class="sub">${escapeHtml(sub)}</div>
    </div>`,
      )
      .join("\n    ")}
  </section>
  <table>
    <thead>
      <tr>
        <th>Item</th>
        <th class="num">Mean</th>
        <th class="num">Judge (G/C/S/St)</th>
        <th class="num">Human (G/C/S/St)</th>
        <th>Citations</th>
        <th class="num">Cost</th>
        <th class="num">Latency</th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <footer>
    Mean score is the mean over items of the mean of the four judge axes (grounding, coverage,
    specificity, stuffing penalty), each 1–5. Hallucination rate pools every citable claim in the
    run. Cost includes the analyze, tailor and judge calls for each item.
  </footer>
</main>
</body>
</html>
`;
}

/**
 * Write both reports into `dir`, creating it if needed.
 *
 * @returns absolute paths of the two files.
 */
export function writeReports(
  summary: EvalRunSummary,
  perItem: readonly EvalResultRow[],
  dir: string,
): WrittenReports {
  fs.mkdirSync(dir, { recursive: true });
  const json = path.resolve(dir, "eval-report.json");
  const html = path.resolve(dir, "eval-report.html");

  fs.writeFileSync(json, `${JSON.stringify(buildReportJson(summary, perItem), null, 2)}\n`, "utf8");
  fs.writeFileSync(html, renderReportHtml(summary, perItem), "utf8");

  return { json, html };
}

/** The plain-text table `applyops eval` prints when a run finishes. */
export function renderConsoleSummary(summary: EvalRunSummary): string {
  const lines = [
    "",
    `Run ${summary.runId}${summary.baseline ? "  [baseline]" : ""}`,
    `  step             ${summary.step}`,
    `  model            ${summary.modelId}`,
    `  judge            ${summary.judgeModelId}`,
    `  items            ${summary.n} scored` +
      (summary.failedItems ? `, ${summary.failedItems} failed` : ""),
    `  mean score       ${fmt(summary.meanScore)} / 5`,
    `  hallucination    ${(summary.hallucinationRate * 100).toFixed(2)}%`,
    `  kappa (vs human) ${summary.kappa == null ? "n/a — AI-judged (no human grading planned)" : fmt(summary.kappa)}`,
    `  cost             ${usd(summary.costUsd)} (${usd(summary.costUsd / Math.max(1, summary.n))}/item)`,
    `  latency          p50 ${Math.round(summary.p50Ms)} ms · p95 ${Math.round(summary.p95Ms)} ms`,
  ];
  if (summary.vsBaseline) {
    const { diff, ci95, baselineRunId } = summary.vsBaseline;
    lines.push(
      `  vs baseline      ${diff >= 0 ? "+" : ""}${fmt(diff)}  95% CI [${fmt(ci95[0])}, ${fmt(ci95[1])}]  (run ${baselineRunId})`,
    );
  } else {
    lines.push("  vs baseline      no baseline run for this step yet");
  }
  return lines.join("\n");
}

/** Per-item table for the console — one line per item, aligned. */
export function renderConsoleTable(perItem: readonly EvalResultRow[]): string {
  const header = ["mean", "G", "C", "S", "St", "halluc", "ms", "item"];
  const rows = perItem.map((row) => [
    row.meanScore == null ? "—" : fmt(row.meanScore),
    row.judgeScores ? String(row.judgeScores.grounding) : "—",
    row.judgeScores ? String(row.judgeScores.coverage) : "—",
    row.judgeScores ? String(row.judgeScores.specificity) : "—",
    row.judgeScores ? String(row.judgeScores.stuffing_penalty) : "—",
    row.error ? "FAILED" : `${row.hallucinationCount}/${row.totalClaims}`,
    row.latencyMs == null ? "—" : String(Math.round(row.latencyMs)),
    `${row.title} — ${row.company}`,
  ]);

  const widths = header.map((head, i) =>
    Math.max(head.length, ...rows.map((row) => row[i].length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => (i === cells.length - 1 ? cell : cell.padStart(widths[i])))
      .join("  ");

  return [line(header), ...rows.map(line)].join("\n");
}
