import Link from "next/link";
import { getDb } from "@/src/db/client";
import { loadPublicResults, type BenchmarkHeadline, type EvalScorecard, type GateStatus } from "@/src/funnel/public-results";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { FunnelChart } from "@/components/funnel/FunnelChart";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Results",
};

export const revalidate = 300;

function pct(n: number | null): string {
  return n == null ? "—" : `${(n * 100).toFixed(1)}%`;
}

function score(n: number | null): string {
  return n == null ? "—" : n.toFixed(2);
}

function usd(n: number | null): string {
  if (n == null) return "—";
  return `$${n.toFixed(n < 0.01 ? 4 : 2)}`;
}

function ms(n: number | null): string {
  return n == null ? "—" : `${Math.round(n)} ms`;
}

function date(iso: string): string {
  return iso.slice(0, 16).replace("T", " ") + " UTC";
}

function EvalScorecardCard({ card }: { card: EvalScorecard | null }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Latest baseline eval</CardTitle>
        <CardDescription>
          Tailor step, scored against the frozen golden set (spec §7).
        </CardDescription>
      </CardHeader>
      <CardContent>
        {card ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted-foreground">Mean score</dt>
              <dd className="font-medium tabular-nums">{score(card.meanScore)} / 5</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Hallucination rate</dt>
              <dd className="font-medium tabular-nums">{pct(card.hallucinationRate)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Judge–human κ</dt>
              <dd className="font-medium tabular-nums">
                {card.kappa == null ? (
                  <span className="text-muted-foreground">pending</span>
                ) : (
                  card.kappa.toFixed(2)
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Items</dt>
              <dd className="font-medium tabular-nums">{card.itemCount ?? "—"}</dd>
            </div>
            <div className="col-span-2 sm:col-span-4">
              <dt className="text-xs text-muted-foreground">Model · run date</dt>
              <dd className="font-mono text-xs text-muted-foreground">
                {card.modelId} · {date(card.createdAt)}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">
            No baseline run recorded yet — run <code className="rounded bg-muted px-1 py-0.5 text-xs">npm run eval -- --step tailor --items 40 --baseline</code>.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function GateStatusCard({ gate }: { gate: GateStatus | null }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Latest gate run
          {gate && (
            <Badge variant={gate.status === "pass" ? "default" : "destructive"}>
              {gate.status === "pass" ? "PASS" : "FAIL"}
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          The most recent candidate run checked against the &gt;2% hallucination /
          CI95-below-zero regression gate (spec §7).
        </CardDescription>
      </CardHeader>
      <CardContent>
        {gate ? (
          <div className="flex flex-col gap-2 text-sm">
            <div className="font-mono text-xs text-muted-foreground">
              {gate.modelId} · {gate.itemCount ?? "?"} items · {date(gate.createdAt)}
            </div>
            {gate.reasons.length > 0 && (
              <ul className="list-inside list-disc text-xs text-destructive">
                {gate.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No non-baseline eval run recorded yet.</p>
        )}
      </CardContent>
    </Card>
  );
}

function BenchmarkHeadlineCard({ headline }: { headline: BenchmarkHeadline | null }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Current default model</CardTitle>
        <CardDescription>
          The {headline?.step ?? "tailor"} step&apos;s configured default (
          <code className="rounded bg-muted px-1 py-0.5 text-xs">src/llm/defaults.ts</code>) — full
          multi-model comparison on{" "}
          <Link href="/benchmark" className="underline underline-offset-2">
            /benchmark
          </Link>
          .
        </CardDescription>
      </CardHeader>
      <CardContent>
        {headline ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted-foreground">Mean score</dt>
              <dd className="font-medium tabular-nums">{score(headline.meanScore)} / 5</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Hallucination</dt>
              <dd className="font-medium tabular-nums">{pct(headline.hallucinationRate)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">$ / item</dt>
              <dd className="font-medium tabular-nums">{usd(headline.costPerItemUsd)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">p50 latency</dt>
              <dd className="font-medium tabular-nums">{ms(headline.p50Ms)}</dd>
            </div>
            <div className="col-span-2 sm:col-span-4">
              <dt className="text-xs text-muted-foreground">Model · n · run date</dt>
              <dd className="font-mono text-xs text-muted-foreground">
                {headline.modelId} · n={headline.n ?? "—"} · {date(headline.createdAt)}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">No eval run recorded yet for the current default model.</p>
        )}
      </CardContent>
    </Card>
  );
}

function stageLabel(stage: string): string {
  switch (stage) {
    case "applied":
      return "Applied";
    case "responded":
      return "Responded";
    case "interviewing":
      return "Interviewing";
    case "offer":
      return "Offer";
    case "rejected":
      return "Rejected";
    case "ghosted":
      return "Ghosted";
    case "withdrawn":
      return "Withdrawn";
    default:
      return stage;
  }
}

export default async function PublicResultsPage() {
  // `DATABASE_URL` is absent during CI's env-stripped `npm run build` (see
  // .github/workflows/ci.yml) and this route is statically prerendered (ISR,
  // `revalidate` above) — `getDb()` throws synchronously without a URL, which
  // would fail the whole build. Skip the query when there's no database to
  // reach; the page already renders a correct "No results yet" empty state
  // for `data === null`, and the 300s revalidate refills it from the first
  // real request once deployed with real env vars.
  const data = process.env.DATABASE_URL ? await loadPublicResults(getDb()) : null;

  return (
    <div className="flex flex-1 flex-col">
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-10 px-4 py-10">
        <div>
          <h1 className="text-2xl font-semibold">Results</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            The owner&apos;s real application funnel and eval numbers, published as they are —
            successes and failures alike. Company names are redacted to{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">Company #n</code>; job titles are
            shown only as a coarse role family.
          </p>
        </div>

        {!data ? (
          <p className="rounded-lg border p-6 text-sm text-muted-foreground">
            No results yet — check back once the owner has signed in and started applying.
          </p>
        ) : (
          <>
            <section className="grid gap-4 sm:grid-cols-2">
              <EvalScorecardCard card={data.evalScorecard} />
              <GateStatusCard gate={data.gate} />
            </section>

            <section>
              <BenchmarkHeadlineCard headline={data.benchmarkHeadline} />
            </section>

            <section className="flex flex-col gap-4">
              <div>
                <h2 className="text-lg font-semibold">Funnel — by week</h2>
                <p className="text-sm text-muted-foreground">
                  Response = any of response / OA / phone screen / interview / offer. CIs are Wilson
                  95% intervals.
                </p>
              </div>
              <FunnelChart rows={data.funnelByWeek} />
            </section>

            <section className="flex flex-col gap-4">
              <h2 className="text-lg font-semibold">Funnel — by prompt version</h2>
              {data.funnelByPromptVersion.length === 0 ? (
                <p className="text-sm text-muted-foreground">No applications yet.</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Prompt version</TableHead>
                        <TableHead className="text-right">Applied</TableHead>
                        <TableHead className="text-right">Responded</TableHead>
                        <TableHead className="text-right">Interviewing</TableHead>
                        <TableHead className="text-right">Offers</TableHead>
                        <TableHead className="text-right">Response rate</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.funnelByPromptVersion.map((row) => {
                        const [lo, hi] = row.responseRateCi95;
                        return (
                          <TableRow key={row.key}>
                            <TableCell className="font-mono text-xs">{row.key}</TableCell>
                            <TableCell className="text-right">{row.applied}</TableCell>
                            <TableCell className="text-right">{row.responded}</TableCell>
                            <TableCell className="text-right">{row.interviewing}</TableCell>
                            <TableCell className="text-right">{row.offers}</TableCell>
                            <TableCell className="text-right text-muted-foreground">
                              {pct(row.responseRate)}{" "}
                              <span className="text-xs">
                                (CI {Math.round(lo * 100)}–{Math.round(hi * 100)}%)
                              </span>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </section>

            <section className="flex flex-col gap-4">
              <div>
                <h2 className="text-lg font-semibold">Recent applications</h2>
                <p className="text-sm text-muted-foreground">Redacted — no employer names, no exact titles.</p>
              </div>
              {data.recentApplications.length === 0 ? (
                <p className="text-sm text-muted-foreground">No applications yet.</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Company</TableHead>
                        <TableHead>Role family</TableHead>
                        <TableHead>Stage</TableHead>
                        <TableHead className="text-right">Applied</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.recentApplications.map((row, i) => (
                        <TableRow key={i}>
                          <TableCell className="font-medium">{row.company}</TableCell>
                          <TableCell>{row.roleFamily}</TableCell>
                          <TableCell>
                            <Badge variant="secondary">{stageLabel(row.stage)}</Badge>
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground">{row.appliedOn}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </section>

            <p className="text-xs text-muted-foreground">
              Generated {date(data.generatedAt)}. Numbers are derived live from the database on every
              request (cached up to 5 minutes) — nothing here is hand-picked.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
