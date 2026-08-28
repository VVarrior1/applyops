"use client";

import { useMemo, useState } from "react";
import { CircleCheckIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { checkContact, type ProfileContact } from "@/src/profile/contact";

/** Kept as the component's own prop name; `ProfileContact` is the shared shape. */
export type Contact = ProfileContact;

async function parseErrorBody(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `Request failed (${res.status}).`;
  } catch {
    return `Request failed (${res.status}).`;
  }
}

/**
 * `profiles.contact` editor — the resume header (name/email/phone/links)
 * `renderResumePdf()` puts on every generated PDF (plan Task 9: "Contact
 * fields ... come from `profiles` ... edited in Settings").
 *
 * Runs `checkContact()` (`src/profile/contact.ts`) live against what is
 * currently typed, because this card is the *only* place a user can fix the
 * thing that blocks a PDF download. QA found the owner's row holding seed
 * data ("ApplyOps Test Resume", `candidate@example.com`, `555-0100`) with
 * this editor showing it as if it were fine; the same function now refuses
 * the download in `POST /api/jobs/[id]/pdf`, so the warning here and the
 * block there are guaranteed to agree.
 */
export function ContactEditor({ initialContact }: { initialContact: Contact }) {
  const [name, setName] = useState(initialContact.name ?? "");
  const [email, setEmail] = useState(initialContact.email ?? "");
  const [phone, setPhone] = useState(initialContact.phone ?? "");
  const [linksText, setLinksText] = useState((initialContact.links ?? []).join("\n"));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const links = useMemo(
    () =>
      linksText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    [linksText],
  );

  const problems = useMemo(
    () => checkContact({ name, email, phone, links }),
    [name, email, phone, links],
  );

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/profile/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, phone, links }),
      });
      if (!res.ok) {
        setError(await parseErrorBody(res));
        return;
      }
      setSavedAt(Date.now());
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {problems.length > 0 ? (
        <div
          role="alert"
          data-testid="contact-problems"
          className="flex gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-2.5 text-sm"
        >
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
          <div className="flex flex-col gap-1">
            <p className="font-medium text-destructive">
              This contact block isn&apos;t ready to send to an employer.
            </p>
            <ul className="list-disc pl-4 text-muted-foreground">
              {problems.map((problem, i) => (
                <li key={`${problem.field}-${i}`}>{problem.message}</li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              Resume downloads stay blocked until these are fixed.
            </p>
          </div>
        </div>
      ) : (
        <p
          data-testid="contact-ok"
          className="flex items-center gap-1.5 text-sm text-muted-foreground"
        >
          <CircleCheckIcon className="size-4 shrink-0" aria-hidden />
          Ready to print on a resume.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="contact-name">Name</Label>
          <Input id="contact-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="contact-email">Email</Label>
          <Input
            id="contact-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="contact-phone">Phone</Label>
          <Input id="contact-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor="contact-links">Links (one per line — GitHub, LinkedIn, portfolio)</Label>
          <textarea
            id="contact-links"
            value={linksText}
            onChange={(e) => setLinksText(e.target.value)}
            rows={3}
            className="rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={handleSave} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
        {savedAt && <span className="text-xs text-muted-foreground">Saved.</span>}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
