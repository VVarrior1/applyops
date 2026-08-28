"use client";

/**
 * The owner's one manual task (spec §7): grade the golden set by hand so the
 * judge model can be checked against a human with weighted kappa.
 *
 * Everything on this screen exists to make one judgement fast and repeatable:
 * the tailored output up top with each bullet's citations rendered inline (and
 * uncited bullets flagged before you have to spot them), the posting and the
 * frozen facts one click away, and the rubric level you are choosing spelled
 * out under each slider so "4" means the same thing on item 3 and item 33.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { JUDGE_AXES, type JudgeAxis } from "@/src/pipeline/schemas";
import type { GradeItemPayload } from "@/app/api/evals/grade/route";

type Grades = Record<JudgeAxis, number>;

const DEFAULT_GRADES: Grades = {
  grounding: 3,
  coverage: 3,
  specificity: 3,
  stuffing_penalty: 3,
};

/** Condensed from `src/pipeline/prompts/judge.v1.md` — the judge's own rubric. */
const RUBRIC: Record<JudgeAxis, { label: string; question: string; levels: [string, string, string, string, string] }> = {
  grounding: {
    label: "Grounding",
    question: "Is every claim supported by a cited fact?",
    levels: [
      "An invented employer, project, credential or date.",
      "Multiple unsupported claims, or a metric that appears in no fact.",
      "One bullet cites a label that doesn't support it, or an uncited summary claim.",
      "Fully traceable, but one bullet stretches a fact's wording.",
      "Every bullet cites a listed label and claims nothing beyond it.",
    ],
  },
  coverage: {
    label: "Coverage",
    question: "Are the posting's must-haves addressed where the facts allow?",
    levels: [
      "Reads as if tailored to a different job.",
      "Generic; most must-haves unaddressed.",
      "Two supportable must-haves missing, or ordering ignores the posting.",
      "One supportable must-have is buried or missing.",
      "Every must-have the facts can support is addressed, high in the document.",
    ],
  },
  specificity: {
    label: "Specificity",
    question: "Concrete and quantified, or duties and adjectives?",
    levels: [
      "Pure filler — “responsible for”, “worked on various projects”.",
      "Mostly duties; almost no numbers though the facts have them.",
      "Half the bullets are duties rather than outcomes.",
      "Mostly concrete, one vague bullet.",
      "Every bullet names a deliverable and a real outcome.",
    ],
  },
  stuffing_penalty: {
    label: "Stuffing penalty",
    question: "5 = no keyword stuffing; 1 = egregious stuffing.",
    levels: [
      "Keyword salad, or unsupported terms inserted for the ATS.",
      "Several bullets end in technology lists; prose distorted to fit terms.",
      "A keyword list appended to a bullet, or a term repeated without cause.",
      "One bullet lists one technology more than it needed.",
      "Keywords appear only where they are true and read naturally.",
    ],
  },
};

async function parseError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `Request failed (${res.status}).`;
  } catch {
    return `Request failed (${res.status}).`;
  }
}

interface ApiResponse {
  progress: { graded: number; total: number };
  item: GradeItemPayload | null;
}

function RubricSlider({
  axis,
  value,
  onChange,
}: {
  axis: JudgeAxis;
  value: number;
  onChange: (next: number) => void;
}) {
  const rubric = RUBRIC[axis];
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-4">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="text-sm font-medium">{rubric.label}</div>
          <div className="text-xs text-muted-foreground">{rubric.question}</div>
        </div>
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
      </div>
      <Slider
        min={1}
        max={5}
        step={1}
        value={[value]}
        onValueChange={(next) => onChange(Array.isArray(next) ? next[0] : next)}
        aria-label={rubric.label}
      />
      <div className="flex justify-between text-[10px] text-muted-foreground">
        {[1, 2, 3, 4, 5].map((n) => (
          <span key={n}>{n}</span>
        ))}
      </div>
      <p className="min-h-[2.5rem] text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{value}:</span>{" "}
        {rubric.levels[value - 1]}
      </p>
    </div>
  );
}

