# Project Ideas — Portfolio Showpiece + Job-Search Weapon

**Date:** 2026-08-27
**Goal:** Land a full-time software job (Canadian citizen; Canada / US relocation / remote all fine) after graduating Dec 2026.
**Target lane:** AI product engineer — full-stack + real AI/ML depth.
**Constraint:** A live, demo-able v1 in ~1 week of AI-assisted building, then ongoing iteration.
**Bonus goal:** The project should *directly help the job search*, not just decorate it.

---

## 0. TL;DR

**Build ApplyOps first — jobhelper v2, rebuilt as an instrumented, eval-gated application pipeline in a fresh public repo, with `apply-agent.ts` ported in as the headline feature.** Start this week. Then Guardian (weeks 2–3) while outcome labels accumulate.

Why this one wins the tiebreak: **it's the only idea whose evidence expires.** New-grad season is open *now*. Every application sent before the outcome funnel exists is a label destroyed forever — by mid-September that's 50+ unrecoverable data points. It's also the cheapest week in the pool, because the hard part (a working Claude tool-use + Playwright agent with a human-confirmation gate, working API scrapers, a capable tailoring pipeline, a year of seed data) already exists; the whole week goes into the one layer the audit found completely missing: **measurement**.

The line a hiring manager repeats to a colleague:

> "He instrumented his own job search like a production LLM system — his CI actually fails the build when the resume-tailoring prompt's hallucination rate regresses, and the results page is his real, dated interview funnel with confidence intervals on it."

The narrative that can't be faked: *v1 got a Mercor contract and an AMD interview → realized I couldn't tell whether it was any good → rebuilt it so I could prove it.*

---

## 1. What "good" means (the bar every idea was judged against)

Since AI makes code volume cheap, a 2026 portfolio project is impressive only for reasons that are **hard to fake**:

| # | Criterion | What it means in practice |
|---|-----------|---------------------------|
| 1 | **Portfolio signal** | An AI-product hiring manager is impressed in 30s, and *more* impressed after 10 min in the README/code |
| 2 | **Hard to fake** | A real technical core, measured results (evals, benchmarks, CIs), real users/data — not "CRUD + chat box", not generic RAG, not a thin wrapper |
| 3 | **Buildable** | Live, demo-able v1 in ~1 week; obvious roadmap for depth |
| 4 | **Interesting** | You'd genuinely want to build it and talk about it |
| 5 | **Fit** | Leans on full-stack + AI/ML + data science; doesn't hinge on pixel-perfect frontend |
| 6 | **Differentiated** | Not what every other 2026 new grad ships |
| 7 | **Job-search leverage** | Helps you get hired beyond being a line on the resume |

**Anti-patterns that actively hurt in 2026:** mass auto-apply bots (ToS violations, ATS platforms flag them, and they look *bad* to hiring managers), "X but with AI", a README that opens with a dashboard screenshot instead of a number.

---

## 2. Final ranking — top 8 (after collapsing ~28 ideas into distinct projects)

### #1 ApplyOps — jobhelper v2 as an instrumented, eval-gated application system

**One-liner:** One pipeline where the eval harness and the outcome funnel are the same system: a golden eval set, an LLM judge calibrated against your own hand-grades (reported kappa), a *mechanical* hallucination check, a CI gate that fails the build on regression, and a real Fall-2026 funnel (applied → response → interview → offer) tagged to the exact prompt/ranker version that produced each application.

**Why it's impressive / hard to fake:** A screenshot of your own CI failing red — "hallucination rate 1.2% → 6.4%, blocking merge" — is something no new-grad portfolio has. The funnel is dated, real, and honest about small n (bootstrap CIs). Reframes "resume bot" as reliability engineering.

