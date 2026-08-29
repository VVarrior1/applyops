"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";

type ManualApplicationStatus = "applied" | "responded" | "interviewing" | "offer" | "rejected";

const STATUS_OPTIONS: { value: ManualApplicationStatus; label: string }[] = [
  { value: "applied", label: "Applied" },
  { value: "responded", label: "Responded" },
  { value: "interviewing", label: "Interviewing" },
  { value: "offer", label: "Offer" },
  { value: "rejected", label: "Rejected" },
];

interface FormState {
  url: string;
  company: string;
  title: string;
  location: string;
  appliedAt: string;
  status: ManualApplicationStatus;
  notes: string;
}

function today(): string {
  return format(new Date(), "yyyy-MM-dd");
}

function emptyForm(): FormState {
  return { url: "", company: "", title: "", location: "", appliedAt: today(), status: "applied", notes: "" };
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
 * "Add application" dialog on `/applications` — spec: "let a user track
 * applications they made OUTSIDE the app". Posts to
 * `POST /api/applications/manual`; "Fetch details" prefills whatever is
 * still blank from `POST /api/applications/manual/fetch` (best-effort
 * scrape — see `fetchPostingDetails`, src/funnel/manual-application.ts).
 * Rendered twice on the page (header button + empty-state button), each
 * its own independent Dialog instance.
 */
export function AddApplicationDialog({ variant = "default" }: { variant?: "default" | "outline" }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [fetching, setFetching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function reset() {
    setForm(emptyForm());
    setError(null);
  }

  async function handleFetchDetails() {
    if (!form.url.trim()) {
      setError("Enter a URL first.");
      return;
    }
    setFetching(true);
    setError(null);
    try {
      const res = await fetch("/api/applications/manual/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: form.url.trim() }),
      });
      if (!res.ok) {
        setError(await parseErrorBody(res));
        return;
      }
      const details = (await res.json()) as {
        title?: string | null;
        company?: string | null;
        location?: string | null;
        error?: string;
      };
      if (details.error) {
        setError(`Couldn't fetch details: ${details.error}`);
        return;
      }
      setForm((f) => ({
        ...f,
        title: f.title || details.title || f.title,
        company: f.company || details.company || f.company,
        location: f.location || details.location || f.location,
      }));
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setFetching(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.url.trim()) {
      setError("A job URL is required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/applications/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: form.url.trim(),
          company: form.company.trim() || undefined,
          title: form.title.trim() || undefined,
          location: form.location.trim() || undefined,
          appliedAt: form.appliedAt || undefined,
          status: form.status,
          notes: form.notes.trim() || undefined,
        }),
      });
      if (!res.ok) {
        setError(await parseErrorBody(res));
        return;
      }
      reset();
      setOpen(false);
      router.refresh();
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger render={<Button variant={variant} />}>Add application</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Add application</DialogTitle>
            <DialogDescription>
              Track an application you made outside ApplyOps — paste the posting URL and we&apos;ll
              try to fill in the rest.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="manual-app-url">URL</Label>
            <div className="flex gap-1.5">
              <Input
                id="manual-app-url"
                type="url"
                required
                placeholder="https://boards.greenhouse.io/acme/jobs/12345"
                value={form.url}
                onChange={(e) => set("url", e.target.value)}
              />
              <Button
                type="button"
                variant="outline"
                disabled={fetching || !form.url.trim()}
                onClick={handleFetchDetails}
              >
                {fetching ? "Fetching…" : "Fetch details"}
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="manual-app-company">Company</Label>
            <Input
              id="manual-app-company"
              value={form.company}
              onChange={(e) => set("company", e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="manual-app-title">Title</Label>
            <Input id="manual-app-title" value={form.title} onChange={(e) => set("title", e.target.value)} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="manual-app-location">Location</Label>
            <Input
              id="manual-app-location"
              value={form.location}
              onChange={(e) => set("location", e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="manual-app-applied-at">Applied on</Label>
              <Input
                id="manual-app-applied-at"
                type="date"
                value={form.appliedAt}
                onChange={(e) => set("appliedAt", e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="manual-app-status">Status</Label>
              <Select value={form.status} onValueChange={(v) => set("status", v as ManualApplicationStatus)}>
                <SelectTrigger id="manual-app-status" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="manual-app-notes">Notes</Label>
            <Textarea
              id="manual-app-notes"
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
              placeholder="Optional"
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Adding…" : "Add application"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
