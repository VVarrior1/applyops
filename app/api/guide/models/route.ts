import { NextResponse } from "next/server";
import { requireUser } from "@/src/auth/require";
import { buildModelOptions } from "@/src/guide/models";
import { DEFAULT_MODEL_BY_STEP } from "@/src/llm/defaults";
import { isProviderAvailable } from "@/src/llm/provider";

/**
 * `GET /api/guide/models` — the chat model picker's options.
 *
 * The list is computed server-side because availability is a server fact: it
 * depends on which provider keys exist in this deployment (spec §12 —
 * `OPENAI_API_KEY` is deliberately absent here), and a picker that offered a
 * model with no key would hand the user a 500 on send. Prices come from the
 * one pricing table (`src/llm/pricing.ts`) so the figures in the UI and the
 * figures charged against the daily budget can never disagree.
 */
export async function GET() {
  await requireUser();

  const models = buildModelOptions(isProviderAvailable);
  const fallback = DEFAULT_MODEL_BY_STEP.chat;

  return NextResponse.json({
    models,
    // The default only counts if its provider is actually configured;
    // otherwise the cheapest available model is what the picker should open on.
    defaultModelId:
      models.find((model) => model.id === fallback)?.id ?? models[0]?.id ?? null,
  });
}
