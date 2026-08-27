"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { ExtractFactsOutput } from "@/src/pipeline/schemas";
import type { ProfileFactRecord, SearchPrefsRow } from "@/src/profile/facts";
import { UploadStep } from "./upload-step";
import { FactsReview } from "./facts-review";
import { PrefsForm } from "./prefs-form";

type Step = "upload" | "review" | "prefs" | "done";

const STEP_LABELS: Record<Step, string> = {
  upload: "1. Upload resume",
  review: "2. Review facts",
  prefs: "3. Set preferences",
  done: "Done",
};

export function OnboardingFlow({ initialPrefs }: { initialPrefs: SearchPrefsRow | null }) {
  const [step, setStep] = useState<Step>("upload");
  const [proposedFacts, setProposedFacts] = useState<ExtractFactsOutput["facts"]>([]);
  const [savedCount, setSavedCount] = useState(0);

  function handleExtracted(facts: ExtractFactsOutput["facts"]) {
    setProposedFacts(facts);
    setStep("review");
  }

  function handleFactsSaved(saved: ProfileFactRecord[]) {
    setSavedCount(saved.length);
    setStep("prefs");
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex gap-4 text-xs font-medium text-muted-foreground">
        {(Object.keys(STEP_LABELS) as Step[])
          .filter((s) => s !== "done")
          .map((s) => (
            <span key={s} className={s === step ? "text-foreground" : undefined}>
              {STEP_LABELS[s]}
            </span>
          ))}
      </div>

      {step === "upload" && <UploadStep onExtracted={handleExtracted} />}

      {step === "review" && (
        <FactsReview proposedFacts={proposedFacts} onSaved={handleFactsSaved} />
      )}

      {step === "prefs" && (
        <>
          <p className="text-sm text-muted-foreground">
            Saved {savedCount} fact{savedCount === 1 ? "" : "s"}. Now tell us what you&apos;re
            looking for — this tunes which jobs you get matched against.
          </p>
          <PrefsForm
            initialPrefs={initialPrefs}
            submitLabel="Finish onboarding"
            onSaved={() => setStep("done")}
          />
        </>
      )}

      {step === "done" && (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm">
            You&apos;re set up. Facts and preferences can be edited anytime in Settings.
          </p>
          <Button render={<Link href="/settings" />}>Go to Settings</Button>
        </div>
      )}
    </div>
  );
}
