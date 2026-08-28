import Link from "next/link";
import { getOptionalUser } from "@/src/auth/require";
import { buttonVariants } from "@/components/ui/button";

const NAV_ITEMS = [
  { href: "/results", label: "Results" },
  { href: "/benchmark", label: "Benchmark" },
] as const;

/**
 * Shared header for every route under `app/(public)/**` — `/`, `/results`,
 * and `/benchmark`. Fixes the QA finding that each public page hand-rolled
 * its own header with a different nav and a "Sign in" link that showed even
 * to a signed-in user: this is the one place that decides both, so the
 * three pages can no longer drift apart the way `/results` ("ApplyOps |
 * Benchmark | Sign in") and `/benchmark` ("ApplyOps | JSON") did.
 *
 * `getOptionalUser()` never redirects (unlike `requireUser()`, which
 * `app/(app)/layout.tsx` uses) — these routes are public precisely so a
 * signed-out visitor can read them, but a signed-in owner gets a way back
 * into the app instead of a misleading invitation to sign in again.
 */
export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  const user = await getOptionalUser();

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-5xl items-center gap-4 px-4 py-3 sm:gap-6">
          <Link href="/" className="shrink-0 text-sm font-semibold tracking-tight">
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
          </nav>
          <div className="shrink-0">
            {user ? (
              <Link href="/jobs" className={buttonVariants({ size: "sm", variant: "outline" })}>
                Back to Jobs
              </Link>
            ) : (
              <Link href="/login" className={buttonVariants({ size: "sm", variant: "outline" })}>
                Sign in
              </Link>
            )}
          </div>
        </div>
      </header>
      <div className="flex flex-1 flex-col">{children}</div>
    </div>
  );
}
