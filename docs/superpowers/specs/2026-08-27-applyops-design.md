# ApplyOps — Design Spec

**Date:** 2026-08-27 · **Status:** approved in chat (v2 scope) · **Owner:** Abdu (VVarrior1)
**Repo:** github.com/VVarrior1/applyops (public) · **Predecessor:** VVarrior1/jobhelper (private, `~/Job_Auto_Apply`)

## 1. Purpose

A job-application system that is (a) genuinely useful to new-grad software job seekers — starting with the owner's own Fall-2026 search and open to invited users — and (b) a portfolio showpiece for AI-product-engineer roles because every AI step is **measured**: fact-checked outputs, a quality gate that blocks regressions, an instrumented outcome funnel, and a public multi-model benchmark.

Plain-English summary of what v2 adds over jobhelper v1:
1. **It keeps score** — every application is tracked applied → response → interview → offer, tagged to the exact prompt/model version that produced it.
2. **It fact-checks itself** — every generated resume bullet must cite fact ids from the user's confirmed profile; uncited claims are counted as hallucinations.
3. **It refuses to get worse** — a golden set of hand-graded examples re-runs in CI on every prompt/model change; regressions fail the build.
4. **Other people can use it** — sign in, upload a resume, confirm extracted facts, set targets, get ranked matches / tailored resumes / suggestions.
5. **Better finders** — 7 ATS sources with official public endpoints + a ~12k company→ATS dataset instead of a hand-kept list of 146.
6. **Model choice by evidence** — a provider-agnostic layer runs every step across ~6 cheap/mid models; a public benchmark page shows quality vs. cost per step.
7. **"Improve your chances" tab** per job.

Non-goals (v1): auto-submit of applications (never), LinkedIn/Indeed scraping, mobile app, payments, fine-tuned models, browser extension.

## 2. Users & roles

