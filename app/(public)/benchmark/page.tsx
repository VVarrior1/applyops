import type { Metadata } from "next";
import { unstable_cache } from "next/cache";
import {
  BENCHMARK_CACHE_SECONDS,
  BENCHMARK_CACHE_TAG,
  loadBenchmarkBoard,
  type BenchmarkBoard,
  type BenchmarkRow,
} from "@/src/bench/bench";
import { getDb } from "@/src/db/client";

/**
 * `/benchmark` — public (spec §8).
 *
 * Every number here is read straight out of `eval_runs`, the same table the
 * owner-only `/evals` page reads: there is deliberately no second, friendlier
 * set of figures for the public. What the page adds is the disclosure a
 * scoreboard needs to be worth anything — which model graded, on which rubric
 * version, over how many items, on what date, and where the measurement is
 * weak. The caveats section is not boilerplate; it is the part that makes the
 * table honest.
 *
 * Rendered per request and cached for an hour (Next's data cache + a CDN
 * `Cache-Control`), because a benchmark run happens a few times a year and an
 * uncached public route querying Postgres is a free DoS lever.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Model benchmark",
  description:
    "Mean judge score, hallucination rate, cost per item and latency for every model ApplyOps has benchmarked, per pipeline step.",
};

const getBoard = unstable_cache(
  async () => loadBenchmarkBoard(getDb()),
  [BENCHMARK_CACHE_TAG, "page"],
  { revalidate: BENCHMARK_CACHE_SECONDS, tags: [BENCHMARK_CACHE_TAG] },
);

/** What each benchmarked step does, and what its rubric grades. */
const STEP_META: Record<string, { title: string; what: string; graded: string }> = {
  analyze: {
    title: "Analyze",
    what: "Reads one job posting and extracts its requirements, seniority, work-authorization signal and ATS keywords. Runs once per posting and is shared by every user.",
    graded: "judge_analyze.v1.md — precision and completeness of the extraction against the posting text.",
  },
  fit: {
    title: "Fit",
    what: "Scores one analyzed posting against the candidate's confirmed facts, citing the facts that prove each match. This is the ranker, and the highest-volume call in the system.",
    graded: "judge_fit.v1.md — whether the cited evidence really proves each match, and whether every must-have is accounted for.",
  },
  tailor: {
    title: "Tailor",
    what: "Rewrites the resume for one posting. Every bullet must cite a confirmed fact; uncited bullets are mechanically stripped before the PDF is rendered.",
    graded: "judge.v1.md — grounding, coverage, specificity, and a penalty for keyword stuffing.",
  },
  suggest: {
    title: "Suggest",
    what: "Turns the gap between the posting and the profile into concrete actions: what to lead with, what to build this weekend, what questions to expect.",
    graded: "judge_suggest.v1.md — actionability and grounding of the advice.",
  },
};

