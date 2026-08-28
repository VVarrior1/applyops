import Link from "next/link";
import { eq } from "drizzle-orm";
import { requireUser, ensureProfile } from "@/src/auth/require";
import { getDb } from "@/src/db/client";
import { profiles } from "@/src/db/schema";
import { SignOutButton } from "./sign-out-button";

const NAV_ITEMS = [
  { href: "/onboarding", label: "Onboarding" },
  { href: "/jobs", label: "Jobs" },
  { href: "/applications", label: "Applications" },
  { href: "/guide", label: "Guide" },
  { href: "/funnel", label: "Funnel" },
  { href: "/settings", label: "Settings" },
] as const;

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const db = getDb();

  // Belt-and-suspenders: the callback route already calls this on first
  // sign-in, but a session can predate this code path (e.g. the owner row
  // seeded directly by src/db/seed-v1.ts), so make sure it's never missing
  // here either.
  await ensureProfile(db, user);

  const [profile] = await db
    .select({ isOwner: profiles.isOwner })
    .from(profiles)
    .where(eq(profiles.userId, user.id))
    .limit(1);
  const isOwner = profile?.isOwner ?? false;

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-5xl items-center gap-4 px-4 py-3 sm:gap-6">
          <Link href="/settings" className="shrink-0 text-sm font-semibold tracking-tight">
            ApplyOps
          </Link>
          <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-sm">
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="shrink-0 rounded-md px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {item.label}
              </Link>
            ))}
            {isOwner && (
              <Link
                href="/evals"
                className="shrink-0 rounded-md px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                Evals
              </Link>
            )}
          </nav>
          <span className="hidden shrink-0 text-sm text-muted-foreground sm:inline">
            {user.email}
          </span>
          <div className="shrink-0">
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 py-8">
        {children}
      </main>
    </div>
  );
}
