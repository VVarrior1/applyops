import { NextResponse } from "next/server";
import { requireUser } from "@/src/auth/require";
import { getDb } from "@/src/db/client";
import { loadUserFunnel, saveGuide } from "@/src/guide/store";
import { DEFAULT_MODEL_BY_STEP } from "@/src/llm/defaults";
import { LlmError } from "@/src/llm/model-id";
import { runGuide } from "@/src/pipeline/steps";
import { getConfirmedFacts, getPrefs } from "@/src/profile/facts";

/**
 * `POST /api/guide` — the "Regenerate" button on `/guide`.
 *
 * Runs the `guide` step over the user's confirmed facts, their targets and
 * their real funnel, then caches the result in `guides`. Budget enforcement,
 * the `generations` row and the retry/repair envelope all come from
 * `callStructured()` underneath `runGuide` — this route only assembles the
 * inputs and stores the answer.
 *
 * The *checked* guide is what gets stored: claims whose `fact_ids` could not
 * be traced back to a confirmed fact are stripped first, exactly as unsupported
 * bullets are kept out of a tailored PDF (spec §5). The raw reply stays in
 * `generations.output`.
 */
export async function POST() {
  const user = await requireUser();
  const db = getDb();

  const [facts, prefs, funnel] = await Promise.all([
    getConfirmedFacts(db, user.id),
    getPrefs(db, user.id),
    loadUserFunnel(db, user.id),
  ]);

  if (facts.length === 0) {
    return NextResponse.json(
      {
        error:
          "You have no confirmed resume facts yet. Finish onboarding first — a guide written with nothing to go on is worthless.",
      },
      { status: 409 },
    );
  }

  try {
    const { checked, hallucination, generationId, costUsd } = await runGuide(db, {
      facts,
      prefs,
      funnel,
      userId: user.id,
    });

    const saved = await saveGuide(db, {
      userId: user.id,
      output: checked,
      modelId: DEFAULT_MODEL_BY_STEP.guide,
      generationId,
    });

    return NextResponse.json({
      guide: {
        id: saved.id,
        output: saved.output,
        modelId: saved.modelId,
        createdAt: saved.createdAt.toISOString(),
      },
      hallucination,
      costUsd,
    });
  } catch (err) {
    if (err instanceof LlmError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status ?? 500 },
      );
    }
    throw err;
  }
}
