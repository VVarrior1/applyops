import { requireUser } from "@/src/auth/require";
import { getDb } from "@/src/db/client";
import { getConfirmedFacts, getPrefs } from "@/src/profile/facts";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { OnboardingFlow } from "./onboarding-flow";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Onboarding",
};

/**
 * `/onboarding` — spec §9: "upload PDF → facts review → prefs". Runs the
 * same three steps whether this is a first-time sign-up or a returning user
 * re-running it to add facts from an updated resume; everything it produces
 * can also be edited afterward in Settings.
 */
export default async function OnboardingPage() {
  const user = await requireUser();
  const db = getDb();

  const [facts, prefs] = await Promise.all([
    getConfirmedFacts(db, user.id),
    getPrefs(db, user.id),
  ]);

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Onboarding</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Upload a resume, confirm what we pulled from it, then set your search preferences.
        </p>
        {facts.length > 0 && (
          <p className="mt-2 text-sm text-muted-foreground">
            You already have {facts.length} confirmed fact{facts.length === 1 ? "" : "s"}
            {prefs ? " and saved preferences" : ""}. Running this again adds to them — everything
            can also be managed in Settings.
          </p>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Resume → facts → preferences</CardTitle>
          <CardDescription>Takes about two minutes.</CardDescription>
        </CardHeader>
        <CardContent>
          <OnboardingFlow initialPrefs={prefs} />
        </CardContent>
      </Card>
    </div>
  );
}
