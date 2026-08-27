"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface Contact {
  name?: string;
  email?: string;
  phone?: string;
  links?: string[];
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
 * `profiles.contact` editor — the resume header (name/email/phone/links)
 * `renderResumePdf()` puts on every generated PDF (plan Task 9: "Contact
 * fields ... come from `profiles` ... edited in Settings").
 */
export function ContactEditor({ initialContact }: { initialContact: Contact }) {
  const [name, setName] = useState(initialContact.name ?? "");
  const [email, setEmail] = useState(initialContact.email ?? "");
  const [phone, setPhone] = useState(initialContact.phone ?? "");
  const [linksText, setLinksText] = useState((initialContact.links ?? []).join("\n"));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const links = linksText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

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