const fmt = {
  score: (v: number | null) => (v == null ? "—" : v.toFixed(2)),
  pct: (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`),
  usd: (v: number | null) => (v == null ? "—" : `$${v.toFixed(5)}`),
  ms: (v: number | null) => (v == null ? "—" : `${Math.round(v).toLocaleString("en-US")}`),
  date: (iso: string) => iso.slice(0, 10),
};

/** The eval gate's own threshold (spec §7), reused as the page's colour rule. */
const HALLUCINATION_LIMIT = 0.02;

function ScoreBar({ value }: { value: number | null }) {
  // The rubric is 1–5, so the bar is drawn over that range rather than 0–5:
  // a 1.0 is the floor of the scale, not "20% good".
  const pct = value == null ? 0 : Math.max(0, Math.min(1, (value - 1) / 4)) * 100;
  return (
    <span
      aria-hidden
      className="mt-1 block h-1 w-full max-w-24 overflow-hidden rounded-full bg-muted"
    >
      <span className="block h-full rounded-full bg-foreground/70" style={{ width: `${pct}%` }} />
    </span>
  );
}

function StepTable({ rows }: { rows: BenchmarkRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[46rem] border-collapse text-sm">
        <thead>
          <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th scope="col" className="py-2 pr-4 font-medium">Model</th>
            <th scope="col" className="py-2 pr-4 text-right font-medium">Mean score</th>
            <th scope="col" className="py-2 pr-4 text-right font-medium">95% CI</th>
            <th scope="col" className="py-2 pr-4 text-right font-medium">Hallucination</th>
            <th scope="col" className="py-2 pr-4 text-right font-medium">$/item</th>
            <th scope="col" className="py-2 pr-4 text-right font-medium">p50 ms</th>
            <th scope="col" className="py-2 pr-4 text-right font-medium">n</th>
            <th scope="col" className="py-2 text-right font-medium">Run date</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.runId} className="border-b last:border-0 align-top">
              <th scope="row" className="py-3 pr-4 text-left font-normal">
                <span className="font-mono text-[13px]">{row.modelId}</span>
                {row.isDefault && (
                  <span className="ml-2 rounded-full border px-1.5 py-0.5 align-middle text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    shipped
                  </span>
                )}
                <ScoreBar value={row.meanScore} />
              </th>
              <td className="py-3 pr-4 text-right tabular-nums font-medium">
                {fmt.score(row.meanScore)}
              </td>
              <td className="py-3 pr-4 text-right tabular-nums text-muted-foreground">
                {row.meanCi ? `${fmt.score(row.meanCi[0])}–${fmt.score(row.meanCi[1])}` : "—"}
              </td>
              <td
                className={`py-3 pr-4 text-right tabular-nums ${
                  row.hallucinationRate != null && row.hallucinationRate > HALLUCINATION_LIMIT
                    ? "text-destructive"
                    : ""
                }`}
              >
                {fmt.pct(row.hallucinationRate)}
              </td>
              <td className="py-3 pr-4 text-right tabular-nums">{fmt.usd(row.costPerItemUsd)}</td>
              <td className="py-3 pr-4 text-right tabular-nums text-muted-foreground">
                {fmt.ms(row.p50Ms)}
              </td>
              <td className="py-3 pr-4 text-right tabular-nums text-muted-foreground">{row.n}</td>
              <td className="py-3 text-right tabular-nums text-muted-foreground">
                {fmt.date(row.createdAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Methodology({ board }: { board: BenchmarkBoard }) {
  const judgeIsContestant = board.steps.some((group) =>
    group.rows.some((row) => row.modelId === board.judgeModelId),
  );

  return (
    <section className="mt-16 border-t pt-10" id="methodology">
      <h2 className="text-lg font-semibold tracking-tight">Methodology</h2>

      <div className="mt-6 grid gap-8 md:grid-cols-2">
        <div className="space-y-3 text-sm leading-relaxed text-muted-foreground">
          <h3 className="text-sm font-medium text-foreground">How a number is produced</h3>
          <p>
            Each model runs the step over a frozen golden set of job postings — chosen for
            diversity across ATS vendor, remote/on-site, work-authorization signal and role
            family — with the candidate&apos;s confirmed facts snapshotted at selection time, so
            editing a profile later cannot silently change an old result.
          </p>
          <p>
            Each output is then checked mechanically (does every claim cite a fact the candidate
            actually has?) and graded by a fixed judge model on four axes scored 1–5:{" "}
            <strong className="font-medium text-foreground">grounding</strong>,{" "}
            <strong className="font-medium text-foreground">coverage</strong>,{" "}
            <strong className="font-medium text-foreground">specificity</strong> and a{" "}
            <strong className="font-medium text-foreground">keyword-stuffing penalty</strong>{" "}
            (5 = no stuffing). <em>Mean score</em> is the mean of those four axes over every
            scored item; the 95% interval is a 1,000-resample percentile bootstrap of that mean.
          </p>
          <p>
            <em>Hallucination</em> is pooled across the run: unsupported claims ÷ all citable
            claims, not the average of per-item rates. The CI gate fails a pull request above{" "}
            {(HALLUCINATION_LIMIT * 100).toFixed(0)}%.
          </p>
        </div>

        <div className="space-y-3 text-sm leading-relaxed text-muted-foreground">
          <h3 className="text-sm font-medium text-foreground">Judge and prompts</h3>
          <p>
            The judge is fixed at{" "}
            <span className="font-mono text-[13px] text-foreground">{board.judgeModelId}</span>{" "}
            for every model and every step. A benchmark varies the model under test; a grader
            that moved at the same time would measure nothing.
          </p>
          <p>
            Prompt bodies are hashed and stored, so every run points at the exact text that
            produced it.
          </p>
          <ul className="mt-2 space-y-1">
            {board.promptVersions.map((prompt) => (
              <li key={prompt.name} className="flex justify-between gap-4 font-mono text-[12px]">
                <span className="text-foreground">{prompt.name}</span>
                <span>
                  v{prompt.version} · {prompt.sha256.slice(0, 8)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="mt-10">
        <h3 className="text-sm font-medium">Caveats — read these before quoting a number</h3>
        <ul className="mt-3 space-y-2 text-sm leading-relaxed text-muted-foreground">
          <li>
            <strong className="font-medium text-foreground">The judge is an LLM.</strong> These
            scores measure agreement with{" "}
            <span className="font-mono text-[13px]">{board.judgeModelId}</span>&apos;s reading of
            a written rubric, not ground truth. Judge-vs-human weighted kappa is reported on the
            owner&apos;s eval page once enough items carry human grades.
          </li>
          {judgeIsContestant && (
            <li>
              <strong className="font-medium text-foreground">
                The judge is also a contestant.
              </strong>{" "}
              <span className="font-mono text-[13px]">{board.judgeModelId}</span> appears in the
              table below its own grading. Same-provider (and here, same-model) grading is a
              known source of self-preference bias; treat that row&apos;s margin over the others
              as the least trustworthy number on this page.
            </li>
          )}
          <li>
            <strong className="font-medium text-foreground">$/item is the contestant only.</strong>{" "}
            It excludes the judge fee and the cached posting analysis, which are identical for
            every model. It is the marginal cost of running that step on one posting, at the
            list prices in the repo, and it will drift as providers reprice.
          </li>
          <li>
            <strong className="font-medium text-foreground">n is small.</strong> Tens of items,
            not thousands. Two models whose intervals overlap are not distinguishable by this
            benchmark, however different their means look.
          </li>
          <li>
            <strong className="font-medium text-foreground">
              Only finished benchmark runs appear.
            </strong>{" "}
            The same table also collects continuous-integration runs of whichever model is
            currently shipping, and rows for runs still in progress. Neither is comparable with
            the others — no per-item cost, no interval, a different item count — so the
            scoreboard shows only runs made by the benchmark itself.
          </li>
          <li>
            <strong className="font-medium text-foreground">
              Models that scored nothing are not shown.
            </strong>{" "}
            A run where every item errored — an expired key, an empty credit balance, a
            rate-limited account — stays in the database but is excluded here: a row of dashes on
            a scoreboard reads as a result rather than as an outage.
          </li>
          <li>
            <strong className="font-medium text-foreground">Latency is not a lab figure.</strong>{" "}
            p50 is measured end to end from a laptop over the public internet, including the
            structured-output round trip, at whatever concurrency the run used.
          </li>
        </ul>
      </div>
    </section>
  );
}

export default async function BenchmarkPage() {
  const board = await getBoard();

  return (
    <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-16">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Model benchmark</h1>
        <p className="mt-3 max-w-2xl text-base leading-relaxed text-muted-foreground">
          ApplyOps runs four LLM steps over a job posting. Picking a model for each one is a
          measurement, not a preference — so every candidate model is run over the same frozen
          set of postings, graded by the same fixed judge on the same rubric, and the results are
          published here whether or not they flatter the model currently shipping.
        </p>
        <dl className="mt-8 flex flex-wrap gap-x-10 gap-y-4 border-y py-4 text-sm">
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Last updated</dt>
            <dd className="mt-0.5 font-medium tabular-nums">
              {board.lastUpdated ? fmt.date(board.lastUpdated) : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Judge</dt>
            <dd className="mt-0.5 font-mono text-[13px] font-medium">{board.judgeModelId}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Steps</dt>
            <dd className="mt-0.5 font-medium tabular-nums">{board.steps.length}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Results</dt>
            <dd className="mt-0.5 font-medium tabular-nums">
              {board.steps.reduce((sum, group) => sum + group.rows.length, 0)}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Raw data</dt>
            <dd className="mt-0.5 font-medium">
              <a className="underline underline-offset-4" href="/api/public/benchmark">
                JSON
              </a>
            </dd>
          </div>
        </dl>
      </header>

      {board.steps.length === 0 ? (
        <p className="mt-16 rounded-lg border border-dashed px-6 py-12 text-center text-sm text-muted-foreground">
          No benchmark runs have been recorded yet. Run{" "}
          <code className="font-mono text-[13px]">
            applyops bench --steps tailor,fit --models &lt;list&gt;
          </code>{" "}
          to populate this page.
        </p>
      ) : (
        <div className="mt-14 space-y-14">
          {board.steps.map((group) => {
            const meta = STEP_META[group.step];
            return (
              <section key={group.step} id={group.step}>
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <h2 className="text-xl font-semibold tracking-tight">
                    {meta?.title ?? group.step}
                  </h2>
                  <span className="font-mono text-[13px] text-muted-foreground">
                    {group.step}
                  </span>
                </div>
                {meta && (
                  <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                    {meta.what}
                  </p>
                )}
                <div className="mt-5">
                  <StepTable rows={group.rows} />
                </div>
                {meta && (
                  <p className="mt-3 text-xs text-muted-foreground">
                    Graded by <span className="font-mono">{meta.graded}</span>
                  </p>
                )}
              </section>
            );
          })}
        </div>
      )}

      <Methodology board={board} />

      <footer className="mt-16 border-t pt-6 text-xs text-muted-foreground">
        Scores come from the same <code className="font-mono">eval_runs</code> table the private
        eval dashboard reads. Page cached for {BENCHMARK_CACHE_SECONDS / 3600} hour.
      </footer>
    </div>
  );
}
