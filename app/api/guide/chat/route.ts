import { NextResponse } from "next/server";
import {
  convertToModelMessages,
  streamText,
  type LanguageModel,
  type UIMessage,
} from "ai";
import { requireUser } from "@/src/auth/require";
import { getDb } from "@/src/db/client";
import { generations } from "@/src/db/schema";
import { buildChatSystemPrompt } from "@/src/guide/context";
import { resolveChatModel } from "@/src/guide/models";
import {
  getLatestGuide,
  getOrCreateThread,
  loadUserFunnel,
  saveChatMessage,
} from "@/src/guide/store";
import { checkBudget, recordUsage } from "@/src/llm/budget";
import { ESTIMATED_OUTPUT_TOKENS, normalizeUsage } from "@/src/llm/call";
import { DEFAULT_MODEL_BY_STEP } from "@/src/llm/defaults";
import { LlmError, type ModelId } from "@/src/llm/model-id";
import { COST_DECIMALS, estimateCost, estimateTokens } from "@/src/llm/pricing";
import { isProviderAvailable, resolveModel } from "@/src/llm/provider";
import { ensurePromptVersion, loadPrompt } from "@/src/pipeline/prompt-versions";
import { getConfirmedFacts, getPrefs } from "@/src/profile/facts";

/** Vercel's streaming functions need a ceiling; a coach answer is seconds. */
export const maxDuration = 60;

/**
 * How many prior turns are replayed to the model. The system prompt already
 * carries the facts, targets, guide and funnel, so older turns add cost far
 * faster than they add context — and an unbounded history is an unbounded bill
 * on a per-message budget (spec §11).
 */
const MAX_HISTORY_MESSAGES = 20;

/** Cap on one user message. Long enough to paste a job posting, not a novel. */
const MAX_MESSAGE_CHARS = 8_000;

/** Metadata streamed to the client so each reply can show what it cost. */
export interface ChatMessageMetadata {
  modelId?: string;
  costUsd?: number;
}

/** The text a UI message carries, joined across its text parts. */
function textOf(message: UIMessage | undefined): string {
  if (!message) return "";
  return message.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
}

/**
 * `POST /api/guide/chat` — one turn of the grounded career-coach conversation.
 *
 * Grounding is the whole point: the system prompt is rebuilt on every request
 * from the user's confirmed facts, their targets, the guide they have already
 * generated and their real funnel, so the model is answering about *this*
 * person and can cite fact labels the user can check.
 *
 * The cost envelope mirrors `callStructured()` without being able to reuse it
 * (that function is built around a structured, non-streaming reply): the daily
 * budget is checked before a token is spent, and when the stream finishes the
 * real usage is costed, written to `generations` (step `chat`) and added to
 * `usage_daily`.
 */
export async function POST(request: Request) {
  const user = await requireUser();
  const db = getDb();

  let body: { messages?: UIMessage[]; modelId?: string };
  try {
    body = (await request.json()) as { messages?: UIMessage[]; modelId?: string };
  } catch {
    return NextResponse.json({ error: "Malformed request body." }, { status: 400 });
  }

  const incoming = Array.isArray(body.messages) ? body.messages : [];
  const latest = incoming[incoming.length - 1];
  const question = textOf(latest);

  if (!latest || latest.role !== "user" || !question) {
    return NextResponse.json(
      { error: "Send a question as the last message." },
      { status: 400 },
    );
  }
  if (question.length > MAX_MESSAGE_CHARS) {
    return NextResponse.json(
      { error: `Keep a message under ${MAX_MESSAGE_CHARS} characters.` },
      { status: 413 },
    );
  }

  const modelId: ModelId = resolveChatModel(
    body.modelId,
    DEFAULT_MODEL_BY_STEP.chat,
    isProviderAvailable,
  );

  const [facts, prefs, guide, funnel] = await Promise.all([
    getConfirmedFacts(db, user.id),
    getPrefs(db, user.id),
    getLatestGuide(db, user.id),
    loadUserFunnel(db, user.id),
  ]);

  const system = buildChatSystemPrompt({
    basePrompt: loadPrompt("chat").content,
    facts,
    prefs,
    guide: guide?.output ?? null,
    funnel,
  });

  const history = incoming.slice(-MAX_HISTORY_MESSAGES);

  // ---- budget gate (before a single token is spent) ------------------------
  const estimate = estimateCost(modelId, {
    inputTokens: estimateTokens(
      `${system}\n${history.map((message) => textOf(message)).join("\n")}`,
    ),
    outputTokens: ESTIMATED_OUTPUT_TOKENS,
  });
  const decision = await checkBudget(db, user.id, estimate);
  if (!decision.allowed) {
    return NextResponse.json(
      { error: decision.reason ?? "Daily AI budget reached.", code: "budget_exceeded" },
      { status: 429 },
    );
  }

  // `resolveChatModel` already rejected an unconfigured provider, but the key
  // could have been pulled between that check and this one — resolve here so
  // the failure is a clean 4xx naming the missing variable, not a provider 401.
  let model: LanguageModel;
  try {
    model = resolveModel(modelId);
  } catch (err) {
    if (err instanceof LlmError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status ?? 500 },
      );
    }
    throw err;
  }

  const promptVersionId = await ensurePromptVersion(db, "chat");
  const thread = await getOrCreateThread(db, user.id, modelId);
  await saveChatMessage(db, {
    threadId: thread.id,
    role: "user",
    content: question,
  });

  const startedAt = Date.now();

  const result = streamText({
    model,
    system,
    messages: await convertToModelMessages(history),
    // Retries are the AI SDK's here rather than our own loop: a streaming
    // response has already begun writing bytes, so `callStructured()`'s
    // retry-and-repair envelope does not apply.
    maxRetries: 2,
    onEnd: async ({ text, usage }) => {
      // Bookkeeping must never take the user's answer down with it: the reply
      // has already streamed by this point.
      try {
        const tokens = normalizeUsage(usage);
        const costUsd = estimateCost(modelId, tokens);

        await db.insert(generations).values({
          userId: user.id,
          step: "chat",
          promptVersionId,
          modelId,
          inputTokens: tokens.inputTokens,
          outputTokens: tokens.outputTokens,
          costUsd: costUsd.toFixed(COST_DECIMALS),
          latencyMs: Math.max(0, Date.now() - startedAt),
          output: { text },
          error: null,
        });

        await saveChatMessage(db, {
          threadId: thread.id,
          role: "assistant",
          content: text,
          modelId,
          inputTokens: tokens.inputTokens,
          outputTokens: tokens.outputTokens,
          costUsd,
        });

        await recordUsage(db, user.id, costUsd);
      } catch (err) {
        console.error("guide chat: failed to record a finished turn", err);
      }
    },
  });

  return result.toUIMessageStreamResponse<UIMessage<ChatMessageMetadata>>({
    messageMetadata: ({ part }) => {
      if (part.type === "start") return { modelId };
      if (part.type === "finish") {
        return {
          modelId,
          costUsd: estimateCost(modelId, normalizeUsage(part.totalUsage)),
        };
      }
      return undefined;
    },
  });
}