**Technical core:**
- *Ingest* — existing Greenhouse/Lever/YC API scrapers, unchanged, on a scheduled worker.
- *Rank* — fit scorer as an *evaluated* component: week 1 an embedding + LLM ensemble reporting precision@10 vs. the old keyword scorer on held-out weeks, with a calibration curve; month 3 a fine-tune once labels justify it (see FitSignal below).
- *Generate* — the existing deep tailoring path (JD analysis → clarifying questions → project selection → LaTeX PDF), now wrapped in: a 40–60 item golden set, an LLM judge calibrated to your grades (Cohen's kappa), a **source-of-truth facts file** where every generated claim must cite a fact id ("1.8% of generated claims had no traceable fact id" — a number any stranger can re-derive from the repo), and a GitHub Action that fails past a threshold.
- *Act & measure* — the kept `apply-agent.ts` (Claude tool-use + Playwright, human-confirmation gate before submit) writing `outcome_events` with timestamps.

**Measurable results in the README:** judge-vs-human kappa; hallucination rate (untraceable-claim %); $ and tokens per tailored application; p50/p95 latency; ranker precision@10 vs. baseline; the funnel by week and by `prompt_version` with CIs; one screenshot of a CI run that failed and why.

**Biggest risk:** From ten feet away it looks like a job tracker. **The README must open with the eval scorecard and the kappa number, never the dashboard.** Secondary: outcome logging needs 8+ weeks of discipline — stop logging in week 3 and the results section evaporates.

**Week-1 plan (day by day):**
- **Day 1** — New public repo with real commit history. Postgres (Supabase) schema: `companies, jobs, applications, outcome_events, prompt_versions, ranker_versions, generations, eval_items, eval_runs`. Import the 211 jobs / 7 applications with real dates as seed. Move hardcoded PII out of `scripts/apply-now.ts` into a profile record + env.
- **Day 2** — Port `lib/agent/apply-agent.ts` unchanged into `agent/`, containerize it (Fly/Railway), document plainly why a 35-step Chromium agent cannot run in a Vercel function. Scrapers behind a scheduled worker.
- **Day 3 (unskippable manual day)** — Build the 40-item golden set from real past applications; hand-grade each on a 4-axis rubric: factual grounding, requirement coverage, specificity, keyword-stuffing penalty.
- **Day 4** — `npm run eval`: run the current tailoring prompt over all 40, judge scores them, report judge-vs-you kappa + hallucination rate. GitHub Action fails the build past threshold.
- **Day 5** — Deploy the funnel dashboard (by week, by prompt_version, bootstrap CIs). **Start logging every real application from that day forward.**

**Roadmap:** weeks 2–4 retrain ranker weekly as labels arrive, hallucination guardrail becomes a hard pre-send blocker, GitHub Action comments the eval diff on prompt-touching PRs. Month 2: MCP server (`search_my_projects`, `match_job_to_experience`) as a read-only view over the same Postgres (~2 days; lets Claude Desktop query your career data live in an interview). Month 2–3: durable cross-session agent state (resume a half-finished Workday app, remember per-company answers). Month 3: FitSignal fine-tune as the ranker upgrade; screener-simulator module (see Resume Arena). Extract the CI gate as an open-source `prompt-eval-ci` package *after* it has caught real regressions.

**Demo moment:** Change a prompt, push, watch CI go red with the reason, revert, watch it go green. Then the live funnel.

**Job-search leverage:** Maximal and immediate — it *is* the machine sending your applications this fall.

---

### #2 Guardian — production support agent on cydsoccer.com, instrumented like production software

**One-liner:** A parent/player support agent live on the academy's real channel, retrieval-grounded over the real Supabase (schedule, programs, registration status), strictly read-only, hard-routing anything about money/safety to a human — with a public grading dashboard tracking accuracy, escalation precision/recall, policy-violation rate (target: zero), cost per conversation and latency.

**Why it's hard to fake:** Requires an actual business with actual customers and actual liability. The only idea *all three* junior judges put in their top 5 (hidden by a scoring bug). Sits exactly on your stack; a chat widget carries almost no frontend risk.

**Biggest risk:** "Support chatbot" is the most clichéd category at first glance, and a one-location academy has low message volume. It rests entirely on the rigor numbers — regression suite, escalation confusion matrix, zero violations — being front and center.

**Week-1 plan:** Day 1 export ~300 real historical parent messages, hand-label 50 into a regression set (correct answer + correct escalate/don't flag). Day 2 read-only retrieval tools over live Supabase + policy docs. Day 3 the agent + a cheap second-model guardrail pass that blocks any financial/safety commitment. Day 4 run the regression offline and publish the numbers *before* anything goes live. Day 5 ship the widget on the read-only slice + grading dashboard + nightly regression cron.

**Improvement:** Publish the regression suite and the live dashboard publicly (PII-redacted) so a stranger can *check* the numbers — converts "I run a business" from an unverifiable flex into auditable evidence.

**Roadmap:** expand to write actions (reschedule) once read-only accuracy is proven; WhatsApp/SMS via Twilio; A/B two models on the same real traffic; anonymized case-study write-up. Agent Red Team (#5) becomes its guardrail layer for free.

**Demo moment:** Ask a real scheduling question → correct grounded answer in ~2s. Ask for a refund → it declines and escalates. Flip to the dashboard: that exact conversation logged with a green "escalated correctly."

---

### #3 Academy Pulse — churn prediction → outreach → measured dollars (CP-SAT scheduling deferred)

**One-liner:** Consolidate 1–2 real seasons of enrollment, attendance and payment data into a clean star schema, train a time-split XGBoost churn model backtested against last season's real non-renewals (PR-AUC vs. an attendance-only baseline, calibration curve, SHAP), and surface this week's top-15 at-risk families with a Claude-drafted, coach-edited, human-sent message.

**Why:** This is where your real supervised-ML story lives — hundreds of families across seasons is ~two orders of magnitude more labels than your job search will ever produce, on a schedule you control. Ends in a sentence a hiring manager repeats: "he retained $X of real recurring revenue."

**Biggest risk:** Churn-on-tabular is the most tutorial-shaped subject in the pool; a shallow telling reads as Kaggle with a nicer dataset. Causal risk: a non-randomized rollout at n≈low hundreds cannot support a clean lift claim — oversell it and it inverts into a judgment red flag.

**Week-1 plan:** Days 1–2 the unglamorous load-bearing part — consolidate spreadsheets/Stripe/Supabase into Postgres with a written data dictionary (say plainly in the README that *this* was the engineering). Day 3 features: attendance-decay slope, days since last session, payment lateness, tenure, sibling enrollment, proximity to tier transition, season boundary. Day 4 XGBoost, time-respecting split, backtest, PR-AUC/calibration/SHAP. Day 5 internal dashboard + drafted outreach.

**Improvement:** Choose the intervention threshold by expected dollars (P(churn) × monthly fee × months remaining vs. outreach cost), not F1 — and **log a matched non-contacted comparison group from day one**, or you arrive in November with a model and no way to say it did anything.

---

### #4 BlastRadius — PR regression-risk scoring from real defect history (LLM as explainer only)

**One-liner:** A GitHub App that scores every PR's regression risk with a gradient-boosted model trained on real bug-fixing history (PyDriller + SZZ-lite; features: churn, complexity delta, file bug density, distinct recent authors, tests touched), backtested with top-decile lift — and Claude explains the score in plain English on the PR.

**Why:** Best demo mechanic in the pool: **install it on the interviewer's own repo during the call and score one of their real PRs.** The positioning is a genuine idea — classical ML does the scoring, the LLM is demoted to last-mile explanation — which is the taste distinction between ML judgment and wrapper work. Only top-8 entry a stranger installs and uses.

**Biggest risk:** Noisy weak-supervision labels, and the sharper danger that the feature set fails to beat "big diffs are risky." You won't know which world you're in until day 3.

**Week-1 plan:** Day 1 mine 6–8 mature public repos + your own; label bug-fix commits (linked issues + conventional-commit prefixes); hand-check 100 labels and publish the labeler's precision. Day 2 SZZ-lite blame to inducing commits; per-file features. Day 3 XGBoost, time split; AUC + top-decile lift vs. **two baselines** (lines-changed-only, files-changed-only). Day 4 FastAPI webhook GitHub App posting a risk comment; Claude explains from top SHAP factors. Day 5 install on 2–3 live repos; landing page leads with the backtest chart; rehearse the live install.

**Improvement:** Put lift-vs-lines-changed-only in the README's first table. If the naive baseline wins, publishing that honestly is a better signal than a hidden victory.

---

### #5 Agent Red Team — tool-use injection & guardrail benchmark

**One-liner:** A sandboxed agent with mocked email/calendar/payments tools, a self-built corpus of 50–150 injection/exfiltration attacks across 5 categories **plus a 50-item benign control set**, and 4 defense layers (instruction hierarchy, trusted/untrusted tagging, tool-call classifier gate, human confirmation) — benchmarked as attack-success-rate *and* false-positive-rate per layer, with latency/cost.

**Why:** Never scored by the juniors (data hole) but genuinely top-tier: the **only idea with zero external dependencies** — no GPU, no users, no waiting for labels, no consent, no business volume. The most reliably week-1-shippable thing here. Prompt injection / tool-use safety is the most senior-signaling topic in 2026 AI product engineering.

**Biggest risk:** Crowded research space (AgentDojo, InjecAgent, lab red-team work) — a novelty claim gets shot down instantly; lead with the running artifact and numbers. A 10-attack version looks like a weekend toy; the corpus is the load-bearing effort.

**Week-1 plan:** Day 1 deterministic sandboxed mock tool surface (never real Gmail). Day 2 50 attacks × 5 categories + 50 benign. Day 3 four defense layers. Day 4 full matrix (none / each / combined) × (attacks, benign) → ASR, FPR, latency, cost. Day 5 results table, repo, 20-second screen recording of the exfiltration being blocked.

**Improvement:** **Lead with the false-positive rate on benign traffic.** Everyone publishes attack-block rate; almost nobody publishes what guardrails cost in broken legitimate requests — that trade-off curve is the number a production team actually decides with.

---

### #6 PitchIQ — single-drill soccer computer vision, coach-calibrated

**One-liner:** Point a phone at one player doing one drill (juggling / wall-pass touches); an async upload → queue → GPU → annotated-overlay pipeline counts reps and scores touch quality; accuracy reported against hand-counted ground truth, and the CV score validated against independent coach ratings (Spearman r).

**Why:** The most memorable, least replicable thing you can build — nobody else in the 2026 flood owns proprietary footage of real kids at an academy they operate. It's the line that survives the debrief three days later.

**Biggest risk:** Scope creep back into the full soccer-CV fantasy. The moment a second player enters the frame you've bought the multi-week multi-player tracking + re-ID + occlusion problem. Filming minors needs the consent story explicit, not a footnote.

**Week-1 plan:** **Day 0, non-negotiable:** get a coach to hand-rate 20 real clips on the touch-quality rubric *before any CV code exists.* Days 1–2 YOLO ball detection + periodicity state machine for rep counting (heuristics first, ML as upgrade). Day 3 accuracy vs. hand counts on the 20 clips with an honest failure breakdown (blur, ball out of frame, lighting). Day 4 the real async pipeline (Modal/RunPod). Day 5 per-player trend across sessions + coach-rating scatter; consent + face-blurring documented in the README as an engineering constraint.

**Stretch (never week 1):** on-device/in-browser inference (the "Touchline" variant).

---

### #7 New Grad Radar — ghost-posting & work-authorization signal, built for Canadians

**One-liner:** A public dashboard that cross-references scraped new-grad postings against government disclosure data and repost/ghosting patterns — reframed around **TN / "will this company take a Canadian"** rather than H-1B, because that's the question you actually have and nothing on the market answers it well.

**Why:** The only idea with a realistic path to *strangers* using it within weeks — post it in Canadian CS Discords/subreddits and you get an externally verifiable usage number nothing else here produces. The fuzzy join between messy scraped employer names and government filings is real, defensible data engineering; it reuses your existing scraping pipeline; and it tells you which of your own applications are worth sending.

**Biggest risk:** Least AI/ML-heavy idea in the top 8, and both headline signals are ground-truth-free. A confident bad match could steer someone's job search wrong — conservative thresholds, every flag shows its reasons, "as of <disclosure date>" stamps everywhere.

**Week-1 plan:** Days 1–2 ingest one quarter of H-1B LCA + current LMIA employer list; fuzzy-match against the ~190 companies in your allow-lists; hand-validate 100 matches and publish match precision. Day 3 the Canadian-specific signal: parse posting text for work-auth language → "hires Canadians / TN-friendly / requires existing US auth / unclear" with confidence. Day 4 repost/ghost signals from your own scrape-history timestamps, surfaced as explicit reasons. Day 5 public read-only dashboard honestly scoped to those 190 companies; post it; instrument visits/lookups.

---

### #8 Resume Arena — ATS-gaming robustness leaderboard (demographic-bias track demoted to appendix)

**One-liner:** Pre-registered, matched-pair experiments holding resume substance byte-identical while varying only gaming tricks (invisible keyword stuffing, keyword-repeat blocks, verbatim JD mirroring, formatting exploits), batch-run across 4 cheap-tier models, Bradley-Terry ranked with bootstrap CIs on "points gained from gaming alone."

**Why:** The most direct extension of paid work you've actually done (Mercor / LLM-output evaluation). Pure API calls — no GPU, no dataset, no users — genuinely ships in a week. Immediately actionable for every job seeker who reads it.

**Why #8 not higher:** The demographic-bias half is already covered by much larger 2026 studies (14 models × 24k pairs; a 33k-job industrial audit) — a solo run of a few thousand calls is an underpowered replication whose honest outcome is "consistent with prior work, wide CIs." The surviving half (gaming robustness) has thin prior art and is best built as an **ApplyOps module** ("how much would stuffing move *your* tailored resume, and should you?").

**Week-1 plan:** Day 1 publish the pre-registration (hypotheses, variables, sample size, threshold) before a single API call. Day 2 20 base resumes + perturbation engine. Days 3–4 batch runs, Bradley-Terry + bootstrap. Day 5 leaderboard with methodology first, CIs always visible; run your own resume through it and publish what happened.

---

## 3. The existing tool (jobhelper) — audit and verdict

### What it actually is (from reading the code)
Next.js 14 App Router "power tool" over a **CSV-backed** job list. API-first scraping (Greenhouse/Lever/YC-Algolia; Playwright fallbacks for Wellfound/BuiltIn/Indeed/LinkedIn with hard caps) → hand-written keyword/regex entry-level filter + 0–10 priority score → "Tailor" (Claude summary + skill reorder) and a deeper path (`calculate-match-score → get-project-questions → tailor-with-answers`) → LaTeX PDF. The standout is **`lib/agent/apply-agent.ts`**: a genuine Claude tool-use + Playwright loop (`get_page_structure / click / fill / select / upload_file / navigate / wait / request_user_confirmation / mark_done`) that fills Greenhouse/Lever/Workday forms and **pauses for human confirmation before any submit**. Real usage: `data/applications.csv` logs 7 real tailored applications (incl. AMD) against 211 scraped jobs.

### Strengths
1. It's real and it worked (Mercor contract, AMD interview).
2. `apply-agent.ts` is legitimately non-trivial agent engineering with a hard human gate.
3. Correct architectural judgment: prefer stable APIs over scraping; treat LinkedIn as last resort. The human-in-the-loop / no-auto-submit posture is *exactly* what the 2026 market now rewards.
4. The deeper tailoring path is more capable than the README admits.

### Weaknesses
1. **No measurement layer at all.** "Success metrics" are aspirational text — nothing computes a funnel, versions a prompt, or logs outcomes. This is the biggest gap against the 2026 bar.
2. CSV datastore with an acknowledged concurrent-write race; keyword/regex scoring learns from nothing; the documented Supabase migration and GitHub Actions cron were **never built**.
3. Incoherent deployment story: Vercel is the stated host, but the differentiator (a 35-step Playwright agent launching real Chromium) can't run in a Vercel function and only ever ran locally.
4. Two squashed commits — no visible engineering trail.
5. Hardcoded PII in `scripts/apply-now.ts`.
6. 100% private → zero portfolio value until something is public, live, and safe to show.
7. The scraper-volume work the docs are proudest of ("+300% jobs/day") is exactly what AI coding agents made cheap — effort, not differentiation.

### Verdict: **continue from jobhelper's assets, but restart the repository**
Rebuilding from zero throws away your only moat (the agent loop) and your only track record. Continuing in place inherits a history that reads as careless or aspirational. → New public repo with real commit history; port the keepers as early commits, PII stripped; every claimed number produced by a script that lives in the repo.

**KEEP (port as-is):**
- `lib/agent/apply-agent.ts` in full — promote to headline feature.
- The never-auto-submit principle (CLAUDE.md + README anti-patterns) — foreground it, tied to 2026 ATS platforms banning automated submissions.
- Tier-1 API scrapers + ~190-company allow-list + "LinkedIn only if desperate" policy.
- The deep tailoring path — it becomes *the system under evaluation*.
- LaTeX/pdflatex PDF generation.
- `data/jobs.csv` (211) and `data/applications.csv` (7, incl. AMD) as seed rows with real dates.

**REPLACE:**
- CSV → Postgres with an outcomes schema (`companies, jobs, applications, outcome_events, prompt_versions, ranker_versions, generations, eval_items, eval_runs`).
- Keyword/regex scorer → an *evaluated* scorer (embedding + LLM ensemble, precision@10 vs. old heuristic, calibration; learned from labels later).
- Vercel-as-everything → Vercel (dashboard/API) + Fly/Railway container (Playwright agent + scheduled scrape) + GitHub Actions (eval CI).
- The absent measurement layer → instrumented code (the whole point).
- Squashed history → fresh commit-by-commit public repo.
- Hardcoded PII → profile record + env (prerequisite for going public).
- Every aspirational doc claim → claims a reader can verify by running a script. Drop the scraping-volume narrative entirely.

---

## 4. Suggested sequencing (one semester)

| When | Build | Why then |
|------|-------|----------|
| **Week 1 (now)** | **ApplyOps** v1 — schema, eval harness, CI gate, funnel, start logging | Evidence expires; labels start accumulating while you build everything else |
| Weeks 2–3 | **Guardian** on cydsoccer.com | Real-business credibility tier; its guardrail work feeds Agent Red Team |
| Weeks 4–5 | **Agent Red Team** *or* **BlastRadius** | Red Team: zero dependencies, closes the "citable benchmark" gap. BlastRadius: the live-install demo aimed at EMs |
| Month 2 | **Academy Pulse** (needs data consolidation first) | Your real supervised-ML story; needs a comparison group logged early |
| Month 2–3 | ApplyOps upgrades: MCP server, durable agent state, FitSignal fine-tune (only if labels justify it), Resume Arena module | Depth on the flagship as real outcome data arrives |
| Anytime, shareable | **New Grad Radar** (TN-framed) | Only path to stranger-usage numbers; post in Canadian CS communities |
| Only if targeting ML-infra later | wgsl-llm | Hardest-to-fake artifact in the pool, but 2–3 weeks and the wrong lane for now |

Rule of thumb from the judging: **one flagship with measured results beats three half-instrumented projects.** ApplyOps + Guardian + one of {Red Team, BlastRadius, Academy Pulse} is a complete, coherent AI-product-engineer portfolio.

---

## 5. Ideas considered and cut (so nothing is silently dropped)

| Idea | Why cut / where it went |
|------|-------------------------|
| **FitSignal** (LoRA fit-scorer beating frontier) | Wrong as a week-1 project: ~7 applications, ~1 positive label; "got an interview" is dominated by unobservable causes (referrals, headcount, timing, work auth); distilling frontier rationales then benchmarking against the same frontier is circular. → **ApplyOps month-3 ranker upgrade.** |
| **HireSight** (demographic-bias audit of AI screeners) | Underpowered vs. published 2026 studies. Its matched-pair design + pre-registration discipline → folded into Resume Arena. Never build both. |
| **Job Search MCP** | Great 2-day module, not a project → ApplyOps month 2. The fill-never-submit extension is the one piece that can produce external installs. |
| **PromptDrift** (model-migration regression tester) | promptfoo/DeepEval/Giskard/Braintrust already own the shelf; with no dogfooded findings it's vaporware. Its statistical core (bootstrap CIs on per-example deltas) → the ApplyOps CI gate. Extract as open-source *after* it catches real regressions. |
| **PitchLens / PlayerArc / Touchline** | Multi-player tracking + re-ID + youth-pose domain adaptation is the hidden multi-week subproblem. Single-player drill (PitchIQ) deletes it. Borrow: coach-rating correlation, metrics table above the fold, consent docs. On-device = stretch. |
| **ChurnGuard / PlacementIQ** | Academy Pulse strictly dominates ChurnGuard (closed predict→act→measure loop). PlacementIQ ranks which tier a real child lands in — heavy subject matter, labels are prior staff judgment, depends on a registration cycle. Borrow: "$ retained" framing, SHAP as a finding, accept/override logging. |
| **Bar Raiser / RecallOS / Interview Loop** | One idea wearing three names; all flex the same judge-calibration muscle ApplyOps already flexes. RecallOS/Interview Loop's headline artifact (retention curve) doesn't exist until weeks of daily use. Keep as a personal habit, not the portfolio slot. |
| **SidelineOps** | Same as Guardian, different channel. Borrow: approval-queue UI with draft-vs-sent edit distance as a free quality metric; risk-tier ladder for earning autonomy. |
| **Outcome-gated FSRS content pipeline** | Interesting but slow-evidence (needs learner outcomes to accumulate) and off the job-search axis. |
| **Batchline** (Go inference server) | Racing vLLM/SGLang solo; needs GPU for meaningful numbers; wrong lane. |
| **Aire** (in-browser Spanish voice tutor) | Small on-device models will visibly underperform live. |
| **Fieldbook** (offline-first coaching app) | A Yjs integration with no AI component, against an AI-product target. |
| **wgsl-llm** | Hardest-to-fake artifact here, but 2–3 weeks of brutal shader debugging and it lands in ML-infra, not where you're applying. Good second/third project for optionality. |

---

## 6. Decisions I need from you

1. **Pick the first build.** Recommendation is ApplyOps; Guardian and Academy Pulse are close behind and their evidence keeps. Or disagree and pick something else from the eight.
2. **Public repo + your real funnel numbers:** are you comfortable publishing your own (anonymized-company) application outcomes? The results section is the pitch; if not, we design a redacted public view from day 1.
3. **Hosting for the Playwright agent:** Fly.io vs. Railway vs. a small VPS you already have — do you have an account/preference?
4. **The unskippable manual day (hand-grading 40 past applications):** confirm you'll do it in week 1 — the kappa number depends on it.
5. **For Guardian later:** are you willing to put a read-only AI agent in front of real parents on cydsoccer.com, and do you have historical parent messages exportable (email? WhatsApp? form submissions)?
6. **For PitchIQ/Academy Pulse later:** consent status for training footage of minors; where enrollment/attendance/payment data actually lives today (Stripe? Supabase? spreadsheets?).

---

*How this doc was produced: 28 ideas generated across 5 lenses (LLM-engineering rigor, ML depth, unfair advantage via the academy, systems-AI, wow-product, plus a code audit of jobhelper), scored by 3 independent junior judges (hiring manager / skeptical engineer / novelty critic), then collapsed, re-ranked and argued over by a senior judge with explicit dissent. Final synthesis and recommendation are mine.*
