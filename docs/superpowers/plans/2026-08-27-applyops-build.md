# ApplyOps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build ApplyOps v1 — a multi-user, eval-gated job-application system (finders → per-user ranking → fact-checked tailoring/suggestions → outcome funnel → model benchmark → local apply agent) live on Vercel + Supabase.

**Architecture:** One Next.js (App Router) repo. Shared TypeScript libraries in `src/` are imported by the web app (`app/`), the CLI (`cli/`), and GitHub Actions workflows. Postgres (Supabase) via Drizzle; LLM calls through a provider-agnostic layer (Vercel AI SDK v7) that records every generation's tokens/cost/latency/prompt-version. Pure logic (filters, hallucination check, stats, funnel) is isolated and unit-tested with Vitest.

**Tech Stack:** Next.js (latest, App Router, TS), Tailwind + shadcn/ui, Drizzle ORM + `postgres`, Supabase (Postgres, Auth magic link, Storage), `ai` v7 + `@ai-sdk/anthropic` `@ai-sdk/google` `@ai-sdk/openai`, `zod`, `@react-pdf/renderer`, `pdf-parse`, `playwright`, `commander` + `tsx`, `vitest`, GitHub Actions, Vercel.

**Spec:** `docs/superpowers/specs/2026-08-27-applyops-design.md` — read it first; this plan implements it section by section.

## Global Constraints

- Repo root is `/Users/abdu/New Major project` (path contains spaces — always quote paths). Remote: `origin` = github.com/VVarrior1/applyops. Work on `main`, commit after every task with conventional-commit messages; push after each task.
- **Never commit secrets.** `.env.local` is gitignored and already contains: `SUPABASE_PROJECT_REF`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL` (pooler :6543), `DIRECT_DATABASE_URL` (:5432), `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `OWNER_EMAIL`. `OPENAI_API_KEY` is absent — code must treat missing provider keys as "provider unavailable", never crash.
- Never print env values. Never hardcode PII (names, emails, phones) in source — v1's `candidate-info.ts` and `apply-now.ts` `ME` object must NOT be copied; profile data comes from the DB.
- Models: default per-step model ids live only in `src/llm/defaults.ts`. Claude ids: `claude-haiku-4-5`, `claude-sonnet-5` (no date suffixes). Judge model is fixed: `anthropic:claude-sonnet-5`.
- Anthropic-specific SDK guidance (structured outputs, thinking, errors) is in the bundled skill docs at `/private/tmp/claude-501/bundled-skills/2.1.247/a90cafe3dfa7c0cc955cb091ac33c6b7/claude-api/typescript/claude-api/README.md` — read it before writing any direct Anthropic SDK code (the agent tool loop in Task 15 uses `@anthropic-ai/sdk` directly; everything else uses the `ai` SDK).
- v1 source to port from: `/Users/abdu/Job_Auto_Apply` (read-only). Code map with exact file paths/signatures: `/private/tmp/claude-501/-Users-abdu-New-Major-project/f4f89420-61c7-4952-a314-dfc92b03b212/scratchpad/jobhelper_codemap.md`.
- Every DB table with user data has `user_id`; every query from web routes is scoped to the session user; owner = `profiles.is_owner`.
- No auto-submit, ever. No LinkedIn/Indeed/JSearch/Adzuna/SimplifyJobs sources.
- Tests: `npm test` (vitest) must pass at the end of every task; `npm run typecheck` and `npm run build` must pass at the end of Tasks 1, 3, 6, 8, 9, 10, 11, 13, 14, 16.
- Verification is evidence-based: paste command output in the task report; never claim "works" without running it.

---

## File Structure (locked)

```
app/                      Next.js routes (App Router)
  (public)/page.tsx, results/page.tsx, benchmark/page.tsx, login/page.tsx, auth/callback/route.ts
  (app)/layout.tsx, onboarding/, jobs/, jobs/[id]/, applications/, funnel/, evals/, evals/grade/, settings/, settings/admin/
  api/**/route.ts         thin handlers → call src/ services
components/               shadcn/ui primitives + app components
src/db/schema.ts          Drizzle schema (all tables, spec §4)
src/db/client.ts          getDb() (postgres-js, DATABASE_URL), getDirectDb() for migrations/seeds
src/db/seed-v1.ts         imports v1 CSVs
src/auth/                 supabase server/browser clients, requireUser(), requireOwner(), allow-list check
src/llm/model-id.ts       parseModelId("anthropic:claude-haiku-4-5") → {provider, model}
src/llm/pricing.ts        PRICING table + estimateCost()
src/llm/provider.ts       resolveModel(id) → LanguageModel (ai SDK); isProviderAvailable()
src/llm/defaults.ts       DEFAULT_MODEL_BY_STEP
src/llm/call.ts           callStructured() — budget check, ai.generateText+Output.object, retries, records generations
src/llm/budget.ts         checkBudget(userId, estUsd), recordUsage()
src/pipeline/schemas.ts   zod schemas for all step outputs (spec §5)
src/pipeline/prompts/*.md analyze.v1.md fit.v1.md tailor.v1.md suggest.v1.md judge.v1.md extract_facts.v1.md
src/pipeline/prompt-versions.ts  loadPrompt(step) → {content, version, sha256}; ensurePromptVersion(db, …)
src/pipeline/steps/{analyze,fit,tailor,suggest,judge,extract-facts}.ts
src/pipeline/hallucination.ts    checkCitations(output, factLabels) → HallucinationReport
src/profile/facts.ts      labelFacts(), upsertFacts(), getConfirmedFacts(userId)
src/profile/resume-text.ts extractPdfText(buffer)
src/finders/types.ts      RawJob, Finder interface
src/finders/filters.ts    isEntryLevel, isRelevantRole, isPreferredLocation, detectWorkAuth, normalizeLocation
src/finders/{greenhouse,lever,ashby,recruitee,personio,smartrecruiters,yc}.ts
src/finders/run.ts        runFinders({vendors?, limit?}) → upserts jobs, returns counts
src/finders/companies.ts  importV1Allowlists(), importOpenJobs()
src/rank/rank.ts          rankForUser(userId, {maxJobs}) — filters → analyze (cached) → fit → job_scores
src/rank/keyword.ts       keywordScore(job) (ported v1 calculatePriorityScore)
src/funnel/derive.ts      deriveFunnel(events, {groupBy}) pure
src/eval/stats.ts         weightedKappa(), bootstrapMeanDiff(), mean/percentiles
src/eval/golden.ts        selectGoldenItems(db, {n})
src/eval/runner.ts        runEval({step, modelId, items, judgeModelId}) → EvalRunSummary
src/eval/report.ts        writeReports(summary, dir) → eval-report.json/html
src/eval/gate.ts          evaluateGate(current, baseline, thresholds) → {pass, reasons}
src/bench/bench.ts        runBench({steps, models})
src/pdf/ResumeDocument.tsx react-pdf template; renderResumePdf(data) → Buffer
src/agent/ats-fastpath.ts greenhouse/lever/ashby deterministic fill (ported, PII from profile)
src/agent/tool-loop.ts    Claude tool-use loop (ported) with approvals gate
src/agent/run.ts          applyToApplication(applicationId, opts)
cli/index.ts              commander: scrape | companies import | rank | outcome | eval | bench | apply | golden select
tests/**/*.test.ts        vitest, mirrors src/
drizzle/                  migrations (drizzle-kit generate)
.github/workflows/{ci,eval-gate,scrape}.yml
Dockerfile                CLI/agent image (Playwright + node)
docs/USER_TODO.md         the owner's manual tasks
README.md                 in spec §14 order
```

