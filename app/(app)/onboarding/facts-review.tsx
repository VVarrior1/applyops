"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
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

interface DraftFact {
  id: number;
  category: string;
  text: string;
  evidenceSpan: string;
  keep: boolean;
}

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

  function update(id: number, patch: Partial<DraftFact>) {
    setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
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

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        We found {drafts.length} fact{drafts.length === 1 ? "" : "s"} in your resume. Edit the
        wording, fix the category, or remove anything that doesn&apos;t belong — only what you
        keep gets cited in generated resumes.
      </p>

      <div className="flex flex-col gap-3">
        {drafts.map((draft) => (
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
        ))}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Button type="button" onClick={handleConfirm} disabled={saving} className="self-start">
        {saving ? "Saving…" : `Confirm ${keptCount} fact${keptCount === 1 ? "" : "s"} and continue`}
      </Button>
    </div>
  );
}
