import { notFound } from "next/navigation";
import { and, eq, inArray } from "drizzle-orm";
import { format } from "date-fns";
import { requireUser } from "@/src/auth/require";
import { getDb } from "@/src/db/client";
import { companies, jobs, jobScores } from "@/src/db/schema";
import { DEFAULT_MODEL_BY_STEP } from "@/src/llm/defaults";
import type { FitOutput } from "@/src/pipeline/schemas";
import { fitRankerVersion, KEYWORD_RANKER_VERSION } from "@/src/rank/rank";
import { FitTab } from "@/components/jobs/FitTab";
import { PostingTab } from "@/components/jobs/PostingTab";
import { SuggestionsTab } from "@/components/jobs/SuggestionsTab";
import { TailorTab } from "@/components/jobs/TailorTab";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * `/jobs/[id]` — plan Task 8 Step 3: tabs Posting · Fit · Tailor ·
 * Suggestions (spec §9's "Apply" step is the "Mark as applied" button
 * inside Task 9's Tailor tab, not a separate tab component — see that
 * task's notes on this file).
 *
 * Deliberately does *not* run `analyze` itself — this is a GET render, and
 * a paid LLM call plus a DB write has no business happening on a plain page
 * load: a `next/link` prefetch from `/jobs`, a refresh, or a crawler could
 * all spend the viewing user's daily budget without them clicking anything.
 * `initialAnalyzed` just reflects whatever `jobs.analysis` already is. The
 * Fit tab (`FitTab`) is what actually runs `analyze` (via
 * `POST /api/jobs/[id]/analyze`) then `fit`, from its own explicit "Score
 * this job" button — Task 9's Tailor/Suggestions tabs should call the same
 * `/analyze` route themselves rather than rely on a side effect here.
 */
export default async function JobDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id: jobId } = await params;
  const db = getDb();

  const [jobRow] = await db
    .select({
      id: jobs.id,
      title: jobs.title,
      companyName: companies.name,
      location: jobs.location,
      remote: jobs.remote,
      description: jobs.description,
      url: jobs.url,
      analysis: jobs.analysis,
      postedAt: jobs.postedAt,
      scrapedAt: jobs.scrapedAt,
    })
    .from(jobs)
    .leftJoin(companies, eq(jobs.companyId, companies.id))
    .where(eq(jobs.id, jobId))
    .limit(1);

  if (!jobRow) {
    notFound();
  }

  const analysis = jobRow.analysis;

  const fitVersion = fitRankerVersion(DEFAULT_MODEL_BY_STEP.fit);
  const scoreRows = await db
    .select({
      rankerVersion: jobScores.rankerVersion,
      score: jobScores.score,
      matched: jobScores.matched,
      gaps: jobScores.gaps,
      rationale: jobScores.rationale,
    })
    .from(jobScores)
    .where(
      and(
        eq(jobScores.jobId, jobRow.id),
        eq(jobScores.userId, user.id),
        inArray(jobScores.rankerVersion, [fitVersion, KEYWORD_RANKER_VERSION]),
      ),
    );

  const fitRow = scoreRows.find((row) => row.rankerVersion === fitVersion);
  const keywordRow = scoreRows.find((row) => row.rankerVersion === KEYWORD_RANKER_VERSION);
  const initialFit: FitOutput | null = fitRow
    ? {
        score: fitRow.score,
        matched: fitRow.matched ?? [],
        gaps: fitRow.gaps ?? [],
        rationale: fitRow.rationale ?? "",
      }
    : null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">{jobRow.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{jobRow.companyName ?? "Unknown company"}</p>
      </div>

      <Tabs defaultValue="posting">
        <TabsList>
          <TabsTrigger value="posting">Posting</TabsTrigger>
          <TabsTrigger value="fit">Fit</TabsTrigger>
          <TabsTrigger value="tailor">Tailor</TabsTrigger>
          <TabsTrigger value="suggestions">Suggestions</TabsTrigger>
        </TabsList>

        <TabsContent value="posting">
          <PostingTab
            title={jobRow.title}
            companyName={jobRow.companyName}
            location={jobRow.location}
            remote={jobRow.remote}
            url={jobRow.url}
            description={jobRow.description}
            postedAt={jobRow.postedAt ? format(jobRow.postedAt, "MMM d, yyyy") : null}
          />
        </TabsContent>

        <TabsContent value="fit">
          <FitTab
            jobId={jobRow.id}
            initialAnalyzed={analysis != null}
            initialFit={initialFit}
            initialKeywordScore={keywordRow?.score ?? null}
          />
        </TabsContent>

        <TabsContent value="tailor">
          <TailorTab jobId={jobRow.id} />
        </TabsContent>

        <TabsContent value="suggestions">
          <SuggestionsTab jobId={jobRow.id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
