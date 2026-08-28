"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import type { OutcomeEventType } from "@/src/funnel/derive";

/**
 * The outcome buttons on each `/applications` row — plan Task 10 Step 2:
 * "Response · OA · Phone screen · Interview · Offer · Rejected · Ghosted ·
 * Withdrawn (each POSTs an event, updates status)". `applied`/`viewed`
 * aren't offered here: every row already exists because the application was
 * marked applied, so those two aren't actions a user takes from this list.
 */
const OUTCOME_BUTTONS: { type: OutcomeEventType; label: string }[] = [
  { type: "response", label: "Response" },
  { type: "oa", label: "OA" },
  { type: "phone_screen", label: "Phone screen" },
  { type: "interview", label: "Interview" },
  { type: "offer", label: "Offer" },
  { type: "rejected", label: "Rejected" },
  { type: "ghosted", label: "Ghosted" },
  { type: "withdrawn", label: "Withdrawn" },
];

async function parseErrorBody(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `Request failed (${res.status}).`;
  } catch {
    return `Request failed (${res.status}).`;
  }
}

export function OutcomeButtons({ applicationId }: { applicationId: string }) {
  const router = useRouter();
  const [pendingType, setPendingType] = useState<OutcomeEventType | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = pendingType !== null || deleting;

  async function logOutcome(type: OutcomeEventType) {
    setPendingType(type);
    setError(null);

    try {
      const res = await fetch(`/api/applications/${applicationId}/outcome`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type }),
      });
      if (!res.ok) {
        setError(await parseErrorBody(res));
        return;
      }
      // The row's status/last-event columns live in the parent Server
      // Component (`app/(app)/applications/page.tsx`); refresh re-fetches
      // it rather than duplicating that state here.
      router.refresh();
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setPendingType(null);
    }
  }

  /**
   * Removes the row outright (not an outcome event) — for applications
   * created by mistake, e.g. the wrong job or a test click. Withdrawing
   * alone already unhides the job on `/jobs` (`countsAsApplied`,
   * src/rank/candidates.ts); this is for actually deleting the record.
   */
  async function deleteApplication() {
    if (!window.confirm("Delete this application? This can't be undone.")) return;
    setDeleting(true);
    setError(null);

    try {
      const res = await fetch(`/api/applications/${applicationId}`, { method: "DELETE" });
      if (!res.ok) {
        setError(await parseErrorBody(res));
        return;
      }
      router.refresh();
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1">
        {OUTCOME_BUTTONS.map((button) => (
          <Button
            key={button.type}
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => logOutcome(button.type)}
          >
            {pendingType === button.type ? "…" : button.label}
          </Button>
        ))}
        <Button
          size="xs"
          variant="destructive"
          disabled={busy}
          onClick={deleteApplication}
        >
          {deleting ? "…" : "Delete application"}
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
