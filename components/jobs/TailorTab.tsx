"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { TriangleAlertIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { HallucinationReport } from "./HallucinationReport";
import type { TailorOutput } from "@/src/pipeline/schemas";
import type { HallucinationReport as HallucinationReportData } from "@/src/pipeline/hallucination";
import {
  experienceBulletPath,
  projectBulletPath,
  tailorBulletPath,
  type TailorUserEdits,
} from "@/src/pipeline/tailor-edits";
import type { ContactProblem } from "@/src/profile/contact";

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

/**
 * One editable block on the tab. Since prompt 1.2.0 a tailor output's bullets
 * live in three places — `sections[i]`, `experience[i]` (an employer/role,
 * with its own header line) and `projects[i]` — and all three are editable,
 * so the tab works in terms of "groups" rather than sections alone. `kind` +
 * `index` is what maps a group back onto the original output when the payload
 * is rebuilt for the PDF, which is also where the entry headers (organization,
 * role, dates, stack) come from: they are never retyped here, so they cannot
 * be edited into something the facts do not support.
 */
type GroupKind = "section" | "experience" | "project";

interface EditableGroup {
  kind: GroupKind;
  /** Index within `output.sections` / `output.experience` / `output.projects`. */
  index: number;
  /** The block label: a section heading, or "Experience"/"Projects". */
  label: string;
  /** Employer or project name — empty for a plain section. */
  title: string;
  /** Role · location · dates, or the project's tech stack. */
  subtitle: string;
  bullets: EditableBullet[];
}