---

### Task 1: Scaffold, tooling, CI skeleton

**Files:** Create Next app at repo root (via temp dir — see step 1), `vitest.config.ts`, `tests/smoke.test.ts`, `.env.example`, `.github/workflows/ci.yml`, `package.json` scripts. Keep existing `docs/`, `.gitignore`, `.env.local`.

**Interfaces — Produces:** npm scripts `dev`, `build`, `start`, `typecheck` (`tsc --noEmit`), `test` (`vitest run`), `db:generate`, `db:migrate`, `cli` (`tsx cli/index.ts`), `eval`, `bench`, `scrape`.

- [ ] **Step 1: Scaffold in a temp dir (directory name has spaces/capitals, which create-next-app rejects), then move in**
```bash
cd "/private/tmp/claude-501/-Users-abdu-New-Major-project/f4f89420-61c7-4952-a314-dfc92b03b212/scratchpad" && rm -rf applyops-scaffold && npx --yes create-next-app@latest applyops-scaffold --ts --tailwind --eslint --app --no-src-dir --import-alias "@/*" --use-npm --yes
rsync -a --exclude .git --exclude node_modules applyops-scaffold/ "/Users/abdu/New Major project/"
cd "/Users/abdu/New Major project" && npm install
```
If the scaffold's `.gitignore` overwrote ours, re-append the entries from the Global Constraints section (`.env.*` except `.env.example`, `*.local.yaml`, `public/apply_*.jpg`, `public/resumes/`, `.supabase/`).
- [ ] **Step 2: Install deps**
```bash
npm i drizzle-orm postgres @supabase/ssr @supabase/supabase-js ai @ai-sdk/anthropic @ai-sdk/google @ai-sdk/openai zod @react-pdf/renderer pdf-parse commander playwright @anthropic-ai/sdk date-fns papaparse fast-xml-parser
npm i -D drizzle-kit vitest tsx @types/papaparse @types/pdf-parse dotenv
npx --yes shadcn@latest init -d && npx --yes shadcn@latest add button card input label textarea badge table tabs dialog slider select separator toast -y
```
- [ ] **Step 3: Scripts + vitest config + env example**
`package.json` scripts: `"typecheck":"tsc --noEmit"`, `"test":"vitest run"`, `"db:generate":"drizzle-kit generate"`, `"db:migrate":"tsx src/db/migrate.ts"`, `"cli":"tsx cli/index.ts"`, `"scrape":"tsx cli/index.ts scrape"`, `"eval":"tsx cli/index.ts eval"`, `"bench":"tsx cli/index.ts bench"`.
`vitest.config.ts`: `{ test: { include: ['tests/**/*.test.ts'], environment: 'node' } }` with `@/` alias to repo root.
`.env.example`: every var name from Global Constraints with empty values plus `OPENAI_API_KEY=`.
- [ ] **Step 4: Failing smoke test → pass**
`tests/smoke.test.ts`: `import { describe, it, expect } from 'vitest'; describe('smoke', () => { it('adds', () => expect(1 + 1).toBe(2)) })`. Run `npm test` → PASS.
- [ ] **Step 5: CI workflow** `.github/workflows/ci.yml`: on push/PR → `npm ci`, `npm run typecheck`, `npm test`, `npm run build` (with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`, dummy `NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co`, `NEXT_PUBLIC_SUPABASE_ANON_KEY=dummy`).
- [ ] **Step 6: Verify** `npm run typecheck && npm test && npm run build` all pass. Commit `chore: scaffold Next.js app, tooling, CI` and push.

---

### Task 2: Database schema, migrations, v1 seed

**Files:** `src/db/schema.ts`, `src/db/client.ts`, `src/db/migrate.ts`, `drizzle.config.ts`, `src/db/seed-v1.ts`, `tests/db/schema.test.ts`.

**Interfaces — Produces:** all tables from spec §4 as Drizzle exports (`profiles, allowedEmails, profileFacts, searchPrefs, companies, jobs, jobScores, generations, promptVersions, applications, outcomeEvents, approvals, evalItems, evalRuns, evalResults, usageDaily`), enums (`stepEnum`, `atsVendorEnum`, `outcomeTypeEnum`, `applicationStatusEnum`, `workAuthSignalEnum`), `getDb()` (pooler URL, `prepare: false`), `getDirectDb()`.

- [ ] **Step 1: Write `src/db/schema.ts`** exactly per spec §4: uuid PKs (`defaultRandom()`), `timestamp withTimezone`, `jsonb` typed with `$type<...>()` using the zod-inferred types from Task 5 (import type-only; create `src/pipeline/schemas.ts` stub now if needed), unique constraints listed in the spec, indexes on `jobs.company_id`, `jobs.posted_at`, `job_scores(user_id, score)`, `generations(user_id, created_at)`, `outcome_events.application_id`.
- [ ] **Step 2: drizzle config + migrate script** — `drizzle.config.ts` uses `DIRECT_DATABASE_URL`; `src/db/migrate.ts` loads `.env.local` via dotenv and runs `migrate(getDirectDb(), { migrationsFolder: 'drizzle' })`. Run `npm run db:generate && npm run db:migrate` → prints applied migrations. Then enable RLS with owner-only policies on user tables in a second SQL migration (`drizzle/0001_rls.sql`, appended to the journal): `alter table <t> enable row level security; create policy "own rows" on <t> for all using (user_id = auth.uid());` for each table with `user_id`. The app uses the service-role/`postgres` connection so RLS is defense in depth only.
- [ ] **Step 3: Schema test** `tests/db/schema.test.ts`: uses `drizzle-orm/pg-core` `getTableConfig` to assert `jobs` has a unique index on `url`, `profile_facts` unique on (`user_id`,`label`), `eval_runs` has `baseline` column. Run → PASS.
- [ ] **Step 4: Seed** `src/db/seed-v1.ts`: read `/Users/abdu/Job_Auto_Apply/data/jobs.csv` (columns `id,url,title,company,location,remote,description,source,scraped_at,posted_at,priority_score,status,applied_at,notes,analysis`) and `applications.csv` (`id,job_id,tailored_summary,tailored_skills,created_at,pdf_path`). Upsert companies by name (vendor `other`, source `v1_allowlist`), jobs by `url`, and for the 7 applications create `applications` rows for the owner (`OWNER_EMAIL` → profile row created if missing, `is_owner=true`) with `outcome_events` `applied` at `created_at`; where v1 `status` is `interview`/`rejected`, add that event too. Idempotent (re-run safe). Run `npx tsx src/db/seed-v1.ts` → prints `jobs upserted: 211, applications: 7`.
- [ ] **Step 5: Verify + commit** `npm test` PASS. `psql`-free check: `npx tsx -e "import {getDb} from './src/db/client'; ..."` count jobs ≥ 211. Commit `feat(db): schema, migrations, RLS, v1 seed`; push.

---

### Task 3: Auth (magic link), allow-list, profiles, app shell

**Files:** `src/auth/server.ts`, `src/auth/browser.ts`, `src/auth/require.ts`, `middleware.ts`, `app/login/page.tsx`, `app/auth/callback/route.ts`, `app/(app)/layout.tsx` (nav: Jobs · Applications · Funnel · Evals(owner) · Settings), `app/(app)/settings/page.tsx`, `app/(app)/settings/admin/page.tsx`, `app/api/admin/allowed-emails/route.ts`, `tests/auth/allowlist.test.ts`.

**Interfaces — Produces:** `requireUser(): Promise<{id, email}>` (redirects to `/login`), `requireOwner()`, `isEmailAllowed(db, email)`, `ensureProfile(db, user)`.

- [ ] **Step 1: Test allow-list logic** `tests/auth/allowlist.test.ts`: `isEmailAllowedPure(email, {ownerEmail, allowed})` returns true for owner email (case-insensitive), true for listed, false otherwise. Run → FAIL (not defined).
- [ ] **Step 2: Implement** `src/auth/allowlist.ts` pure function + DB wrapper. Supabase SSR clients per `@supabase/ssr` docs (cookie-based). Magic link: `supabase.auth.signInWithOtp({email, options:{emailRedirectTo: <origin>/auth/callback}})`; callback exchanges code → session. In the callback, if `!isEmailAllowed` → sign out and redirect `/login?error=invite_only`. `ensureProfile` creates `profiles` (is_owner when email === OWNER_EMAIL).
- [ ] **Step 3: Middleware** protects `/(app)/**` and `/api/**` except `/api/public/**`; public routes: `/`, `/login`, `/auth/callback`, `/results`, `/benchmark`.
- [ ] **Step 4: Admin page** owner-only: list/add/remove `allowed_emails`.
- [ ] **Step 5: Verify** `npm test`, `npm run typecheck`, `npm run build` pass; `npm run dev` + curl `/login` returns 200 and `/jobs` redirects (302) when unauthenticated. Commit `feat(auth): magic-link auth, invite allow-list, app shell`; push.

---

### Task 4: LLM provider layer with cost/budget accounting

**Files:** `src/llm/model-id.ts`, `src/llm/pricing.ts`, `src/llm/provider.ts`, `src/llm/defaults.ts`, `src/llm/budget.ts`, `src/llm/call.ts`, `tests/llm/{model-id,pricing,budget,call}.test.ts`.

**Interfaces — Produces:**
```ts
export type ModelId = `${'anthropic'|'google'|'openai'}:${string}`
export function parseModelId(id: string): { provider: 'anthropic'|'google'|'openai'; model: string }
export const PRICING: Record<ModelId, { inputPerM: number; outputPerM: number; cachedInputPerM?: number }>
export function estimateCost(id: ModelId, usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number }): number
export function isProviderAvailable(provider): boolean   // env key present
export const DEFAULT_MODEL_BY_STEP: Record<Step, ModelId>  // initial: analyze haiku, fit haiku, tailor sonnet-5, suggest sonnet-5, judge sonnet-5, extract_facts haiku
export async function callStructured<T>(args: { db; userId: string|null; jobId?: string; step: Step; modelId?: ModelId; schema: z.ZodType<T>; system: string; prompt: string; promptVersionId: string; maxRetries?: number }): Promise<{ output: T; generationId: string; usage; costUsd: number; latencyMs: number }>
```
Pricing table values (USD per 1M, verified 2026-08-27): `anthropic:claude-haiku-4-5` 1.00/5.00 (cached 0.10); `anthropic:claude-sonnet-5` 2.00/10.00 (0.20); `google:gemini-3.7-flash` 0.75/3.75 (0.075); `google:gemini-2.5-flash-lite` 0.10/0.40 (0.01); `google:gemini-2.5-flash` 0.30/2.50 (0.03); `openai:gpt-5.4-mini` 0.75/4.50 (0.075); `openai:gpt-5.4-nano` 0.20/1.25 (0.02).

- [ ] **Step 1: Tests first** — `parseModelId('google:gemini-3.7-flash')` → `{provider:'google', model:'gemini-3.7-flash'}`; invalid throws. `estimateCost('anthropic:claude-haiku-4-5', {inputTokens: 1_000_000, outputTokens: 0})` → `1.0`. Budget: `decideBudget({spentToday: 0.95, dailyBudget: 1.0, estimate: 0.10})` → `{allowed: false}`; with `0.04` → allowed. `callStructured` test with an injected fake model (ai SDK `MockLanguageModelV3` from `ai/test`) returning valid JSON → output parsed, `generations` insert called with cost > 0 (mock db); invalid JSON first then valid → one repair retry.
- [ ] **Step 2: Implement** using `generateText({ model, system, prompt, output: Output.object({ schema }) })` from `ai`; providers via `anthropic(model)`, `google(model)`, `openai(model)`. Retry 429/5xx up to 3× with exponential backoff (500ms base); schema failure → one retry appending the zod error message to the prompt; final failure → insert `generations` row with `error` and throw `LlmError`. Budget: `userId` null (owner CLI/eval) bypasses; otherwise `checkBudget` before call, `recordUsage` after.
- [ ] **Step 3: Verify** `npm test` PASS. Live smoke (owner, no budget): `npx tsx -e` calling `callStructured` with `step:'analyze'`, haiku, schema `{ok: z.boolean()}`, prompt "reply ok true" → prints cost and generationId. Commit `feat(llm): provider layer, pricing, budget, structured calls`; push.

---

### Task 5: Pipeline steps, prompts, schemas, hallucination checker

**Files:** `src/pipeline/schemas.ts`, `src/pipeline/prompts/{analyze,fit,tailor,suggest,judge,extract_facts}.v1.md`, `src/pipeline/prompt-versions.ts`, `src/pipeline/steps/*.ts`, `src/pipeline/hallucination.ts`, `tests/pipeline/{hallucination,prompt-versions,schemas}.test.ts`.

**Interfaces — Produces:** zod schemas + types `AnalyzeOutput, FitOutput, TailorOutput, SuggestOutput, JudgeOutput, ExtractFactsOutput` exactly as spec §5; `loadPrompt(step): {content, version, sha256}`; `ensurePromptVersion(db, step): Promise<string /*id*/>`; step functions:
```ts
runAnalyze(db, { job: {title, company, description}, modelId?, userId? }): Promise<{output: AnalyzeOutput, generationId}>
runFit(db, { analysis, facts: Fact[], prefs, userId, jobId, modelId? })
runTailor(db, { analysis, facts, fit, userId, jobId, modelId? })
runSuggest(db, { analysis, facts, fit, userId, jobId, modelId? })
runJudge(db, { job, facts, tailor: TailorOutput, modelId? /* fixed default judge */ })
runExtractFacts(db, { resumeText, userId, modelId? })
checkCitations(output: TailorOutput|SuggestOutput, validLabels: Set<string>): { totalClaims: number; unsupported: {path: string; text: string; badIds: string[]}[]; rate: number }
```
`Fact = { label: string; category: string; text: string }`. Facts are rendered into prompts as `F-014 | project | Built ...` lines. Prompts instruct: cite only listed labels; every bullet ≥1 label; never invent employers/dates/metrics; keyword stuffing penalized.

- [ ] **Step 1: Tests first** — `checkCitations` with facts {F-001,F-002}: bullets `[{text:'a', fact_ids:['F-001']}, {text:'b', fact_ids:[]}, {text:'c', fact_ids:['F-009']}]` → `totalClaims 3`, `unsupported` length 2 (paths `sections[0].bullets[1]`, `sections[0].bullets[2]`), `rate ≈ 0.667`. `loadPrompt('tailor')` → sha256 stable across calls, version `'1.0.0'` from front-matter. Schemas: `TailorOutput.parse` rejects a bullet missing `fact_ids`.
- [ ] **Step 2: Write prompts** (markdown with front-matter `version: 1.0.0`, `step: tailor`). Judge rubric: grounding (claims supported by facts), coverage (must-have requirements addressed), specificity (concrete, quantified), stuffing_penalty (5 = no stuffing). Extract-facts prompt: one fact per line item, category, quote the resume span.
- [ ] **Step 3: Implement steps** each: `ensurePromptVersion` → `callStructured` with `DEFAULT_MODEL_BY_STEP[step]` unless overridden → return. `runTailor` and `runSuggest` also run `checkCitations` and return `hallucination` alongside output.
- [ ] **Step 4: Verify** `npm test` PASS; live smoke on one seeded job with 5 hand-written facts for the owner: `runAnalyze` then `runTailor` prints bullets with fact ids and a hallucination rate. Commit `feat(pipeline): steps, versioned prompts, schemas, citation checker`; push.

---

### Task 6: Profile onboarding — resume upload → facts → prefs

**Files:** `src/profile/resume-text.ts`, `src/profile/facts.ts`, `app/(app)/onboarding/page.tsx` (+ client components: `UploadStep`, `FactsReview`, `PrefsForm`), `app/api/profile/{upload,facts,prefs}/route.ts`, `app/(app)/settings/page.tsx` (facts editor + prefs + budget + Delete my data), `app/api/profile/delete/route.ts`, `tests/profile/facts.test.ts`.

**Interfaces — Produces:** `labelFacts(existingMax: number, facts): {label, …}[]` (next labels `F-###`), `upsertFacts(db, userId, facts)`, `getConfirmedFacts(db, userId): Promise<Fact[]>`, `getPrefs(db, userId)`, `deleteUserData(db, userId)` (all rows + storage objects).

- [ ] **Step 1: Test** `labelFacts(3, [{text:'x'},{text:'y'}])` → labels `F-004`, `F-005`. Run → FAIL → implement → PASS.
- [ ] **Step 2: Upload route** accepts PDF (≤5 MB) → Supabase Storage bucket `resumes` (private, path `${userId}/${ts}.pdf`; create bucket via service client if missing) → `extractPdfText` (pdf-parse) → `runExtractFacts` → return proposed facts (not yet saved).
- [ ] **Step 3: Facts review UI** editable list (text, category, keep/remove) → POST `/api/profile/facts` saves with `confirmed=true`. Prefs form: roles (multi-select chips: SWE, Full-stack, Backend, Frontend, ML/AI, Data, DevOps/SRE, Mobile), locations (free text chips), remote, seniority (new_grad, junior, intern), work_auth, keywords, excluded companies.
- [ ] **Step 4: Settings** shows facts editor (add/edit/delete), prefs, daily budget (owner may edit), **Delete my data** (confirm dialog → `deleteUserData` → sign out).
- [ ] **Step 5: Verify** `npm test`, `typecheck`, `build` pass; manual run: upload `/Users/abdu/Job_Auto_Apply/public/latest_resume.pdf` via curl with a session cookie or via the dev UI; confirm facts appear in `profile_facts` for the owner (count printed). Commit `feat(profile): onboarding, facts, prefs, delete-my-data`; push.

---

### Task 7: Finders (7 vendors), filters, company import, daily scrape

**Files:** `src/finders/types.ts`, `src/finders/filters.ts`, `src/finders/{greenhouse,lever,ashby,recruitee,personio,smartrecruiters,yc}.ts`, `src/finders/run.ts`, `src/finders/companies.ts`, `cli/index.ts` (`scrape`, `companies import`), `.github/workflows/scrape.yml`, `tests/finders/{filters,adapters}.test.ts` + fixtures in `tests/finders/fixtures/*.json`.

**Interfaces — Produces:**
```ts
export type RawJob = { externalId: string; url: string; title: string; location: string|null; remote: boolean; description: string; postedAt: Date|null }
export interface Finder { vendor: AtsVendor; fetchJobs(slug: string): Promise<RawJob[]> }
export function isEntryLevel(title: string, description: string): boolean
export function isRelevantRole(title: string): boolean
export function isPreferredLocation(location: string|null, remote: boolean, prefs?: {locations: string[]; remote: string}): boolean
export function detectWorkAuth(text: string): 'hires_canadians'|'tn_friendly'|'needs_us_auth'|'unclear'
export async function runFinders(db, opts: { vendors?: AtsVendor[]; maxCompanies?: number }): Promise<{ fetched: number; inserted: number; updated: number; errors: number }>
export async function importV1Allowlists(db): Promise<number>   // parses GREENHOUSE_COMPANIES/LEVER_COMPANIES/WORKDAY_CONFIG arrays from /Users/abdu/Job_Auto_Apply/scripts/scrape-apis.ts
export async function importOpenJobs(db, opts: { techOnly: boolean }): Promise<number>  // fetch github.com/outscal/OpenJobs data (MIT) raw JSON/CSV; map vendor names; skip unknown vendors
```
Endpoints: Greenhouse `https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true`; Lever `https://api.lever.co/v0/postings/{slug}?mode=json`; Ashby `https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true`; Recruitee `https://{slug}.recruitee.com/api/offers`; Personio `https://{slug}.jobs.personio.de/xml?language=en` (fast-xml-parser); SmartRecruiters `https://api.smartrecruiters.com/v1/companies/{slug}/postings` (+ `/postings/{id}` for description when needed; if the listing call returns 401/403 mark vendor `requires_key` in a log and skip); YC: port the Algolia query from v1 `scrape-apis.ts`.

- [ ] **Step 1: Filters tests** (port cases from v1 logic; add work-auth): "Senior Software Engineer" → not entry level; "Software Engineer, New Grad 2026" → entry level; "must be authorized to work in the US without sponsorship" → `needs_us_auth`; "TN visa" → `tn_friendly`; "Canada" in location → `hires_canadians` when description mentions Canadian hiring; else `unclear`. Run → FAIL → implement (single source, port from v1 `scrape-apis.ts:isEntryLevel/isRelevantRole/isPreferredLocation`) → PASS.
- [ ] **Step 2: Adapter tests with fixtures** — one recorded JSON/XML sample per vendor (fetch a real public board once, e.g. Greenhouse `stripe`, Lever `anthropic`, Ashby `notion`… save to fixtures) and assert `fetchJobs` maps to `RawJob` with non-empty title/url and parsed `postedAt`. Use `vi.stubGlobal('fetch', …)`.
- [ ] **Step 3: `runFinders`** iterates active companies (vendor in requested list), ≥100 ms between requests per vendor, per-company try/catch (count errors), applies filters to set `is_entry_level`, `is_relevant_role`, `work_auth_signal`, upserts by `url` (update `last_seen_at`, `description`), marks jobs unseen 30 days `active=false` (add boolean `active` default true to `jobs` via migration).
- [ ] **Step 4: Company import** CLI `companies import --source v1|openjobs|all`. Print counts. Run `all` live → expect ≥ 235 from v1 + hundreds/thousands from OpenJobs (print actual).
- [ ] **Step 5: Live scrape** `npm run scrape -- --vendors greenhouse,lever,ashby --max-companies 60` → prints counts; jobs table grows. Then `scrape.yml`: cron `0 11 * * *` (05:00 Edmonton), `npm ci`, `npm run scrape`, secrets `DATABASE_URL`, `ANTHROPIC_API_KEY`. Add secrets via `gh secret set DATABASE_URL < <(grep '^DATABASE_URL=' .env.local | cut -d= -f2-)` (and the others).
- [ ] **Step 6: Verify + commit** `npm test` PASS. Commit `feat(finders): 7 ATS adapters, filters, company import, daily scrape`; push; `gh workflow run scrape.yml` and confirm it succeeds (`gh run watch`).

---

### Task 8: Per-user ranking + Jobs UI (Posting, Fit tabs)

**Files:** `src/rank/keyword.ts`, `src/rank/rank.ts`, `cli/index.ts` (`rank --user <email>|--all --max 50`), `app/(app)/jobs/page.tsx`, `app/(app)/jobs/[id]/page.tsx` + `components/jobs/{JobList,JobFilters,PostingTab,FitTab}.tsx`, `app/api/jobs/[id]/{analyze,fit}/route.ts`, `tests/rank/keyword.test.ts`.

**Interfaces — Produces:** `keywordScore(job): number` (0–10, port of v1 `calculatePriorityScore`), `rankForUser(db, userId, {maxJobs}): Promise<{scored: number; skipped: number; costUsd: number}>` — candidate jobs = active ∧ entry-level ∧ relevant ∧ prefs-match ∧ no `job_scores` row for this user+ranker; runs `runAnalyze` if `jobs.analysis` null (shared), then `runFit`; writes `job_scores` (`ranker_version = 'fit-v1:' + modelId`) and a `keyword-v1` row; stops at budget.

- [ ] **Step 1: Test** `keywordScore` ports v1 rules (remote/Calgary +3, "new grad" +2, fresh <7d +2, etc.) — 3 cases. FAIL → implement → PASS.
- [ ] **Step 2: rank** implement + CLI; live run for the owner `--max 20` → prints scored/cost.
- [ ] **Step 3: Jobs UI** `/jobs`: table sorted by fit score (fallback keyword score), columns: score, title, company, location, work-auth badge, posted; filters (min score, remote, work-auth, vendor); "Rank more" button → POST `/api/rank` (budget-aware, returns counts). `/jobs/[id]`: tabs with Posting (description, link, company) and Fit (score, matched requirements with fact chips, gaps, rationale; button "Re-score").
- [ ] **Step 4: Verify** `npm test`, `typecheck`, `build`; dev screenshot of `/jobs` with real scored rows. Commit `feat(rank): per-user fit ranking, jobs UI`; push.

---

### Task 9: Tailor + PDF + Suggestions tabs, "mark as applied"

**Files:** `src/pdf/ResumeDocument.tsx`, `src/pdf/render.ts`, `components/jobs/{TailorTab,SuggestionsTab,HallucinationReport}.tsx`, `app/api/jobs/[id]/{tailor,suggest,pdf}/route.ts`, `app/api/applications/route.ts` (POST create), `tests/pdf/render.test.ts`.

**Interfaces — Produces:** `renderResumePdf(input: { profile: {name, email, phone, links[]}, tailor: TailorOutput, education: Fact[] }): Promise<Buffer>`; POST `/api/applications` `{jobId, tailorGenerationId}` → creates `applications` (status `applied`) + `outcome_events` `applied` now; returns id.

- [ ] **Step 1: Test** `renderResumePdf` returns a Buffer starting with `%PDF` for a minimal input. FAIL → implement react-pdf template (single column: header, summary, skills, sections with bullets; layout mirrors v1 `resume.tex` order: skills → education → experience → projects) → PASS.
- [ ] **Step 2: Tailor tab** Generate → shows summary/skills/bullets with fact-id chips; `HallucinationReport` lists unsupported claims and **blocks** them (unchecked, red) from the PDF; user can edit bullet text inline (edited bullets keep their fact ids) → Download PDF → "Mark as applied" → creates application, navigates to `/applications`. Contact fields (name/email/phone/links) come from `profiles` (add `contact jsonb` column via migration; edited in Settings).
- [ ] **Step 3: Suggestions tab** Generate → gaps (severity badges), lead-with (fact chips + why), weekend build card, likely questions, keywords to include.
- [ ] **Step 4: Verify** `npm test`, `typecheck`, `build`; live: generate tailor for one job for the owner, download PDF (size > 5 KB), mark applied → row exists. Commit `feat(tailor): tailoring, hallucination report, PDF, suggestions`; push.

---

### Task 10: Applications, outcomes, funnel

**Files:** `src/funnel/derive.ts`, `app/(app)/applications/page.tsx` + `components/applications/OutcomeButtons.tsx`, `app/api/applications/[id]/outcome/route.ts`, `app/(app)/funnel/page.tsx` + `components/funnel/FunnelChart.tsx`, `cli/index.ts` (`outcome <applicationId> <type> [--at ISO] [--notes]`), `tests/funnel/derive.test.ts`.

**Interfaces — Produces:**
```ts
export type FunnelRow = { key: string; applied: number; responded: number; interviewing: number; offers: number; rejected: number; ghosted: number; responseRate: number; interviewRate: number; responseRateCi95: [number, number] }
export function deriveFunnel(apps: {id; createdAt: Date; promptVersion: string|null; events: {type; occurredAt: Date}[]}[], opts: { groupBy: 'week'|'prompt_version'|'all' }): FunnelRow[]
```
Response = any of `response|oa|phone_screen|interview|offer`; interviewing = `phone_screen|interview|offer`; CI via Wilson interval.

- [ ] **Step 1: Test** 4 apps: 2 responded, 1 interview, 1 ghosted → `responseRate 0.5`, `interviewRate 0.25`, Wilson CI bounds within [0,1] and containing 0.5; grouping by week produces ISO week keys. FAIL → implement → PASS.
- [ ] **Step 2: UI** `/applications`: table (company, title, status, applied date, last event) with buttons: Response · OA · Phone screen · Interview · Offer · Rejected · Ghosted · Withdrawn (each POSTs an event, updates status). `/funnel`: group-by toggle, table + simple bar chart (no external chart lib; CSS bars), CI shown as text "(CI 12–41%)".
- [ ] **Step 3: Verify** `npm test`, `typecheck`, `build`; log one event via CLI and see it in the UI. Commit `feat(funnel): outcome logging, funnel with CIs`; push.

---

### Task 11: Eval harness — golden set, grading UI, runner, stats, reports

**Files:** `src/eval/stats.ts`, `src/eval/golden.ts`, `src/eval/runner.ts`, `src/eval/report.ts`, `app/(app)/evals/page.tsx`, `app/(app)/evals/grade/page.tsx` + `components/evals/Grader.tsx`, `app/api/evals/grade/route.ts`, `cli/index.ts` (`golden select --n 40`, `eval --step tailor --model <id> [--items N] [--baseline]`), `tests/eval/{stats,gate}.test.ts`.

**Interfaces — Produces:**
```ts
export function weightedKappa(a: number[], b: number[], { min: 1, max: 5, weights: 'quadratic' }): number
export function bootstrapMeanDiff(current: number[], baseline: number[], { iterations: 1000, seed: number }): { diff: number; ci95: [number, number] }
export function percentile(xs: number[], p: number): number
export async function selectGoldenItems(db, { n, step: 'tailor', userId }): Promise<string[]>   // diversity: round-robin over (vendor × remote × work_auth_signal × title-family), freezes profile_snapshot = confirmed facts
export async function runEval(db, { step, modelId, itemIds?, judgeModelId?: 'anthropic:claude-sonnet-5', baseline?: boolean, gitSha }): Promise<EvalRunSummary>
export type EvalRunSummary = { runId: string; step; modelId; n: number; meanScore: number; hallucinationRate: number; kappa: number|null; costUsd: number; p50Ms: number; p95Ms: number; vsBaseline?: { diff: number; ci95: [number, number]; baselineRunId: string } }
export function writeReports(summary: EvalRunSummary, perItem: EvalResultRow[], dir: string): { json: string; html: string }
```
Mean score = mean over items of mean of 4 judge axes. Kappa = weighted kappa between judge and human on the same axis, averaged over axes, only for items with human grades (null if < 5 graded).

- [ ] **Step 1: Stats tests** — `weightedKappa([1,2,3,4,5],[1,2,3,4,5])` → 1; vs `[5,4,3,2,1]` → < 0; `bootstrapMeanDiff([3,3,3],[3,3,3])` → diff 0, ci contains 0; seeded → deterministic. `percentile([1,2,3,4], 0.5)` → 2.5. FAIL → implement → PASS.
- [ ] **Step 2: Golden select** live: `npm run cli -- golden select --n 40` for the owner → 40 `eval_items` (print vendor/remote distribution).
- [ ] **Step 3: Grading UI** `/evals/grade` (owner): shows next ungraded item — job posting (collapsible), the current-default-model tailor output (generate on first view, cached in the item's `notes`/a `sample_generation_id` column added by migration), 4 sliders 1–5 with rubric hints, notes, Save & next; progress "12/40 graded".
- [ ] **Step 4: Runner** per item: `runTailor` with `profile_snapshot` facts → `checkCitations` → `runJudge` → `eval_results`; summary → `eval_runs` (`baseline` flag when `--baseline`); `vsBaseline` compares against latest `baseline=true` run for same step (per-item paired diffs where item ids overlap). `writeReports` → `eval-report.json` + a static HTML table.
- [ ] **Step 5: Evals page** `/evals` (owner): runs table (date, step, model, n, mean, hallucination %, kappa or "pending grades", cost, p50/p95, baseline badge), trend of mean score over time for the default model.
- [ ] **Step 6: Verify** `npm test`; live `npm run eval -- --step tailor --items 5` → summary printed, report files exist; then `--baseline` full 40 with default model. Commit `feat(eval): golden set, grading UI, runner, stats, reports`; push.

---

### Task 12: CI eval gate + demo regression PR

**Files:** `src/eval/gate.ts`, `.github/workflows/eval-gate.yml`, `tests/eval/gate.test.ts`, `docs/gate-demo.md` (+ screenshot `docs/img/gate-red.png`).

**Interfaces — Produces:** `evaluateGate(current: EvalRunSummary, thresholds: { maxHallucinationRate: 0.02 }): { pass: boolean; reasons: string[] }` — fails if `hallucinationRate > max` or (`vsBaseline` present and `ci95[1] < 0`).

- [ ] **Step 1: Test** three cases (pass; hallucination 0.05 → fail with reason; `ci95 [-0.9,-0.1]` → fail). FAIL → implement → PASS.
- [ ] **Step 2: Workflow** `eval-gate.yml`: on `pull_request` with paths `src/pipeline/**`, `src/eval/**`, `src/llm/**` → `npm ci`, `npm run eval -- --step tailor --items 20 --gate` (CLI exits 1 when gate fails, writes summary to `$GITHUB_STEP_SUMMARY` incl. cost); on `push` to `main` same paths → full 40 `--baseline`. Secrets via `gh secret set`.
- [ ] **Step 3: Demo** create branch `demo/bad-prompt`, edit `tailor.v1.md` → `tailor.v2.md` that *removes* the citation requirement; open PR (`gh pr create`); wait for the gate to fail (`gh run watch`); capture the failed check (`gh run view --log` excerpt into `docs/gate-demo.md`; screenshot via `gh api` isn't possible — save the log excerpt and the PR URL). Close the PR without merging.
- [ ] **Step 4: Verify + commit** `npm test` PASS. Commit `feat(ci): eval regression gate`; push.

---

### Task 13: Model benchmark + public /benchmark page

**Files:** `src/bench/bench.ts`, `cli/index.ts` (`bench --steps analyze,fit,tailor,suggest --models <comma list> [--items N]`), `app/(public)/benchmark/page.tsx`, `app/api/public/benchmark/route.ts`, `src/llm/defaults.ts` (update with run ids), `tests/bench/bench.test.ts`.

**Interfaces — Produces:** `runBench(db, { steps, models, itemIds? }): Promise<{ runs: EvalRunSummary[]; skipped: {modelId, reason}[] }>` — skips models whose provider is unavailable; judge fixed to sonnet-5; for `analyze`/`fit`/`suggest` the judge grades a step-specific rubric prompt (`judge_<step>.v1.md` — add prompts: analyze judged on requirement extraction completeness/precision vs. the posting; fit on rationale grounding; suggest on actionability/grounding).

- [ ] **Step 1: Test** `planBench({models:['openai:gpt-5.4-mini','anthropic:claude-haiku-4-5'], available: {openai:false, anthropic:true}})` → runs only anthropic, `skipped` lists openai with reason `missing OPENAI_API_KEY`. FAIL → implement → PASS.
- [ ] **Step 2: Live bench** `npm run bench -- --steps tailor,fit --models anthropic:claude-haiku-4-5,anthropic:claude-sonnet-5,google:gemini-3.7-flash,google:gemini-2.5-flash-lite --items 40` (openai skipped). Print table. Update `defaults.ts` per step to the best quality-per-dollar winner with a comment `// chosen by eval_run <id> on 2026-08-xx`.
- [ ] **Step 3: Public page** `/benchmark`: per step a table (model, mean score ± CI, hallucination %, $/item, p50 ms, n, date), methodology section (judge model, prompt versions, caveat that judge is an Anthropic model), "last updated". Data from `eval_runs` (latest per step×model). Cached 1h.
- [ ] **Step 4: Verify** `npm test`, `build`; page renders with real rows. Commit `feat(bench): multi-model benchmark, public page`; push.

---

### Task 14: Public /results, landing page

**Files:** `app/(public)/page.tsx`, `app/(public)/results/page.tsx`, `app/api/public/results/route.ts`, `src/funnel/redact.ts`, `tests/funnel/redact.test.ts`.

- [ ] **Step 1: Test** `redactCompanies([{company:'Stripe'},{company:'Stripe'},{company:'Shopify'}])` → `Company #1, Company #1, Company #2`. FAIL → implement → PASS.
- [ ] **Step 2: Results page** owner's funnel (weekly + by prompt version, CIs), latest baseline eval scorecard (hallucination %, kappa or "pending"), latest gate run status, the benchmark headline row; no company names, no job titles beyond role family.
- [ ] **Step 3: Landing** one screen: what it is (3 bullets in plain English), links to `/results`, `/benchmark`, GitHub, and "Sign in (invite only)".
- [ ] **Step 4: Verify** `build`; both pages 200 unauthenticated. Commit `feat(public): results + landing`; push.

---

### Task 15: Apply agent CLI (fast path + tool loop + approvals) + Dockerfile

**Files:** `src/agent/ats-fastpath.ts`, `src/agent/tool-loop.ts`, `src/agent/run.ts`, `cli/index.ts` (`apply <applicationId> [--dry-run] [--headless]`), `app/(app)/applications/page.tsx` (pending approvals panel), `Dockerfile`, `tests/agent/fastpath.test.ts`.

**Interfaces — Produces:** `detectAts(url): 'greenhouse'|'lever'|'ashby'|'generic'`; `fillFastPath(page, ats, data: ApplicantData): Promise<{filled: string[]; remaining: string[]}>`; `runToolLoop(page, { job, data, resumePath, maxSteps: 35, onConfirm })`; `applyToApplication(db, id, { dryRun, headless })` → status `applied|skipped|failed|needs_manual`. `ApplicantData` is built from `profiles.contact` + prefs (work auth answers) — never from source constants. Confirmation: screenshot → `approvals` row (`pending`) → terminal `y/N`; `y` → `approved` + continue; else `declined` + skip. Reads model guidance from the claude-api skill README before writing the Anthropic SDK loop (tool definitions ported from v1 `apply-agent.ts`: `get_page_structure, click_element, fill_input, select_option, upload_file, scroll_page, navigate_to, wait_for_page, request_user_confirmation, mark_done`; model `claude-sonnet-5`).

- [ ] **Step 1: Test** `detectAts` for 4 URL shapes; `fillFastPath` unit test with a fake `page` object recording `fill` calls for Greenhouse selectors. FAIL → implement (port selectors from v1 `apply-now.ts` handlers `applyGreenhouse/applyLever/applyAshby`; strip `ME`, canned essays, cover-letter path) → PASS.
- [ ] **Step 2: Tool loop** port from v1 `lib/agent/apply-agent.ts`; `launchPersistentContext(~/.applyops/browser/<ats>)`; `--dry-run` auto-declines at confirmation.
- [ ] **Step 3: Dockerfile** `mcr.microsoft.com/playwright:v<matching>-jammy` base, `npm ci`, entrypoint `npm run cli`. `docker build` must succeed if Docker Desktop is running (`open -a Docker`); if not, record that in the task report.
- [ ] **Step 4: Verify** `npm test`; `npm run cli -- apply <id> --dry-run` on a Greenhouse job opens the browser, fills, screenshots, declines. Commit `feat(agent): apply agent with deterministic fast path and approval gate`; push.

---

### Task 16: README, USER_TODO, Vercel deploy, final verification

**Files:** `README.md`, `docs/USER_TODO.md`, `docs/img/*` (dashboard screenshots via Playwright script `scripts/screenshots.ts`), Vercel project.

- [ ] **Step 1: Deploy** `vercel link --yes --project applyops` (create if absent), `vercel env add` for each var in `.env.local` (production + preview; never echo values: `grep '^VAR=' .env.local | cut -d= -f2- | vercel env add VAR production`), `vercel --prod` → URL. Set Supabase Auth redirect URL to the Vercel URL via the management API if the CLI supports it; else add to USER_TODO.
- [ ] **Step 2: README** in spec §14 order with real numbers pulled from the latest baseline run and benchmark (a script `scripts/readme-stats.ts` prints them; paste). Include the gate-demo log excerpt, architecture diagram (mermaid), "what this deliberately does not do", and run-it-yourself.
- [ ] **Step 3: USER_TODO.md** — exactly: (1) grade 40 items at `/evals/grade`; (2) add `OPENAI_API_KEY` to `.env.local`, Vercel, and GitHub secrets, then `npm run bench` to fill OpenAI rows; (3) confirm magic-link email arrives (check spam); (4) invite users at `/settings/admin`; (5) anything from Step 1 that needed the dashboard.
- [ ] **Step 4: Final verification** `npm run typecheck && npm test && npm run build`; `gh run list --limit 5` all green; curl production `/`, `/results`, `/benchmark` → 200; `/jobs` → 302. Commit `docs: README, user todo`; push.

---

## Self-review (done at write time)

- Spec coverage: §2 auth/roles → T3; §3 architecture → T1/T4; §4 data → T2 (+ small migrations in T7 `active`, T9 `contact`, T11 `sample_generation_id`); §5 pipeline → T5; §6 finders → T7; §7 eval/CI → T11/T12; §8 bench → T13; §9 web → T3/T6/T8/T9/T10/T14; §10 agent → T15; §11 cost → T4/T6; §12 deploy → T1/T7/T12/T16; §13 errors → T4/T7/T9/T15; §14 README → T16; §15 owner tasks → T16.
- Type consistency: `Fact`, `TailorOutput`, `EvalRunSummary`, `ModelId`, `RawJob` defined once (T4/T5/T7/T11) and reused by name elsewhere.
