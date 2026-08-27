import Link from "next/link";
import { eq } from "drizzle-orm";
import { requireUser } from "@/src/auth/require";
import { getDb } from "@/src/db/client";
import { profiles } from "@/src/db/schema";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/**
 * Account overview. Task 6 extends this page with the facts editor, search
 * prefs, budget editing, and "Delete my data" — this task only needs the
 * account identity + (for the owner) a link into the allow-list admin page.
 */
export default async function SettingsPage() {
  const user = await requireUser();
  const db = getDb();

  const [profile] = await db
    .select({ isOwner: profiles.isOwner, dailyBudgetUsd: profiles.dailyBudgetUsd })
    .from(profiles)
    .where(eq(profiles.userId, user.id))
    .limit(1);

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your account, budget, and preferences.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
          <CardDescription>{user.email}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3 text-sm">
          {profile?.isOwner && <Badge>Owner</Badge>}
          <span className="text-muted-foreground">
            Daily budget: ${profile?.dailyBudgetUsd ?? "1.00"}
          </span>
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
    </div>
  );
}
