"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { HallucinationReport } from "./HallucinationReport";
import type { TailorOutput } from "@/src/pipeline/schemas";
import type { HallucinationReport as HallucinationReportData } from "@/src/pipeline/hallucination";
import { tailorBulletPath, type TailorUserEdits } from "@/src/pipeline/tailor-edits";

/** What `/jobs/[id]` loads server-side for the most recent `tailor` generation, if any. */
export interface TailorInitialGeneration {
  generationId: string;
  output: TailorOutput;
  hallucination: HallucinationReportData;
  /** The persisted `tailor_edit` overlay (`generations.user_edits`), if the user edited this run before. */
  userEdits: TailorUserEdits | null;
}

export interface TailorTabProps {
  jobId: string;
  initialGeneration: TailorInitialGeneration | null;
}

interface EditableBullet {
  text: string;
  /** The model's original text — an edit is anything that diverges from this. */
  originalText: string;
  factIds: string[];
  /** Pointer into the original output, e.g. `sections[0].bullets[1]` — matches `checkCitations()`'s `path`. */
  path: string;
  /** True when the mechanical hallucination check flagged this bullet. Permanently excluded from the PDF. */
  unsupported: boolean;
  /** Whether this bullet is sent to the PDF. Forced `false` and locked when `unsupported`. */
  included: boolean;
}

interface EditableSection {
  heading: string;
  bullets: EditableBullet[];
}

async function parseErrorBody(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `Request failed (${res.status}).`;
  } catch {
    return `Request failed (${res.status}).`;
  }
}

/**
 * Builds the editable state from a generation's raw output plus (optionally)
 * a previously-persisted `tailor_edit` overlay: edited text is substituted
 * in, and explicitly-excluded bullets start unchecked — same overlay
 * {@link applyTailorEdits} in `src/pipeline/tailor-edits.ts` reconstructs
 * for the PDF, just kept as a bullet-level `included` flag here instead of
 * actually dropping bullets, since the UI still needs to show and let the
 * user re-check them. A hallucination-blocked bullet is always unchecked
 * and locked, regardless of any stored overlay — that exclusion is derived
 * fresh from the *current* facts on every load, never stored.
 */
function buildEditableSections(
  output: TailorOutput,
  hallucination: HallucinationReportData,
  userEdits: TailorUserEdits | null,
): EditableSection[] {
  const unsupportedPaths = new Set(hallucination.unsupported.map((claim) => claim.path));
  const editedText = userEdits?.editedText ?? {};
  const excludedPaths = new Set(userEdits?.excludedPaths ?? []);
  return output.sections.map((section, s) => ({
    heading: section.heading,
    bullets: section.bullets.map((bullet, b) => {
      const path = tailorBulletPath(s, b);
      const unsupported = unsupportedPaths.has(path);
      return {
        text: editedText[path] ?? bullet.text,
        originalText: bullet.text,
        factIds: bullet.fact_ids,
        path,
        unsupported,
        included: unsupported ? false : !excludedPaths.has(path),
      };
    }),
  }));
}

/** What actually gets sent to `/pdf` and, for the summary/skills, would be shown on the PDF. */
function toTailorPayload(
  summary: string,
  skills: string[],
  sections: EditableSection[],
): TailorOutput {
  return {
    summary,
    skills,
    sections: sections
      .map((section) => ({
        heading: section.heading,
        bullets: section.bullets
          .filter((b) => b.included)
          .map((b) => ({ text: b.text, fact_ids: b.factIds })),
      }))
      .filter((section) => section.bullets.length > 0),
  };
}

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

