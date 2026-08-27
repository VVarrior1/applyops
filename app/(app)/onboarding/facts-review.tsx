"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FACT_CATEGORIES, type ExtractFactsOutput } from "@/src/pipeline/schemas";
import type { ProfileFactRecord } from "@/src/profile/facts";
import { groupFacts } from "@/src/profile/group-facts";

interface DraftFact {
  id: number;
  category: string;
  text: string;
  evidenceSpan: string;
  keep: boolean;
}

/** Categories collapsed to a chip summary by default — see plan Task 17. */
const COLLAPSED_BY_DEFAULT = new Set(["skill"]);
const COLLAPSED_PREVIEW_COUNT = 8;

async function parseErrorBody(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `Request failed (${res.status}).`;
  } catch {
    return `Request failed (${res.status}).`;
  }
}

export function FactsReview({
  proposedFacts,
  onSaved,
}: {
  proposedFacts: ExtractFactsOutput["facts"];
  onSaved: (saved: ProfileFactRecord[]) => void;
}) {
  const [drafts, setDrafts] = useState<DraftFact[]>(
    proposedFacts.map((fact, i) => ({
      id: i,
      category: fact.category,
      text: fact.text,
      evidenceSpan: fact.evidence_span,
      keep: true,
    })),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());

  function update(id: number, patch: Partial<DraftFact>) {
    setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  }

  function toggleExpanded(category: string) {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  }

  async function handleConfirm() {
    const kept = drafts.filter((d) => d.keep && d.text.trim().length > 0);
    if (kept.length === 0) {
      setError("Keep at least one fact, or go back and upload a different resume.");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const res = await fetch("/api/profile/facts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          facts: kept.map((d) => ({
            category: d.category,
            text: d.text.trim(),
            source: "resume_upload",
          })),
        }),
      });

      if (!res.ok) {
        setError(await parseErrorBody(res));
        setSaving(false);
        return;
      }

      const body = (await res.json()) as { facts: ProfileFactRecord[] };
      onSaved(body.facts);
    } catch {
      setError("Couldn't reach the server. Try again.");
      setSaving(false);
    }
  }

  const keptCount = drafts.filter((d) => d.keep).length;
  const groups = groupFacts(drafts);

  function renderDraftCard(draft: DraftFact) {
    return (
      <div
        key={draft.id}
        className={`flex flex-col gap-2 rounded-lg border p-3 ${draft.keep ? "" : "opacity-50"}`}
      >
        <div className="flex items-start justify-between gap-2">
          <Select
            value={draft.category}
            onValueChange={(value) => update(draft.id, { category: value as string })}
          >
            <SelectTrigger size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FACT_CATEGORIES.map((category) => (
                <SelectItem key={category} value={category}>
                  {category}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant={draft.keep ? "ghost" : "outline"}
            size="sm"
            onClick={() => update(draft.id, { keep: !draft.keep })}
          >
            {draft.keep ? "Remove" : "Keep"}
          </Button>
        </div>
        <Textarea
          value={draft.text}
          disabled={!draft.keep}
          onChange={(event) => update(draft.id, { text: event.target.value })}
          rows={2}
        />
        {draft.evidenceSpan && (
          <p className="text-xs text-muted-foreground italic">
            From resume: &ldquo;{draft.evidenceSpan}&rdquo;
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        We found {drafts.length} fact{drafts.length === 1 ? "" : "s"} in your resume, grouped
        below. Edit the wording, fix the category, or remove anything that doesn&apos;t belong —
        only what you keep gets cited in generated resumes.
      </p>

      <div className="flex flex-col gap-5">
        {groups.map((group) => {
          const collapsible = COLLAPSED_BY_DEFAULT.has(group.category);
          const expanded = expandedCategories.has(group.category);
          const showFull = !collapsible || expanded;

          return (
            <div key={group.category} className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold">{group.label}</h3>
                <Badge variant="secondary">{group.count}</Badge>
              </div>

              {showFull ? (
                <div className="flex flex-col gap-3">
                  {group.facts.map((draft) => renderDraftCard(draft))}
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <div className="flex flex-wrap gap-1.5">
                    {group.facts.slice(0, COLLAPSED_PREVIEW_COUNT).map((draft) => (
                      <Badge
                        key={draft.id}
                        variant="outline"
                        className={draft.keep ? undefined : "opacity-50 line-through"}
                      >
                        {draft.text || "(empty)"}
                      </Badge>
                    ))}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="self-start"
                    onClick={() => toggleExpanded(group.category)}
                  >
                    Show all {group.count}
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Button type="button" onClick={handleConfirm} disabled={saving} className="self-start">
        {saving ? "Saving…" : `Confirm ${keptCount} fact${keptCount === 1 ? "" : "s"} and continue`}
      </Button>
    </div>
  );
}
