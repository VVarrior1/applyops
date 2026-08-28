# Owner's manual tasks

Everything else — scraping, ranking, tailoring, fact-checking, the eval gate,
the benchmark, deployment — is automated (CI, the nightly scrape cron,
`vercel --prod`). The items below need a human, specifically the owner,
because they touch a UI a script can't click through, a mailbox only a human
can check, or a credential no CLI is authorized to generate on its own — plus
two entries (§1, §6) that are *recorded decisions* rather than tasks, written
down so the limitation they describe isn't rediscovered from a code comment.

## 1. (Not planned) Human grading of the golden set

The owner has decided not to hand-grade the 40 golden items. Consequences,
already reflected in the app and README: the judge-vs-human kappa is not
reported anywhere (it shows "n/a — AI-judged"), the objective quality number
is the hallucination (uncited-claim) rate, and rubric scores are labelled as
LLM-judge scores. `/evals/grade` still works if anyone ever wants to grade a
few items, but nothing depends on it. Planned replacement: judge-vs-judge
agreement across two model families once a second provider key exists.

## 2. Add `OPENAI_API_KEY` (and re-add `ANTHROPIC_API_KEY` once it has credit)

The benchmark's OpenAI row is currently empty — no key was ever configured,
so `planBench` skips it rather than crash. Anthropic is configured but every
key available during this build had a **zero credit balance**; every
Anthropic item in the last benchmark run failed with "Your credit balance is
too low to access the Anthropic API" (see `docs/gate-demo.md` and the
benchmark caveats on `/benchmark`).

1. Get a key: [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
   (OpenAI) or top up credit at [console.anthropic.com](https://console.anthropic.com/settings/billing) (Anthropic).
2. Add it in three places — never paste the value anywhere but these three
   prompts, and never paste it into a chat with an assistant:
   - **Local:** open `.env.local` and set `OPENAI_API_KEY=` (or
     `ANTHROPIC_API_KEY=`).
   - **Vercel** (production + preview): `! vercel env add OPENAI_API_KEY production`
     then `! vercel env add OPENAI_API_KEY preview` — the CLI prompts for the
     value interactively, so it never touches shell history or this
     conversation.
   - **GitHub Actions:** `! gh secret set OPENAI_API_KEY` from the repo root
     — same interactive prompt.
3. Re-run the benchmark so the new rows appear on the public page:
   `npm run bench -- --steps analyze,fit,tailor,suggest --models openai:gpt-4o-mini,openai:gpt-4.1-mini,google:gemini-3.7-flash,google:gemini-2.5-flash-lite`
   (adjust the model list to whatever's current in
   [`src/bench/bench.ts`](../src/bench/bench.ts)'s `DEFAULT_BENCH_MODELS`).
4. If Anthropic credits landed: also flip `JUDGE_MODEL_ID` in
   [`src/llm/defaults.ts`](../src/llm/defaults.ts) back to
   `anthropic:claude-sonnet-5` per spec §8 — the "judge is also a
   contestant" caveat on `/benchmark` auto-hides once the judge stops
   appearing in its own table.

## 3. Confirm magic-link email delivery

Supabase's default SMTP is rate-limited (~3 emails/hour) — fine for an
invite-only app, but worth a real check before inviting anyone.

1. Go to `/login`, enter your own email, submit.
2. Confirm the magic-link email arrives within a minute or two — **check
   spam/promotions**, default-SMTP mail commonly lands there.
3. Click it, confirm you land back in the app signed in.

If it doesn't arrive: Supabase dashboard → Authentication → Emails, confirm
the magic-link template is enabled, or configure a custom SMTP provider
(Postmark/Resend/SES) under Authentication → SMTP Settings if the default
limit becomes a problem once real users are inviting each other.

## 4. Invite the first users

`/settings/admin` (owner-only) manages the `allowed_emails` allow-list —
sign-up is invite-only by design (spec §2). Add each person's email there
before telling them to sign in; anyone not on the list who tries the
magic-link flow will authenticate with Supabase but be rejected at the
allow-list check.

## 5. From Step 1 (deploy) that needed the dashboard

- **Supabase Auth redirect URL:** set **Site URL** to
  `https://applyops-two.vercel.app` and add both
  `https://applyops-two.vercel.app` and
  `https://applyops-two.vercel.app/auth/callback` to **Redirect URLs**, so
  magic-link emails redirect back to the live site instead of `localhost`.
  Supabase dashboard → Authentication → URL Configuration. The CLI/management
  API does not expose this setting cleanly enough to script safely — do it
  directly at
  [supabase.com/dashboard/project/_/auth/url-configuration](https://supabase.com/dashboard/project/_/auth/url-configuration).
  This is the one item that actually blocks magic-link login on production
  until it's done.
- **Custom domain (optional):** if you want something other than the default
  `*.vercel.app` URL, add it under the Vercel project's Settings → Domains,
  then update the Supabase redirect URL above to match.

## 6. (Decision recorded) LaTeX resume PDFs are local-only

Nothing to do unless you want to change the decision — this is here so the
limitation is written down somewhere other than a code comment.

`POST /api/jobs/[id]/pdf` prefers the v1 LaTeX pipeline: your real
`resume.tex` with only the Technical Skills and Projects blocks replaced
(`src/pdf/latex.ts`). It needs `pdflatex` on the machine doing the render.
**Vercel has no TeX distribution**, so every download from
`applyops-two.vercel.app` is the react-pdf template instead — the output you
rated worse than v1. The Tailor tab now prints which renderer produced each
file (from the `x-applyops-renderer` response header), so this is visible
rather than silent.

To get the LaTeX PDF, run it on this Mac (MacTeX is at `/Library/TeX/texbin`):

```bash
# once — loads your real resume into `resume_bases` (append-only; re-run to update)
! npm run cli -- resume import-latex ~/Job_Auto_Apply/resume.tex --transcript ~/Job_Auto_Apply/public/documents/Transcript.pdf

# per posting — writes out/<slug>.pdf and out/<slug>.tex, prints `renderer  latex`
! npm run cli -- pdf <jobId>
! npm run cli -- pdf <jobId> --transcript   # transcript appended with Ghostscript
```

If you ever want LaTeX in production, the change is to run the render on a
host with TeX — the repo's `Dockerfile` is the natural place (add
`texlive-latex-recommended` + `ghostscript` and move the PDF route's render
behind a small job the container serves). That costs an always-on host, which
is why it was not done for a one-person search.

## 7. (Optional) Ask GitHub to purge a cached commit

Early README screenshots were committed with the owner email unmasked, then
rewritten out of history the same day (the commit no longer exists in the
repo, and all task branches were deleted). GitHub can still serve the old
commit by URL / in the merged PR #2 view until its garbage collection runs.
If you want it gone sooner, open a support request at
https://support.github.com/request and ask them to purge unreachable
objects for `VVarrior1/applyops`. The screenshots showed an email address,
not a secret, so this is tidiness rather than urgency.
