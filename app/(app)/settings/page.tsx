import Link from "next/link";
import { eq } from "drizzle-orm";
import { requireUser } from "@/src/auth/require";
import { getDb } from "@/src/db/client";
import { profiles } from "@/src/db/schema";
import { getPrefs, listFactRecords } from "@/src/profile/facts";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PrefsForm } from "../onboarding/prefs-form";
import { FactsEditor } from "./facts-editor";
import { BudgetEditor } from "./budget-editor";
import { ContactEditor } from "./contact-editor";
import { DeleteMyData } from "./delete-my-data";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Settings",
};

/**
 * Account overview, resume/facts editor, search prefs, budget (owner-only
 * edit), and "Delete my data" — plan Task 6 Step 4.
 */
export default async function SettingsPage() {
  const user = await requireUser();
  const db = getDb();

  const [[profile], facts, prefs] = await Promise.all([
    db
      .select({
        isOwner: profiles.isOwner,
        dailyBudgetUsd: profiles.dailyBudgetUsd,
        contact: profiles.contact,
      })
      .from(profiles)
      .where(eq(profiles.userId, user.id))
      .limit(1),
    listFactRecords(db, user.id),
    getPrefs(db, user.id),
  ]);

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your account, resume facts, preferences, and budget.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
          <CardDescription>{user.email}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3 text-sm">
          {profile?.isOwner && <Badge>Owner</Badge>}
          {profile?.isOwner ? (
            <BudgetEditor initialDailyBudgetUsd={profile.dailyBudgetUsd} />
          ) : (
            <span className="text-muted-foreground">
              Daily budget: ${profile?.dailyBudgetUsd ?? "1.00"}
            </span>
          )}
        </CardContent>
      </Card>

      {profile?.isOwner && (
        <Card>
          <CardHeader>
            <CardTitle>Invite allow-list</CardTitle>
            <CardDescription>
              Manage who can sign in with a magic link.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              size="sm"
              render={<Link href="/settings/admin" />}
            >
              Open admin
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Resume contact info</CardTitle>
          <CardDescription>
            Printed on the header of every generated resume PDF.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ContactEditor initialContact={profile?.contact ?? {}} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Resume facts</CardTitle>
          <CardDescription>
            The only claims a generated resume may cite.{" "}
            <Link href="/onboarding">Upload a resume</Link> to add more.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FactsEditor initialFacts={facts} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Job search preferences</CardTitle>
          <CardDescription>Used to rank and filter matches.</CardDescription>
        </CardHeader>
        <CardContent>
          <PrefsForm initialPrefs={prefs} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Danger zone</CardTitle>
          <CardDescription>
            Permanently delete your facts, preferences, applications, and resumes.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DeleteMyData />
        </CardContent>
      </Card>
    </div>
  );
}
