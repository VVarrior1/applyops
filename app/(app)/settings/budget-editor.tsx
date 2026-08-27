"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

async function parseErrorBody(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `Request failed (${res.status}).`;
  } catch {
    return `Request failed (${res.status}).`;
  }
}

/** Owner-only editor for `profiles.daily_budget_usd` — plan Task 6 Step 4. */
export function BudgetEditor({ initialDailyBudgetUsd }: { initialDailyBudgetUsd: string }) {
  const [value, setValue] = useState(initialDailyBudgetUsd);
  const [saved, setSaved] = useState(initialDailyBudgetUsd);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) {
      setError("Enter a non-negative number.");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const res = await fetch("/api/profile/budget", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dailyBudgetUsd: amount }),
      });
      if (!res.ok) {
        setError(await parseErrorBody(res));
        setSaving(false);
        return;
      }
      const body = (await res.json()) as { dailyBudgetUsd: string };
      setSaved(body.dailyBudgetUsd);
      setValue(body.dailyBudgetUsd);
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">$</span>
        <Input
          type="number"
          min={0}
          step="0.01"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="w-28"
        />
        <span className="text-sm text-muted-foreground">/ day</span>
        <Button
          size="sm"
          variant="outline"
          disabled={saving || value === saved}
          onClick={handleSave}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
