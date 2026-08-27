# The eval gate, demonstrated

Spec §7 claims the system "refuses to get worse". This page is the receipt: a
pull request that made the tailoring prompt measurably worse, and the CI check
that blocked it.

- **Pull request:** <https://github.com/VVarrior1/applyops/pull/1> — *Tailor
  prompt v2: punchier, keyword-matched bullets* (`demo/bad-prompt` → `task/12`)
- **Failed check:** <https://github.com/VVarrior1/applyops/actions/runs/33105013077>
- **Eval run:** `3dbeedc5-1b8f-4ac3-9b6b-5d81a5dcddc8` · 20 items · $0.29
- **Verdict:** ❌ FAIL — exit code 1, PR blocked
- **Outcome:** closed without merging

![The eval gate failing the demo pull request](img/gate-red.png)

## The change

`src/pipeline/prompts/tailor.v2.md` rewrote the tailoring prompt in a way that
reads like an improvement in code review. It asks for punchier bullets, tells
the model to mirror the posting's stack, and — the actual damage — relaxes the
evidence rule:

```diff
-1. **Every bullet must cite at least one fact label** in its `fact_ids`, and
-   every cited label must appear verbatim in the fact list.
-2. **Never invent employers, job titles, dates, team sizes, metrics or
-   technologies.**
+1. `fact_ids` is optional. Fill it in when a bullet maps cleanly onto a single
+   labelled fact; leave it as an empty array when the bullet is your own
+   synthesis […]
+2. Numbers sell. If a fact has no metric, supply a credible one — throughput,
+   user counts, latency reductions, percentages.
```

Nothing about that diff is obviously wrong on a screen. It is exactly the kind
of change a gate has to catch, because a human reviewer will not.

## What the gate did

The change touches `src/pipeline/**`, so `.github/workflows/eval-gate.yml`
fired, re-ran 20 items of the frozen golden set against the same fixed judge
model, and compared the mean judge score with the current baseline run
(`5e2f10ce`, 40 items, mean 4.87) on the items the two share.

The run's mean judge score was **4.00**; the baseline (`5e2f10ce`, 40 items,
mean 4.87) scored **0.89 higher** on the twenty items the two share. The
bootstrap 95% CI of that delta was **[-1.14, -0.64]** — entirely below zero, so
the drop is not noise.

### Job-summary excerpt

```
| step               | tailor                      |
| model              | google:gemini-3.7-flash     |
| mean judge score   | 4.00 / 5                    |
| hallucination rate | 0.00%                       |
| items scored       | 20                          |
| cost               | $0.2905 ($0.0145/item)      |

✅ hallucination — Hallucination rate 0.00% is within the 2.00% ceiling.
❌ regression    — Mean judge score regressed against baseline 5e2f10ce…:
                   diff -0.89, 95% CI [-1.14, -0.64] lies entirely below 0.
✅ failed_items  — All 20 attempted items produced a graded result.
✅ coverage      — 20 items scored.
```

### Workflow log excerpt

Trimmed from `gh run view 33105013077 --log`; the per-item table is the run's
own output.

```
2026-08-27T18:45:29Z Evaluating step "tailor" with google:gemini-3.7-flash (judge: google:gemini-3.7-flash)
2026-08-27T18:45:43Z   [ 1/20]   4.25  Data Engineer, RBC Amplify 2026, Calgary
2026-08-27T18:45:48Z   [ 2/20]   4.50  Intern, AI Experiences (Winter 2026)
2026-08-27T18:45:42Z   [ 3/20]   3.50  Strategic Finance & Analytics Intern (MBA)
2026-08-27T18:46:13Z   [ 4/20]   3.75  News Writer
2026-08-27T18:45:54Z   [ 5/20]   5.00  Dropbox
2026-08-27T18:46:01Z   [ 6/20]   3.00  Engineering Student Co-op (12-16 month term)
                                       … 14 more …
2026-08-27T18:47:18Z   [19/20]   4.50  Backend Engineer - Platform Developer Experience
2026-08-27T18:47:02Z   [20/20]   4.00  Co-op/Intern, DevOps - Summer 2026

mean  G  C  S  St  halluc     ms  item
4.25  2  5  5   5     0/9   7959  Data Engineer, RBC Amplify 2026, Calgary — RBC
3.00  2  3  4   3     0/9   8148  Engineering Student Co-op (12-16 month term) — gibson
3.00  2  4  4   2     0/8   6423  Backend Engineer - Data Infrastructure — Spotify
                                  … 17 more …

Run 3dbeedc5-1b8f-4ac3-9b6b-5d81a5dcddc8
  step             tailor
  model            google:gemini-3.7-flash
  judge            google:gemini-3.7-flash
  items            20 scored
  mean score       4.00 / 5
  hallucination    0.00%
  cost             $0.29 ($0.01/item)
  latency          p50 7095 ms · p95 13641 ms
  vs baseline      -0.89  95% CI [-1.14, -0.64]  (run 5e2f10ce-18fc-4866-9537-fbafc50d69f4)

  [PASS] hallucination: Hallucination rate 0.00% is within the 2.00% ceiling.
  [FAIL] regression: Mean judge score regressed against baseline 5e2f10ce-…: diff -0.89, 95% CI [-1.14, -0.64] lies entirely below 0.
  [PASS] failed_items: All 20 attempted items produced a graded result.
  [PASS] coverage: 20 items scored.

Eval gate: FAIL
##[error]Process completed with exit code 1.
```

## What is worth noticing

**The grounding axis is what moved.** Grounding (`G`) scored 2/5 on 11 of the
20 items, while coverage (`C`) held at 4 or 5 on 16 of them: the v2 prompt
produced resumes that covered more of the posting and supported less of it.
That is the trade the prompt was implicitly making, and it is legible in the
run's own per-item table.

**The hallucination check still passed.** 0.00% — the model kept filling in
`fact_ids` even when told it was optional. A gate resting only on the
mechanical citation check would have let this through green. The bootstrap
comparison against a frozen baseline is what actually caught it, which is the
argument for having both.

**The gate does not fail on noise.** It fires only when the whole 95% CI of the
mean-score delta sits below zero. A prompt tweak worth ±0.2 with a CI of
[-0.5, +0.1] merges. This matters more than it sounds: a gate that goes red on
noise is a gate that gets disabled.

**A first run also taught us something.** Run
[33104598401](https://github.com/VVarrior1/applyops/actions/runs/33104598401)
lost one of twenty items to a Gemini capacity error ("This model is currently
experiencing high demand"). The failed-item check was zero-tolerance at the
time and went red on its own account. That is a false red — 19 items still make
a valid comparison — so the tolerance became a fraction (10% of attempted
items) before this branch was finished. A large fraction of failures still
fails, because a 40-item run where 37 items errored must not read like a clean
3-item run.

## Reproducing it

```bash
# locally, against the same golden set
npm run eval -- --step tailor --items 20 --gate    # exit 1 when the gate fails

# what CI runs on a PR
npm run eval -- --step tailor --items 20 --gate --git-sha "$SHA"

# what CI runs on main, re-stamping the baseline
npm run eval -- --step tailor --baseline --gate --git-sha "$SHA"
```