function BulletList({
  item,
}: {
  item: GradeItemPayload;
}) {
  const sample = item.sample;
  if (!sample) return null;
  const unsupported = new Set(sample.unsupportedPaths);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Summary
        </div>
        <p className="mt-1 text-sm">{sample.output.summary}</p>
      </div>

      <div>
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Skills
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {sample.output.skills.map((skill) => (
            <Badge key={skill} variant="secondary">
              {skill}
            </Badge>
          ))}
        </div>
      </div>

      {/* Every block of bullets a tailor output can hold, in the order the PDF
          renders them: employers, then projects, then any extra sections. A
          pre-1.2.0 generation has only `sections`, so it grades exactly as it
          always did. `path` must match `checkCitations()`'s pointer for the
          unsupported highlighting to line up. */}
      {[
        ...(sample.output.experience ?? []).map((entry, e) => ({
          key: `experience-${e}`,
          heading: [entry.organization, entry.role].filter(Boolean).join(" — "),
          bullets: entry.bullets,
          pathFor: (b: number) => `experience[${e}].bullets[${b}]`,
        })),
        ...(sample.output.projects ?? []).map((project, p) => ({
          key: `project-${p}`,
          heading: project.name,
          bullets: project.bullets,
          pathFor: (b: number) => `projects[${p}].bullets[${b}]`,
        })),
        ...sample.output.sections.map((section, s) => ({
          key: `section-${section.heading}-${s}`,
          heading: section.heading,
          bullets: section.bullets,
          pathFor: (b: number) => `sections[${s}].bullets[${b}]`,
        })),
      ].map((block) => (
        <div key={block.key}>
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {block.heading}
          </div>
          <ul className="mt-1.5 flex flex-col gap-2">
            {block.bullets.map((bullet, b) => {
              const path = block.pathFor(b);
              const bad = unsupported.has(path);
              return (
                <li
                  key={path}
                  className={`rounded-md border px-3 py-2 text-sm ${
                    bad ? "border-destructive/50 bg-destructive/5" : "border-transparent bg-muted/40"
                  }`}
                >
                  <span>{bullet.text}</span>
                  <span className="ml-2 inline-flex flex-wrap gap-1 align-middle">
                    {bullet.fact_ids.length === 0 ? (
                      <Badge variant="destructive">no citation</Badge>
                    ) : (
                      bullet.fact_ids.map((id) => (
                        <Badge key={id} variant={bad ? "destructive" : "outline"}>
                          {id}
                        </Badge>
                      ))
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function Grader({
  initialProgress,
}: {
  initialProgress: { graded: number; total: number };
}) {
  const [progress, setProgress] = useState(initialProgress);
  const [item, setItem] = useState<GradeItemPayload | null>(null);
  const [grades, setGrades] = useState<Grades>(DEFAULT_GRADES);
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const adopt = useCallback((body: ApiResponse) => {
    setProgress(body.progress);
    setItem(body.item);
    const existing = body.item?.humanGrades;
    setGrades(
      existing
        ? {
            grounding: existing.grounding,
            coverage: existing.coverage,
            specificity: existing.specificity,
            stuffing_penalty: existing.stuffing_penalty,
          }
        : DEFAULT_GRADES,
    );
    setNotes(body.item?.notes ?? "");
  }, []);

  const load = useCallback(
    async (query = "") => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/evals/grade${query}`);
        if (!res.ok) {
          setError(await parseError(res));
          return;
        }
        adopt((await res.json()) as ApiResponse);
      } catch {
        setError("Couldn't reach the server.");
      } finally {
        setLoading(false);
      }
    },
    [adopt],
  );

  // Both effects below fetch on mount / on item change and flip a spinner flag
  // as they start. `react-hooks/set-state-in-effect` objects to that first
  // synchronous setState, but this is the "subscribe to an external system"
  // case the rule exempts in spirit: the request is the external system, and
  // the flag has to go up before the await or the buttons stay live during it.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Generate the sample the first time an item is seen, then cache it forever
  // (spec §7) — a human grade only means anything next to the exact output the
  // human read, and the judge is later compared against that same artifact.
  //
  // Which request is in flight is tracked in a ref, never in state that the
  // effect also depends on: an effect that depends on the `generating` flag it
  // sets tears itself down mid-request (cleanup runs, the response lands on a
  // cancelled closure) and the screen hangs on every uncached item. The ref is
  // keyed by item id, so a re-render — or React's development double-invoke —
  // costs nothing while a genuinely new item still gets its own request.
  const requestedFor = useRef<string | null>(null);

  const generateSample = useCallback(async (target: GradeItemPayload) => {
    if (requestedFor.current === target.itemId) return;
    requestedFor.current = target.itemId;
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch("/api/evals/grade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "generate", itemId: target.itemId }),
      });
      // A newer item took over while this was in flight: drop the answer and
      // leave the spinner to whoever owns it now.
      if (requestedFor.current !== target.itemId) return;
      if (!res.ok) {
        // Clear the key so the owner can retry this item without a reload.
        requestedFor.current = null;
        setError(await parseError(res));
        return;
      }
      const body = (await res.json()) as ApiResponse;
      setProgress(body.progress);
      setItem(body.item);
    } catch {
      if (requestedFor.current !== target.itemId) return;
      requestedFor.current = null;
      setError("Couldn't generate a sample for this item.");
    } finally {
      if (requestedFor.current === target.itemId || requestedFor.current === null) {
        setGenerating(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!item || item.sample) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void generateSample(item);
  }, [item, generateSample]);

  async function saveAndNext() {
    if (!item) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/evals/grade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save",
          itemId: item.itemId,
          grades,
          notes: notes.trim() || null,
        }),
      });
      if (!res.ok) {
        setError(await parseError(res));
        return;
      }
      adopt((await res.json()) as ApiResponse);
    } catch {
      setError("Couldn't save this grading.");
    } finally {
      setSaving(false);
    }
  }

  const pct = progress.total === 0 ? 0 : (progress.graded / progress.total) * 100;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">Grade the golden set</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Score the tailored output against the posting and the frozen facts. These
              grades are what the judge model is measured against (weighted κ).
            </p>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-sm font-medium tabular-nums">
              {progress.graded}/{progress.total} graded
            </div>
            {item ? (
              <div className="text-xs text-muted-foreground tabular-nums">
                item {item.position} of {progress.total}
              </div>
            ) : null}
          </div>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
        </div>
      </header>

      {error ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading the next item…</p>
      ) : !item ? (
        <div className="rounded-lg border p-6">
          <p className="text-sm">
            {progress.total === 0
              ? "The golden set is empty — run `npm run cli -- golden select --n 40` first."
              : "Everything is graded. Run an eval and the κ column on /evals will fill in."}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          <section className="flex flex-col gap-1 rounded-lg border p-4">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <h2 className="text-base font-semibold">{item.title}</h2>
              <span className="text-sm text-muted-foreground">{item.company}</span>
              {item.location ? (
                <span className="text-xs text-muted-foreground">· {item.location}</span>
              ) : null}
              {item.remote ? <Badge variant="secondary">remote</Badge> : null}
            </div>

            <details className="mt-2 group">
              <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
                Job posting ({item.description.length.toLocaleString()} chars)
              </summary>
              <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-3 text-xs leading-relaxed">
                {item.description || "(this posting has no description text)"}
              </pre>
            </details>

            <details className="group">
              <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
                Frozen facts ({item.facts.length})
              </summary>
              <ul className="mt-2 max-h-96 overflow-auto rounded-md bg-muted/40 p-3 text-xs leading-relaxed">
                {item.facts.map((fact) => (
                  <li key={fact.label} className="py-0.5">
                    <span className="font-mono font-medium">{fact.label}</span>{" "}
                    <span className="text-muted-foreground">({fact.category})</span> {fact.text}
                  </li>
                ))}
              </ul>
            </details>
          </section>

          <section className="rounded-lg border p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">Tailored output</h3>
              {item.sample ? (
                <span className="text-xs text-muted-foreground">
                  {item.sample.modelId} ·{" "}
                  {item.sample.unsupportedPaths.length === 0
                    ? `${item.sample.totalClaims} claims, all cited`
                    : `${item.sample.unsupportedPaths.length}/${item.sample.totalClaims} claims uncited`}
                </span>
              ) : null}
            </div>
            {generating ? (
              <p className="text-sm text-muted-foreground">
                Generating this item&apos;s sample with the default model… (once per item,
                then cached)
              </p>
            ) : item.sample ? (
              <BulletList item={item} />
            ) : (
              <div className="flex flex-col items-start gap-2">
                <p className="text-sm text-muted-foreground">
                  No sample yet for this item.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void generateSample(item)}
                >
                  Generate sample
                </Button>
              </div>
            )}
          </section>

          <section className="grid gap-3 sm:grid-cols-2">
            {JUDGE_AXES.map((axis) => (
              <RubricSlider
                key={axis}
                axis={axis}
                value={grades[axis]}
                onChange={(next) => setGrades((prev) => ({ ...prev, [axis]: next }))}
              />
            ))}
          </section>

          <section className="flex flex-col gap-2">
            <label htmlFor="grader-notes" className="text-sm font-medium">
              Notes
            </label>
            <Textarea
              id="grader-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="What would raise the lowest axis by a point?"
              rows={3}
            />
          </section>

          <div className="flex items-center gap-3">
            <Button onClick={saveAndNext} disabled={saving || generating || !item.sample}>
              {saving ? "Saving…" : "Save & next"}
            </Button>
            <Button
              variant="ghost"
              disabled={saving || generating}
              onClick={() => void load(`?after=${encodeURIComponent(item.itemId)}`)}
            >
              Skip
            </Button>
            {item.humanGrades ? (
              <span className="text-xs text-muted-foreground">
                already graded by {item.humanGrades.grader} on{" "}
                {new Date(item.humanGrades.graded_at).toLocaleDateString()}
              </span>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