export function TailorTab({ jobId, initialGeneration }: TailorTabProps) {
  const router = useRouter();

  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(initialGeneration?.output.summary ?? null);
  const [skills, setSkills] = useState<string[]>(initialGeneration?.output.skills ?? []);
  const [sections, setSections] = useState<EditableSection[]>(() =>
    initialGeneration
      ? buildEditableSections(
          initialGeneration.output,
          initialGeneration.hallucination,
          initialGeneration.userEdits,
        )
      : [],
  );
  const [hallucination, setHallucination] = useState<HallucinationReportData | null>(
    initialGeneration?.hallucination ?? null,
  );
  const [generationId, setGenerationId] = useState<string | null>(
    initialGeneration?.generationId ?? null,
  );

  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const [marking, setMarking] = useState(false);
  const [markError, setMarkError] = useState<string | null>(null);

  const [savingEdits, setSavingEdits] = useState(false);
  const [editsError, setEditsError] = useState<string | null>(null);
  /** The overlay body (stringified) of the last successfully-saved PATCH — lets `persistEdits` skip a no-op write. */
  const lastSavedEditsRef = useRef<string | null>(null);
  /** Chains every `persistEdits` PATCH after the previous one settles, so concurrent calls (a blur racing a toggle) hit the server strictly in the order they were issued instead of overlapping and letting an older snapshot land last. */
  const pendingEditsRef = useRef<Promise<unknown>>(Promise.resolve());

  const generated = summary !== null;

  async function handleGenerate() {
    setGenerating(true);
    setGenerateError(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}/tailor`, { method: "POST" });
      if (!res.ok) {
        setGenerateError(await parseErrorBody(res));
        return;
      }
      const body = (await res.json()) as {
        output: TailorOutput;
        generationId: string;
        hallucination: HallucinationReportData;
      };
      setSummary(body.output.summary);
      setSkills(body.output.skills);
      // A brand-new generation has no overlay yet.
      setSections(buildEditableSections(body.output, body.hallucination, null));
      setHallucination(body.hallucination);
      setGenerationId(body.generationId);
      // A brand-new generation has no overlay yet — don't let the previous
      // generation's last-saved snapshot suppress its first real save.
      lastSavedEditsRef.current = null;
      setDownloadError(null);
      setMarkError(null);
      setEditsError(null);
      // Refresh server props (plan point 2) — e.g. the page-level verdict
      // badge can depend on state derived from this job going forward, and
      // a later reload should see this run as the latest one immediately.
      router.refresh();
    } catch {
      setGenerateError("Couldn't reach the server. Try again.");
    } finally {
      setGenerating(false);
    }
  }

  /**
   * Persists the current diff against the original output as the
   * `tailor_edit` overlay (`PATCH .../tailor/edits`) — plan point 3.
   * Called on bullet blur/toggle, never per keystroke (spec, and the
   * route's own doc comment).
   *
   * Returns whether the overlay is now what the server has (`true` for an
   * actual save, or a skipped no-op; `false` on a rejected/failed PATCH) —
   * callers that made an optimistic UI change (e.g. the exclude checkbox)
   * use this to decide whether to keep it or roll it back.
   *
   * Two guards on top of the plain PATCH:
   * - No-op skip: if this exact overlay is what was last saved (e.g. the
   *   user tabbed through a bullet without editing it), skip the network
   *   round trip entirely rather than re-saving an unchanged snapshot.
   * - Ordering: writes are chained through `pendingEditsRef` so a blur and
   *   a toggle fired in quick succession hit the server in the order they
   *   were issued, instead of two overlapping PATCHes racing and letting
   *   whichever response lands second silently overwrite the newer edit
   *   with an older snapshot.
   */
  function persistEdits(nextSections: EditableSection[]): Promise<boolean> {
    if (!generationId) return Promise.resolve(true);
    const editedText: Record<string, string> = {};
    const excludedPaths: string[] = [];
    for (const section of nextSections) {
      for (const bullet of section.bullets) {
        if (bullet.text !== bullet.originalText) editedText[bullet.path] = bullet.text;
        // A hallucination-blocked bullet is never "excluded" by the user —
        // it's excluded by the current facts, re-derived on every load, so
        // storing it here would be redundant (and stale once facts change).
        if (!bullet.included && !bullet.unsupported) excludedPaths.push(bullet.path);
      }
    }
    const overlay = { editedText, excludedPaths };
    const serialized = JSON.stringify(overlay);
    if (serialized === lastSavedEditsRef.current) return Promise.resolve(true);

    const run = pendingEditsRef.current.then(async () => {
      setSavingEdits(true);
      setEditsError(null);
      try {
        const res = await fetch(`/api/jobs/${jobId}/tailor/edits`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ generationId, userEdits: overlay }),
        });
        if (!res.ok) {
          setEditsError(await parseErrorBody(res));
          return false;
        }
        lastSavedEditsRef.current = serialized;
        return true;
      } catch {
        setEditsError("Couldn't save your edits. Try again.");
        return false;
      } finally {
        setSavingEdits(false);
      }
    });
    // Keep the chain alive even after a failed save — a subsequent PATCH
    // should still queue behind this one rather than reset the chain.
    pendingEditsRef.current = run;
    return run;
  }

  function updateBulletText(sectionIdx: number, bulletIdx: number, text: string) {
    setSections((prev) =>
      prev.map((section, s) =>
        s !== sectionIdx
          ? section
          : {
              ...section,
              bullets: section.bullets.map((bullet, b) =>
                b !== bulletIdx ? bullet : { ...bullet, text },
              ),
            },
      ),
    );
  }

  function toggleBulletIncluded(sectionIdx: number, bulletIdx: number) {
    const previous = sections;
    const next = sections.map((section, s) =>
      s !== sectionIdx
        ? section
        : {
            ...section,
            bullets: section.bullets.map((bullet, b) => {
              if (b !== bulletIdx || bullet.unsupported) return bullet;
              return { ...bullet, included: !bullet.included };
            }),
          },
    );
    setSections(next);
    // Optimistic — snap back to `previous` if the server rejects the save
    // (e.g. the exclude-all guard), so the checkbox never lies about what
    // is actually persisted.
    void persistEdits(next).then((ok) => {
      if (!ok) setSections(previous);
    });
  }

  async function handleDownload() {
    if (summary === null) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      const payload = toTailorPayload(summary, skills, sections);
      const res = await fetch(`/api/jobs/${jobId}/pdf`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tailor: payload,
          tailorGenerationId: generationId ?? undefined,
        }),
      });
      if (!res.ok) {
        setDownloadError(await parseErrorBody(res));
        return;
      }
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition");
      const filename = disposition?.match(/filename="([^"]+)"/)?.[1] ?? "resume.pdf";

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      setDownloadError("Couldn't reach the server. Try again.");
    } finally {
      setDownloading(false);
    }
  }

  async function handleMarkApplied() {
    setMarking(true);
    setMarkError(null);
    try {
      const res = await fetch("/api/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, tailorGenerationId: generationId ?? undefined }),
      });
      if (!res.ok) {
        setMarkError(await parseErrorBody(res));
        return;
      }
      router.push("/applications");
      router.refresh();
    } catch {
      setMarkError("Couldn't reach the server. Try again.");
    } finally {
      setMarking(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {!generated && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">
            Generate a resume tailored to this posting from your confirmed facts.
          </p>
          <Button onClick={handleGenerate} disabled={generating} className="self-start">
            {generating ? "Generating…" : "Generate tailored resume"}
          </Button>
          {generateError && <p className="text-sm text-destructive">{generateError}</p>}
        </div>
      )}

      {generated && (
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-2">
            <Button variant="outline" size="sm" onClick={handleGenerate} disabled={generating}>
              {generating ? "Regenerating…" : "Regenerate"}
            </Button>
          </div>
          {generateError && <p className="text-sm text-destructive">{generateError}</p>}

          {hallucination && <HallucinationReport report={hallucination} />}

          {savingEdits && <p className="text-xs text-muted-foreground">Saving edits…</p>}
          {editsError && <p className="text-sm text-destructive">{editsError}</p>}

          <div className="flex flex-col gap-1.5">
            <h3 className="text-sm font-semibold">Summary</h3>
            <p className="text-sm text-muted-foreground">{summary}</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <h3 className="text-sm font-semibold">Skills</h3>
            <div className="flex flex-wrap gap-1.5">
              {skills.map((skill) => (
                <Badge key={skill} variant="secondary">
                  {skill}
                </Badge>
              ))}
            </div>
          </div>

          {sections.map((section, s) => (
            <div key={s} className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">{section.heading}</h3>
              <div className="flex flex-col gap-2">
                {section.bullets.map((bullet, b) => (
                  <div
                    key={bullet.path}
                    className={`flex flex-col gap-1.5 rounded-lg border p-2.5 ${
                      bullet.unsupported ? "border-destructive/40 bg-destructive/5" : "border-border"
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={bullet.included}
                        disabled={bullet.unsupported}
                        onChange={() => toggleBulletIncluded(s, b)}
                        className="mt-1.5"
                        aria-label={
                          bullet.unsupported
                            ? "Blocked — unsupported claim, excluded from the PDF"
                            : "Include this bullet in the PDF"
                        }
                      />
                      <Textarea
                        value={bullet.text}
                        onChange={(event) => updateBulletText(s, b, event.target.value)}
                        onBlur={() => void persistEdits(sections)}
                        rows={2}
                        className="flex-1"
                      />
                    </div>
                    <div className="flex items-center justify-between pl-6">
                      <FactChips ids={bullet.factIds} />
                      {bullet.unsupported && (
                        <span className="text-xs text-destructive">unsupported — blocked</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}

          <div className="flex flex-wrap items-center gap-3 border-t pt-3">
            <Button variant="outline" onClick={handleDownload} disabled={downloading}>
              {downloading ? "Preparing PDF…" : "Download PDF"}
            </Button>
            <Button onClick={handleMarkApplied} disabled={marking}>
              {marking ? "Marking…" : "Mark as applied"}
            </Button>
          </div>
          {downloadError && <p className="text-sm text-destructive">{downloadError}</p>}
          {markError && <p className="text-sm text-destructive">{markError}</p>}
        </div>
      )}
    </div>
  );
}
