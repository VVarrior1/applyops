"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { GuideOutput } from "@/src/pipeline/schemas";
import { FactChips } from "./FactChips";

const EFFORT_VARIANT = {
  days: "secondary",
  weeks: "default",
  months: "destructive",
} as const;

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">{children}</CardContent>
    </Card>
  );
}

function PlanPhase({
  label,
  items,
}: {
  label: string;
  items: GuideOutput["plan_30_60_90"]["days_30"];
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </h4>
      <div className="flex flex-col gap-2">
        {items.map((item, i) => (
          <div key={i} className="flex flex-col gap-1.5 rounded-lg border p-2.5">
            <p className="text-sm font-medium">{item.action}</p>
            <p className="text-sm text-muted-foreground">{item.why}</p>
            <FactChips ids={item.fact_ids} />
          </div>
        ))}
      </div>
    </div>
  );
}

export interface GuideViewProps {
  guide: GuideOutput | null;
  generatedAt: string | null;
  modelId: string | null;
  /** False until the user has confirmed at least one resume fact. */
  canGenerate: boolean;
  generating: boolean;
  error: string | null;
  onRegenerate: () => void;
}

/**
 * The left half of `/guide`: the generated outlook, section by section, with
 * the fact chips that make each claim about the candidate checkable.
 *
 * Purely presentational — generation state lives in `GuideWorkspace`, because
 * the chat's suggested questions are derived from the same guide and both
 * halves have to update together when "Regenerate" lands.
 */
export function GuideView({
  guide,
  generatedAt,
  modelId,
  canGenerate,
  generating,
  error,
  onRegenerate,
}: GuideViewProps) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Your outlook</h2>
          <p className="text-xs text-muted-foreground">
            {generatedAt
              ? `Generated ${new Date(generatedAt).toLocaleDateString()}${modelId ? ` · ${modelId}` : ""}`
              : "Written from your confirmed facts, your targets and your funnel."}
          </p>
        </div>
        <Button
          variant={guide ? "outline" : "default"}
          size="sm"
          onClick={onRegenerate}
          disabled={generating || !canGenerate}
        >
          {generating ? "Writing…" : guide ? "Regenerate" : "Generate guide"}
        </Button>
      </div>

      {!canGenerate && (
        <p className="text-sm text-muted-foreground">
          Confirm some resume facts in Settings first — a guide written with
          nothing to go on would just be horoscope.
        </p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}

      {!guide && canGenerate && !generating && (
        <p className="text-sm text-muted-foreground">
          No guide yet. Generating one costs a fraction of a cent and takes
          about twenty seconds.
        </p>
      )}

      {guide && (
        <div className="flex flex-col gap-4">
          <Section title="Where you stand">
            <p className="text-sm leading-relaxed">{guide.where_you_stand}</p>
          </Section>

          {guide.strengths.length > 0 && (
            <Section
              title="Strengths"
              description="Each one traced back to a fact on your profile."
            >
              {guide.strengths.map((strength, i) => (
                <div key={i} className="flex flex-col gap-1.5 rounded-lg border p-2.5">
                  <p className="text-sm">{strength.text}</p>
                  <FactChips ids={strength.fact_ids} />
                </div>
              ))}
            </Section>
          )}

          <Section title="Realistic targets">
            <div className="flex flex-col gap-1.5">
              <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Roles
              </h4>
              <div className="flex flex-wrap gap-1.5">
                {guide.realistic_targets.role_types.map((role) => (
                  <Badge key={role} variant="secondary">
                    {role}
                  </Badge>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Company types
              </h4>
              <div className="flex flex-wrap gap-1.5">
                {guide.realistic_targets.company_types.map((company) => (
                  <Badge key={company} variant="outline">
                    {company}
                  </Badge>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Markets
              </h4>
              {guide.realistic_targets.geographies.map((geo, i) => (
                <div key={i} className="flex flex-col gap-1 rounded-lg border p-2.5">
                  <p className="text-sm font-medium">{geo.region}</p>
                  <p className="text-sm text-muted-foreground">{geo.why}</p>
                  <p className="text-sm text-muted-foreground">
                    <span className="font-medium text-foreground">
                      Work authorization:{" "}
                    </span>
                    {geo.notes_for_canadians}
                  </p>
                </div>
              ))}
            </div>
          </Section>

          {guide.gaps.length > 0 && (
            <Section title="Gaps" description="Most damaging first.">
              {guide.gaps.map((gap, i) => (
                <div key={i} className="flex flex-col gap-1.5 rounded-lg border p-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={EFFORT_VARIANT[gap.effort]}>{gap.effort}</Badge>
                    <span className="text-sm font-medium">{gap.gap}</span>
                  </div>
                  <p className="text-sm text-muted-foreground">{gap.why_it_matters}</p>
                  <p className="text-sm">{gap.how_to_close}</p>
                </div>
              ))}
            </Section>
          )}

          <Section title="30 / 60 / 90 day plan">
            <PlanPhase label="Days 1–30" items={guide.plan_30_60_90.days_30} />
            <PlanPhase label="Days 31–60" items={guide.plan_30_60_90.days_60} />
            <PlanPhase label="Days 61–90" items={guide.plan_30_60_90.days_90} />
          </Section>

          {guide.interview_prep_focus.length > 0 && (
            <Section title="Interview prep focus" description="In study order.">
              {guide.interview_prep_focus.map((topic, i) => (
                <div key={i} className="flex flex-col gap-1 rounded-lg border p-2.5">
                  <p className="text-sm font-medium">{topic.topic}</p>
                  <p className="text-sm text-muted-foreground">{topic.why}</p>
                  <p className="text-sm text-muted-foreground">{topic.resources_hint}</p>
                </div>
              ))}
            </Section>
          )}

          {guide.positioning_tips.length > 0 && (
            <Section title="Positioning">
              <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm">
                {guide.positioning_tips.map((tip, i) => (
                  <li key={i}>{tip}</li>
                ))}
              </ul>
            </Section>
          )}

          <Section title="Application cadence">
            <p className="text-sm">
              <span className="font-medium">
                {guide.application_cadence.per_week} applications a week.
              </span>{" "}
              <span className="text-muted-foreground">
                {guide.application_cadence.rationale}
              </span>
            </p>
          </Section>

          {guide.market_notes.length > 0 && (
            <Section title="Market notes">
              <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm">
                {guide.market_notes.map((note, i) => (
                  <li key={i}>{note}</li>
                ))}
              </ul>
            </Section>
          )}

          {guide.caveats.length > 0 && (
            <Section title="Caveats" description="What this advice is guessing at.">
              <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-muted-foreground">
                {guide.caveats.map((caveat, i) => (
                  <li key={i}>{caveat}</li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}
