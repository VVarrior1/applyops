import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

const GITHUB_URL = "https://github.com/VVarrior1/applyops";

const BULLETS = [
  {
    title: "Finds relevant postings",
    body: "Scrapes entry-level, Canada/TN-friendly roles daily from company career pages — no LinkedIn, no Indeed, no scraped job boards that resell the same listings.",
  },
  {
    title: "Tailors a resume to each one",
    body: "An LLM pipeline rewrites bullets against your real, confirmed facts and checks every claim against them before you ever see it — nothing invented gets past the hallucination checker.",
  },
  {
    title: "Applies with a human in the loop",
    body: "A browser agent fills the form; nothing is ever submitted without an explicit approval. Every outcome — response, interview, offer, ghost — is logged and shown, unfiltered, on /results.",
  },
] as const;

/**
 * `/` — public landing page, plan Task 14 Step 3: "one screen: what it is (3
 * bullets in plain English), links to /results, /benchmark, GitHub, and
 * 'Sign in (invite only)'." Replaces the scaffold's placeholder
 * `app/page.tsx` (which literally said "the public landing page ships in a
 * later build task" — this is that task); moved under the `(public)` route
 * group per the plan's locked file structure so it sits alongside
 * `/results` and `/benchmark`.
 */
export default function LandingPage() {
  return (
    <div className="flex flex-1 flex-col">
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-10 px-4 py-16">
        <div className="flex flex-col gap-3">
          <span className="text-sm font-medium tracking-wide text-muted-foreground uppercase">
            ApplyOps
          </span>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            One person&apos;s job search, run and measured like a product.
          </h1>
          <p className="max-w-xl text-muted-foreground">
            Everything below — the funnel, the eval scores, the model comparisons — is real and
            public. Nothing is a demo.
          </p>
        </div>

        <ol className="flex flex-col gap-6">
          {BULLETS.map((bullet, i) => (
            <li key={bullet.title} className="flex gap-4">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                {i + 1}
              </span>
              <div>
                <h2 className="font-medium">{bullet.title}</h2>
                <p className="mt-0.5 text-sm text-muted-foreground">{bullet.body}</p>
              </div>
            </li>
          ))}
        </ol>

        <div className="flex flex-wrap items-center gap-3 border-t pt-6">
          <Link href="/results" className={buttonVariants()}>
            See the results
          </Link>
          <Link href="/benchmark" className={buttonVariants({ variant: "outline" })}>
            Model benchmark
          </Link>
          <Link href={GITHUB_URL} className={buttonVariants({ variant: "outline" })}>
            GitHub
          </Link>
          <Link href="/login" className={buttonVariants({ variant: "ghost" })}>
            Sign in (invite only)
          </Link>
        </div>
      </main>
    </div>
  );
}
