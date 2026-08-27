import { desc } from "drizzle-orm";
import { requireOwner } from "@/src/auth/require";
import { getDb } from "@/src/db/client";
import { allowedEmails } from "@/src/db/schema";
import { AllowedEmailsManager } from "./allowed-emails-manager";

export default async function AdminPage() {
  await requireOwner();

  const db = getDb();
  const rows = await db
    .select({
      email: allowedEmails.email,
      addedBy: allowedEmails.addedBy,
      createdAt: allowedEmails.createdAt,
    })
    .from(allowedEmails)
    .orderBy(desc(allowedEmails.createdAt));

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Invite allow-list</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Only these emails (plus the owner) can sign in with a magic link.
        </p>
      </div>
      <AllowedEmailsManager
        initialEmails={rows.map((r) => ({
          email: r.email,
          addedBy: r.addedBy,
          createdAt: r.createdAt.toISOString(),
        }))}
      />
    </div>
  );
}
