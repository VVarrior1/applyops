"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { HallucinationReport } from "./HallucinationReport";
import type { TailorOutput } from "@/src/pipeline/schemas";
import type { HallucinationReport as HallucinationReportData } from "@/src/pipeline/hallucination";

interface EditableBullet {
  text: string;
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

function toEditableSections(
  output: TailorOutput,
  hallucination: HallucinationReportData,
): EditableSection[] {
  const unsupportedPaths = new Set(hallucination.unsupported.map((claim) => claim.path));
  return output.sections.map((section, s) => ({
    heading: section.heading,
    bullets: section.bullets.map((bullet, b) => {
      const path = `sections[${s}].bullets[${b}]`;
      const unsupported = unsupportedPaths.has(path);
      return {
        text: bullet.text,
        factIds: bullet.fact_ids,
        path,
        unsupported,
        included: !unsupported,
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

export function TailorTab({ jobId }: { jobId: string }) {
  const router = useRouter();

  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [skills, setSkills] = useState<string[]>([]);
  const [sections, setSections] = useState<EditableSection[]>([]);
  const [hallucination, setHallucination] = useState<HallucinationReportData | null>(null);
  const [generationId, setGenerationId] = useState<string | null>(null);

  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const [marking, setMarking] = useState(false);
  const [markError, setMarkError] = useState<string | null>(null);

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
      setSections(toEditableSections(body.output, body.hallucination));
      setHallucination(body.hallucination);
      setGenerationId(body.generationId);
      setDownloadError(null);
      setMarkError(null);
    } catch {
      setGenerateError("Couldn't reach the server. Try again.");
    } finally {
      setGenerating(false);
    }
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
    setSections((prev) =>
      prev.map((section, s) =>
        s !== sectionIdx
          ? section
          : {
              ...section,
              bullets: section.bullets.map((bullet, b) => {
                if (b !== bulletIdx || bullet.unsupported) return bullet;
                return { ...bullet, included: !bullet.included };
              }),
            },
      ),
    );
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