- **Owner** (Abdu): full dashboard, eval grading UI, benchmark runs, agent CLI.
- **Invited user**: onboarding, jobs, tailoring, suggestions, applications/outcomes, own settings, delete-my-data. Daily AI budget enforced.
- **Public visitor**: `/results` (owner's redacted funnel + eval scorecard) and `/benchmark` (model table). No auth.

Auth: Supabase Auth **email magic link** (zero external setup). Invite-only: an `allowed_emails` table gates sign-up; owner adds emails in `/settings/admin`. Google OAuth is a later add.

## 3. Architecture

Single repo, single `package.json`, TypeScript throughout.

| Surface | Runs on | Responsibility |
|---|---|---|
| `web/` — Next.js (App Router) | Vercel | Dashboard, onboarding, API routes, public pages, PDF rendering (`@react-pdf/renderer`) |
| `cli/` — `applyops` commands (tsx + commander) | Owner's Mac (Docker image provided) | `scrape`, `rank`, `eval`, `bench`, `apply` (Playwright agent), `outcome` |
| `.github/workflows/` | GitHub Actions | `ci.yml` (typecheck, unit tests), `eval-gate.yml` (golden-set regression on prompt/pipeline changes), `scrape.yml` (daily cron) |
| Supabase | Cloud (ca-central-1) | Postgres, Auth, Storage (resume PDFs) |

Shared code lives in `src/` and is imported by web, CLI and workflows: `src/db` (Drizzle schema + client), `src/pipeline` (steps, prompts, schemas), `src/eval`, `src/finders`, `src/profile`, `src/llm` (provider layer).

**Provider layer:** Vercel AI SDK v7 (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai`) with `generateText` + `Output.object({ schema })` (zod). A `ModelId` string like `anthropic:claude-haiku-4-5` resolves to a provider model. Every call records tokens, cost (from a pricing table in `src/llm/pricing.ts`), latency, model id, prompt version.

**Key dependencies:** next, react, tailwindcss, shadcn/ui, drizzle-orm + postgres, @supabase/ssr + @supabase/supabase-js, ai + provider packages, zod, @react-pdf/renderer, pdf-parse (resume text extraction), playwright, commander, vitest, tsx.

## 4. Data model (Drizzle, Postgres)

All user-owned rows carry `user_id` (uuid, references `auth.users`). Access is enforced in application code via the server-side Supabase session (service-role connection from server code only); RLS is enabled on user tables with owner-only policies as defense in depth.

```
profiles            user_id PK, display_name, is_owner, daily_budget_usd (default 1.00), created_at
allowed_emails      email PK, added_by, created_at
profile_facts       id, user_id, label (e.g. "F-014"), category (experience|project|skill|education|other),
                    text, source ('resume_upload'|'manual'), confirmed bool, created_at, updated_at
                    UNIQUE(user_id, label)
search_prefs        user_id PK, roles text[], locations text[], remote ('any'|'remote'|'hybrid'|'onsite'),
                    seniority text[], work_auth ('canada'|'us_citizen_pr'|'needs_sponsorship'|'tn_eligible'),
                    keywords text[], excluded_companies text[]
companies           id, name, ats_vendor (greenhouse|lever|ashby|recruitee|personio|smartrecruiters|yc|other),
                    ats_slug, careers_url, source ('v1_allowlist'|'openjobs'|'manual'), active bool
                    UNIQUE(ats_vendor, ats_slug)
jobs                id, company_id, external_id, url UNIQUE, title, location, remote bool, description,
                    posted_at, scraped_at, last_seen_at, is_entry_level bool, is_relevant_role bool,
                    work_auth_signal ('hires_canadians'|'tn_friendly'|'needs_us_auth'|'unclear'),
                    analysis jsonb (AnalyzeJobOutput), analysis_generation_id
job_scores          id, job_id, user_id, ranker_version, score int (0-100), matched jsonb, gaps jsonb,
                    rationale, generation_id, created_at   UNIQUE(job_id, user_id, ranker_version)
generations         id, user_id, job_id, step (analyze|fit|tailor|suggest|judge|extract_facts),
                    prompt_version_id, model_id, input_tokens, output_tokens, cost_usd, latency_ms,
                    output jsonb, error text, created_at
prompt_versions     id, step, version (semver), sha256, content, created_at   UNIQUE(step, version)
applications        id, user_id, job_id, tailor_generation_id, resume_pdf_path, status
                    (draft|applied|responded|interviewing|offer|rejected|ghosted|withdrawn), created_at
outcome_events      id, application_id, type (applied|viewed|response|oa|phone_screen|interview|offer|
                    rejected|ghosted|withdrawn), occurred_at, notes
approvals           id, application_id, screenshot_path, summary, decision (pending|approved|declined),
                    decided_at
eval_items          id, job_id, profile_snapshot jsonb (facts at freeze time), step, human_grades jsonb
                    ({grounding, coverage, specificity, stuffing_penalty}: 1-5, grader, graded_at), notes
eval_runs           id, step, model_id, prompt_version_id, git_sha, item_count, metrics jsonb
                    (mean_score, hallucination_rate, kappa, cost_usd, p50_ms, p95_ms, ci95 {...}),
                    baseline bool, created_at
eval_results        id, run_id, item_id, generation_id, judge_scores jsonb, hallucination_count,
                    unsupported_claims jsonb, cost_usd, latency_ms
usage_daily         user_id, date, cost_usd, calls   PK(user_id, date)
```

Funnel metrics are **derived** from `outcome_events`, never stored.

## 5. Pipeline steps

Each step = a versioned prompt file `src/pipeline/prompts/<step>.v<N>.md` + a zod output schema + a pure function `run<Step>(input, {model})`. Prompt content is hashed; a `prompt_versions` row is upserted on first use. Steps never read the DB directly — callers pass inputs and persist `generations`.

| Step | Input | Output (zod) |
|---|---|---|
| `extract_facts` | resume text | `{facts: [{category, text, evidence_span}]}` → user confirms → `profile_facts` with labels `F-001…` |
| `analyze` | job title/company/description | `{requirements: [{text, must_have}], nice_to_have[], seniority, years_min, work_auth_signal, keywords[], summary}` |
| `fit` | analysis + user facts + prefs | `{score: 0-100, matched: [{requirement, fact_ids[]}], gaps[], rationale}` |
| `tailor` | analysis + user facts + fit | `{summary, skills[], sections: [{heading, bullets: [{text, fact_ids[]}]}]}` |
| `suggest` | analysis + facts + fit | `{gaps: [{requirement, severity, how_to_close}], lead_with: [{fact_ids, why}], weekend_build: {idea, why, fact_ids}, likely_questions[], keywords_to_include[]}` |
| `judge` | job + facts + tailor output + rubric | `{grounding, coverage, specificity, stuffing_penalty: 1-5 each, rationale}` |

**Hallucination check (mechanical, no LLM):** for `tailor` and `suggest`, every `fact_ids` entry must exist in the user's confirmed facts and every bullet must have ≥1 id. Violations → `unsupported_claims`; rate = unsupported / total bullets. Bullets with violations are **blocked from the PDF** and shown to the user for manual fix.

**Ranker v0:** `fit` step (LLM) is the ranker; `ranker_version = "fit-v1:<model>"`. Baseline for comparison: ported v1 keyword `calculatePriorityScore`, stored as `ranker_version = "keyword-v1"`. Precision@10 vs. outcomes is computed once ≥30 outcome events exist (later).

## 6. Finders

`src/finders/<vendor>.ts` each exports `fetchJobs(company): Promise<RawJob[]>` for: greenhouse, lever, ashby, recruitee, personio (XML), smartrecruiters, yc (Algolia). Shared: `normalize()`, `isEntryLevel()`, `isRelevantRole()`, `isPreferredLocation()`, `detectWorkAuth()` (single module, unit-tested; ported from v1's three duplicated copies).

**Company discovery:** `applyops companies import` ingests (1) v1's allow-lists (146 Greenhouse + 80 Lever + 9 Workday) and (2) the MIT-licensed OpenJobs / career-ops company→ATS mapping, filtered to software/tech. Workday tenants are kept as data but the Workday finder is deferred (per-tenant JSON is brittle).

**Schedule:** `scrape.yml` daily at 05:00 America/Edmonton; also `applyops scrape` locally. Politeness: ≥100 ms between requests per vendor, `last_seen_at` updates, jobs unseen for 30 days marked inactive.

**Per-user ranking budget:** `fit` runs only on jobs that pass deterministic filters and the user's prefs, newest first, capped by `daily_budget_usd`. Analysis (`analyze`) is per job, shared across users, cached in `jobs.analysis`.

**Explicitly excluded:** LinkedIn, Indeed, aggregators reselling them (JSearch), Adzuna (attribution/licence), SimplifyJobs listings.json (no licence).

## 7. Eval harness & CI gate

- **Golden set:** 40 `eval_items` for `tailor` (and reused for `fit`/`suggest`), chosen for diversity (role type × location × ATS × seniority wording) from seeded v1 jobs + fresh scrapes, with the owner's profile snapshot frozen.
- **Grading UI:** `/evals/grade` — shows job + generated output, 4 sliders (1–5), notes; writes `human_grades`. **This is the owner's one manual task** (~2–3 h).
- **`applyops eval --step tailor --model <id> [--items N]`:** runs the step on every item → hallucination check → `judge` (fixed judge model, versioned) → per-item results → run metrics: mean judge score, hallucination rate, **weighted Cohen's kappa** judge-vs-human (when grades exist), cost, p50/p95, and **bootstrap 95% CI** (1000 resamples) on the mean-score delta vs. the current baseline run. Writes `eval_runs`/`eval_results`; prints a table; emits `eval-report.json` + `eval-report.html`.
- **Gate (`eval-gate.yml`):** on PRs touching `src/pipeline/**`, `src/eval/**`, `src/llm/**`: run 20-item subset with the default model; fail if `hallucination_rate > 0.02` or the CI95 of (mean − baseline) lies entirely below 0. On `main`, run the full 40 and mark the run `baseline`. Cost per gate run is logged in the job summary.
- **Unit tests (vitest):** hallucination checker, kappa, bootstrap, funnel derivation, finders' filters, prompt hashing, pricing.

## 8. Model benchmark

`applyops bench --steps analyze,fit,tailor,suggest --models <list>` runs each step × model over the golden set and writes `eval_runs` (one per pair). Default model list: `anthropic:claude-haiku-4-5`, `anthropic:claude-sonnet-5`, `google:gemini-3.7-flash`, `google:gemini-2.5-flash-lite`, `openai:gpt-5.4-mini`, `openai:gpt-5.4-nano` (skipped automatically if the provider key is absent). Judge is always `anthropic:claude-sonnet-5` (fixed, versioned) — the judge is never one of the contestants being compared against itself without saying so on the page.

`/benchmark` (public) renders quality (mean judge score with CI), hallucination rate, $/item, p50 latency per step × model, plus methodology and caveats (judge model, n, date, prompt versions). `src/llm/defaults.ts` holds the chosen default per step, with a comment citing the run id that justified it.

## 9. Web app

Routes: `/` (landing → sign in), `/onboarding` (upload PDF → facts review → prefs), `/jobs` (ranked list, filters), `/jobs/[id]` (tabs: Posting · Fit · Tailor · Suggestions · Apply), `/applications` (list + outcome buttons), `/funnel` (weekly funnel by prompt version with CIs), `/evals` (runs, trends; owner), `/evals/grade` (owner), `/benchmark` (public), `/results` (public, redacted), `/settings` (profile, facts editor, prefs, budget, delete data, admin allow-list for owner).

Tailor tab: generate → hallucination report → editable bullets → **Download PDF** (react-pdf template ported from `resume.tex` layout) → "Mark as applied" creates `applications` + first `outcome_event`.

Public `/results`: owner's funnel with company names replaced by `Company #n (industry)`, eval scorecard, kappa, and the latest gate run.

## 10. Apply agent (CLI)

`applyops apply <application_id>`: loads the user's facts/answers, opens Playwright with `launchPersistentContext` (per-vendor profile dir), runs the **deterministic fast path** (ported Greenhouse/Lever/Ashby handlers from v1 `apply-now.ts`, PII from profile, no canned essays), then the **Claude tool-use loop** (ported `apply-agent.ts`, model `claude-sonnet-5`) for whatever remains. Before any submit: screenshot → `approvals` row → terminal `y/N` (and the dashboard shows the pending approval). Never auto-submits; `--dry-run` default in Docker. Owner-only in v1.

## 11. Cost & abuse controls

- `usage_daily` checked before every LLM call; over budget → 429 with a friendly message.
- Per-job `analyze` cached and shared; `fit` capped per user per day; `bench`/`eval` are owner-only CLI commands.
- Invite-only sign-up; resume PDFs private in Supabase Storage; **Delete my data** removes all rows + files.

## 12. Deployment & config

- Vercel project `applyops` (env: `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `OPENAI_API_KEY`, `OWNER_EMAIL`, `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`).
- GitHub Actions secrets: same minus `NEXT_PUBLIC_*`.
- Local: `.env.local` (gitignored); `.env.example` committed.
- Drizzle migrations in `drizzle/`, applied with `npm run db:migrate`.

## 13. Error handling

- LLM calls: typed retry on 429/5xx (3 attempts, exponential), never on 4xx; schema validation failure → one repair retry with the zod error appended, then `generations.error` and a user-visible "try again".
- Finders: per-company try/catch, a failing vendor never aborts the run; summary counts logged.
- PDF: rendering errors surface inline; the JSON output is still downloadable.
- Agent: any unexpected page state → `needs_manual` with screenshot; never guesses on submit.

## 14. README order (non-negotiable)

1. Eval scorecard (hallucination rate, kappa, gate screenshot) · 2. Funnel with CIs · 3. Model benchmark table · 4. Architecture · 5. Finders & coverage · 6. Apply agent · 7. What this deliberately does not do · 8. Running it yourself.

## 15. Owner's manual tasks (everything else is automated)

1. Grade the 40 golden items at `/evals/grade` (~2–3 h). Until then the scorecard shows hallucination rate/cost/latency and marks kappa as "pending human grades".
2. Provide `GOOGLE_GENERATIVE_AI_API_KEY` and `OPENAI_API_KEY` if none are found on this machine (benchmark rows for those providers stay hidden until keys exist).
3. Confirm the Supabase magic-link emails arrive (default SMTP; ~3/hour limit — fine for invite-only).
4. Invite the first users from `/settings/admin`.