/** `June 2025 – Present`, `June 2025`, `Present`, or `""`. */
function dateRange(start?: string, end?: string): string {
  const from = (start ?? "").trim();
  const to = (end ?? "").trim();
  if (from && to) return `${from} – ${to}`;
  return from || to;
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
function buildEditableGroups(
  output: TailorOutput,
  hallucination: HallucinationReportData,
  userEdits: TailorUserEdits | null,
): EditableGroup[] {
  const unsupportedPaths = new Set(hallucination.unsupported.map((claim) => claim.path));
  const editedText = userEdits?.editedText ?? {};
  const excludedPaths = new Set(userEdits?.excludedPaths ?? []);

  function bulletsOf(
    bullets: TailorOutput["sections"][number]["bullets"],
    pathFor: (bulletIndex: number) => string,
  ): EditableBullet[] {
    return bullets.map((bullet, b) => {
      const path = pathFor(b);
      const unsupported = unsupportedPaths.has(path);
      return {
        text: editedText[path] ?? bullet.text,
        originalText: bullet.text,
        factIds: bullet.fact_ids,
        path,
        unsupported,
        included: unsupported ? false : !excludedPaths.has(path),
      };
    });
  }

  // Same order the PDF renders in: experience, projects, then whatever extra
  // sections are left — so what the user edits reads top-to-bottom like the
  // document they are about to download.
  return [
    ...(output.experience ?? []).map((entry, e) => ({
      kind: "experience" as const,
      index: e,
      label: "Experience",
      title: entry.organization,
      subtitle: [entry.role, entry.location, dateRange(entry.start, entry.end)]
        .map((part) => (part ?? "").trim())
        .filter((part) => part.length > 0)
        .join(" · "),
      bullets: bulletsOf(entry.bullets, (b) => experienceBulletPath(e, b)),
    })),
    ...(output.projects ?? []).map((project, p) => ({
      kind: "project" as const,
      index: p,
      label: "Projects",
      title: project.name,
      subtitle: (project.technologies ?? "").trim(),
      bullets: bulletsOf(project.bullets, (b) => projectBulletPath(p, b)),
    })),
    ...output.sections.map((section, s) => ({
      kind: "section" as const,
      index: s,
      label: section.heading,
      title: "",
      subtitle: "",
      bullets: bulletsOf(section.bullets, (b) => tailorBulletPath(s, b)),
    })),
  ];
}

/**
 * What actually gets sent to `/pdf`.
 *
 * Rebuilt from the *original* generation (`source`) so every entry header —
 * employer, role, location, dates, project name and stack — survives the round
 * trip untouched; only bullet text and inclusion come from the edited groups.
 * `experience`/`projects` stay `undefined` when the generation never had them
 * (a pre-1.2.0 run), which is what makes the renderer fall back to that run's
 * loose section bullets instead of printing an empty Experience block.
 */
function toTailorPayload(
  source: TailorOutput,
  summary: string,
  skills: string[],
  groups: EditableGroup[],
): TailorOutput {
  const included = (kind: GroupKind, index: number) =>
    groups
      .find((group) => group.kind === kind && group.index === index)
      ?.bullets.filter((b) => b.included)
      .map((b) => ({ text: b.text, fact_ids: b.factIds })) ?? [];

  const payload: TailorOutput = {
    summary,
    skills,
    sections: source.sections
      .map((section, s) => ({ heading: section.heading, bullets: included("section", s) }))
      .filter((section) => section.bullets.length > 0),
  };

  if (source.experience) {
    payload.experience = source.experience
      .map((entry, e) => ({ ...entry, bullets: included("experience", e) }))
      .filter((entry) => entry.bullets.length > 0);
  }
  if (source.projects) {
    payload.projects = source.projects
      .map((project, p) => ({ ...project, bullets: included("project", p) }))
      .filter((project) => project.bullets.length > 0);
  }

  return payload;
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
  /**
   * The generation exactly as the model returned it. Never edited — it is the
   * source of the entry headers (employer, role, dates, stack) the PDF payload
   * is rebuilt from, and of the shape (`experience`/`projects` present or not)
   * a pre-1.2.0 run has to keep.
   */
  const [source, setSource] = useState<TailorOutput | null>(
    initialGeneration?.output ?? null,
  );
  const [groups, setGroups] = useState<EditableGroup[]>(() =>
    initialGeneration
      ? buildEditableGroups(
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

  /**
   * `checkContact()`'s verdict on `profiles.contact`, from
   * `GET /api/profile/contact`. `null` while it is still loading — the
   * Download button is only disabled once we actually know, so a slow
   * request never silently blocks a user with a perfectly good profile.
   *
   * `POST /api/jobs/[id]/pdf` refuses (422) on exactly these problems. This
   * fetch exists so the user is told *before* spending a generation, and can
   * be sent straight to the one page that fixes it: QA hit this as "Download
   * PDF hands over a resume headed ApplyOps Test Resume /
   * candidate@example.com" with nothing in the UI hinting anything was wrong.
   */
  const [contactProblems, setContactProblems] = useState<ContactProblem[] | null>(null);

  const [marking, setMarking] = useState(false);
  const [markError, setMarkError] = useState<string | null>(null);

  const [savingEdits, setSavingEdits] = useState(false);
  const [editsError, setEditsError] = useState<string | null>(null);
  /** The overlay body (stringified) of the last successfully-saved PATCH — lets `persistEdits` skip a no-op write. */
  const lastSavedEditsRef = useRef<string | null>(null);
  /** Chains every `persistEdits` PATCH after the previous one settles, so concurrent calls (a blur racing a toggle) hit the server strictly in the order they were issued instead of overlapping and letting an older snapshot land last. */
  const pendingEditsRef = useRef<Promise<unknown>>(Promise.resolve());

  const generated = summary !== null;
  const contactBlocked = contactProblems !== null && contactProblems.length > 0;

  const refreshContact = useCallback(async () => {
    try {
      const res = await fetch("/api/profile/contact");
      if (!res.ok) return;
      const body = (await res.json()) as { problems?: ContactProblem[] };
      setContactProblems(body.problems ?? []);
    } catch {
      // Offline/transient: leave the verdict unknown rather than inventing a
      // block. The server-side 422 is the real gate; this is only the warning.
    }
  }, []);

  useEffect(() => {
    // Deliberately kicked off through the microtask queue rather than called
    // straight from the effect body: `refreshContact` sets state, and doing
    // that synchronously inside an effect is the cascading-render pattern
    // `react-hooks/set-state-in-effect` (correctly) rejects. The state only
    // ever lands after the fetch resolves.
    const timer = setTimeout(() => void refreshContact(), 0);
    // Settings opens in another tab often enough that re-checking on focus is
    // the difference between "fixed it, banner still says no" and it clearing
    // itself the moment the user comes back.
    const onFocus = () => void refreshContact();
    window.addEventListener("focus", onFocus);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshContact]);

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
      setSource(body.output);
      // A brand-new generation has no overlay yet.
      setGroups(buildEditableGroups(body.output, body.hallucination, null));
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
  function persistEdits(nextGroups: EditableGroup[]): Promise<boolean> {
    if (!generationId) return Promise.resolve(true);
    const editedText: Record<string, string> = {};
    const excludedPaths: string[] = [];
    for (const group of nextGroups) {
      for (const bullet of group.bullets) {
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

  function updateBulletText(groupIdx: number, bulletIdx: number, text: string) {
    setGroups((prev) =>
      prev.map((group, g) =>
        g !== groupIdx
          ? group
          : {
              ...group,
              bullets: group.bullets.map((bullet, b) =>
                b !== bulletIdx ? bullet : { ...bullet, text },
              ),
            },
      ),
    );
  }

  function toggleBulletIncluded(groupIdx: number, bulletIdx: number) {
    const previous = groups;
    const next = groups.map((group, g) =>
      g !== groupIdx
        ? group
        : {
            ...group,
            bullets: group.bullets.map((bullet, b) => {
              if (b !== bulletIdx || bullet.unsupported) return bullet;
              return { ...bullet, included: !bullet.included };
            }),
          },
    );
    setGroups(next);
    // Optimistic — snap back to `previous` if the server rejects the save
    // (e.g. the exclude-all guard), so the checkbox never lies about what
    // is actually persisted.
    void persistEdits(next).then((ok) => {
      if (!ok) setGroups(previous);
    });
  }

  async function handleDownload() {
    if (summary === null || source === null || contactBlocked) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      const payload = toTailorPayload(source, summary, skills, groups);
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
        // 422 is the contact gate — re-read the profile so the banner appears
        // (or updates) rather than leaving the user with a bare error line.
        if (res.status === 422) void refreshContact();
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
      {contactBlocked && (
        <div
          role="alert"
          data-testid="contact-blocked"
          className="flex gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
        >
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
          <div className="flex flex-col gap-1">
            <p className="font-medium text-destructive">
              Resume downloads are blocked — your contact info isn&apos;t real yet.
            </p>
            <ul className="list-disc pl-4 text-muted-foreground">
              {contactProblems?.map((problem, i) => (
                <li key={`${problem.field}-${i}`}>{problem.message}</li>
              ))}
            </ul>
            <p>
              <Link href="/settings" className="font-medium underline underline-offset-2">
                Fix it in Settings → Resume contact info
              </Link>
            </p>
          </div>
        </div>
      )}

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

          {groups.map((group, g) => (
            <div key={`${group.kind}-${group.index}`} className="flex flex-col gap-2">
              {/* The block label is printed once per run of same-labelled
                  groups, so five Experience entries read as one Experience
                  block with five employers under it, not five headings. */}
              {(g === 0 || groups[g - 1].label !== group.label) && (
                <h3 className="text-sm font-semibold">{group.label}</h3>
              )}
              {(group.title || group.subtitle) && (
                <div className="flex flex-wrap items-baseline gap-x-2">
                  {group.title && <span className="text-sm font-medium">{group.title}</span>}
                  {group.subtitle && (
                    <span className="text-xs text-muted-foreground">{group.subtitle}</span>
                  )}
                </div>
              )}
              <div className="flex flex-col gap-2">
                {group.bullets.map((bullet, b) => (
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
                        onChange={() => toggleBulletIncluded(g, b)}
                        className="mt-1.5"
                        aria-label={
                          bullet.unsupported
                            ? "Blocked — unsupported claim, excluded from the PDF"
                            : "Include this bullet in the PDF"
                        }
                      />
                      <Textarea
                        value={bullet.text}
                        onChange={(event) => updateBulletText(g, b, event.target.value)}
                        onBlur={() => void persistEdits(groups)}
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
            <Button
              variant="outline"
              onClick={handleDownload}
              disabled={downloading || contactBlocked}
              title={
                contactBlocked
                  ? "Add real contact info in Settings before downloading a resume."
                  : undefined
              }
            >
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
