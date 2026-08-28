/**
 * Database access for the `/guide` page: the cached guide, the chat thread and
 * its messages, and the all-time funnel row the guide and the chat are both
 * grounded in.
 *
 * Everything user-owned here is filtered by `user_id` in application code (the
 * app connects with the service-role connection, which bypasses RLS — spec
 * §4), so every function takes the user id and none of them are reachable
 * without one.
 */

import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { chatMessages, chatThreads, guides } from "../db/schema";
import { deriveFunnel } from "../funnel/derive";
import { loadFunnelApplications } from "../funnel/query";
import { COST_DECIMALS } from "../llm/pricing";
import type { GuideFunnel } from "../pipeline/steps/guide";
import type { GuideOutput } from "../pipeline/schemas";

// ---------------------------------------------------------------------------
// guides
// ---------------------------------------------------------------------------

export interface GuideRecord {
  id: string;
  output: GuideOutput;
  modelId: string;
  generationId: string | null;
  createdAt: Date;
}

/** The newest guide for this user, or `null` if they have never generated one. */
export async function getLatestGuide(
  db: Db,
  userId: string,
): Promise<GuideRecord | null> {
  const [row] = await db
    .select({
      id: guides.id,
      output: guides.output,
      modelId: guides.modelId,
      generationId: guides.generationId,
      createdAt: guides.createdAt,
    })
    .from(guides)
    .where(eq(guides.userId, userId))
    .orderBy(desc(guides.createdAt))
    .limit(1);
  return row ?? null;
}

/** Append a freshly generated guide. Older rows are kept as history. */
export async function saveGuide(
  db: Db,
  args: {
    userId: string;
    output: GuideOutput;
    modelId: string;
    generationId?: string | null;
  },
): Promise<GuideRecord> {
  const [row] = await db
    .insert(guides)
    .values({
      userId: args.userId,
      output: args.output,
      modelId: args.modelId,
      generationId: args.generationId ?? null,
    })
    .returning({
      id: guides.id,
      output: guides.output,
      modelId: guides.modelId,
      generationId: guides.generationId,
      createdAt: guides.createdAt,
    });
  return row;
}

// ---------------------------------------------------------------------------
// chat
// ---------------------------------------------------------------------------

export interface ChatMessageRecord {
  id: string;
  role: "user" | "assistant";
  content: string;
  modelId: string | null;
  costUsd: number | null;
  createdAt: Date;
}

export interface ChatThreadRecord {
  id: string;
  modelId: string | null;
  createdAt: Date;
}

/** This user's thread, or `null` before they have sent a first message. */
export async function getThread(
  db: Db,
  userId: string,
): Promise<ChatThreadRecord | null> {
  const [row] = await db
    .select({
      id: chatThreads.id,
      modelId: chatThreads.modelId,
      createdAt: chatThreads.createdAt,
    })
    .from(chatThreads)
    .where(eq(chatThreads.userId, userId))
    .orderBy(desc(chatThreads.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * The user's thread, created on first use. v1 gives each user exactly one
 * (the schema is thread-based so "new conversation" is a later feature, not a
 * later migration). The chosen model is written back on every turn so a reload
 * restores the picker to what they last used.
 */
export async function getOrCreateThread(
  db: Db,
  userId: string,
  modelId: string,
): Promise<ChatThreadRecord> {
  const existing = await getThread(db, userId);
  if (existing) {
    if (existing.modelId !== modelId) {
      await db
        .update(chatThreads)
        .set({ modelId })
        .where(eq(chatThreads.id, existing.id));
    }
    return { ...existing, modelId };
  }

  const [row] = await db
    .insert(chatThreads)
    .values({ userId, modelId, title: "Career guide" })
    .returning({
      id: chatThreads.id,
      modelId: chatThreads.modelId,
      createdAt: chatThreads.createdAt,
    });
  return row;
}

/** Every message in a thread, oldest first. Ownership is checked by the join. */
export async function listMessages(
  db: Db,
  userId: string,
  threadId: string,
): Promise<ChatMessageRecord[]> {
  const rows = await db
    .select({
      id: chatMessages.id,
      role: chatMessages.role,
      content: chatMessages.content,
      modelId: chatMessages.modelId,
      costUsd: chatMessages.costUsd,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .innerJoin(chatThreads, eq(chatMessages.threadId, chatThreads.id))
    .where(and(eq(chatMessages.threadId, threadId), eq(chatThreads.userId, userId)))
    .orderBy(asc(chatMessages.createdAt));

  return rows.map((row) => ({
    ...row,
    costUsd: row.costUsd == null ? null : Number(row.costUsd),
  }));
}

/** Convenience for the page: the thread and its messages in one round trip shape. */
export async function loadConversation(
  db: Db,
  userId: string,
): Promise<{ thread: ChatThreadRecord | null; messages: ChatMessageRecord[] }> {
  const thread = await getThread(db, userId);
  if (!thread) return { thread: null, messages: [] };
  return { thread, messages: await listMessages(db, userId, thread.id) };
}

export interface SaveChatMessageArgs {
  threadId: string;
  role: "user" | "assistant";
  content: string;
  modelId?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
}

/** Persist one turn. Cost is stored to the same 6 decimals as `generations`. */
export async function saveChatMessage(
  db: Db,
  args: SaveChatMessageArgs,
): Promise<{ id: string }> {
  const [row] = await db
    .insert(chatMessages)
    .values({
      threadId: args.threadId,
      role: args.role,
      content: args.content,
      modelId: args.modelId ?? null,
      inputTokens: args.inputTokens ?? null,
      outputTokens: args.outputTokens ?? null,
      costUsd:
        args.costUsd == null ? null : args.costUsd.toFixed(COST_DECIMALS),
    })
    .returning({ id: chatMessages.id });
  return row;
}

// ---------------------------------------------------------------------------
// funnel
// ---------------------------------------------------------------------------

/**
 * This user's all-time funnel row, or `null` when they have not applied to
 * anything. Same derivation the `/funnel` page uses (spec §4: derived from
 * `outcome_events`, never stored) — `deriveFunnel` with `groupBy: "all"`
 * returns at most one row.
 */
export async function loadUserFunnel(
  db: Db,
  userId: string,
): Promise<GuideFunnel | null> {
  // Non-placeholder applications only — see src/funnel/query.ts on why a
  // v1-migration orphan application must never inflate the guide's funnel
  // (it must agree with /funnel and the public /results page).
  const funnelApplications = await loadFunnelApplications(db, userId);
  if (funnelApplications.length === 0) return null;

  const [row] = deriveFunnel(funnelApplications, { groupBy: "all" });

  if (!row) return null;
  return {
    applied: row.applied,
    responded: row.responded,
    interviewing: row.interviewing,
    offers: row.offers,
    rejected: row.rejected,
    ghosted: row.ghosted,
    responseRate: row.responseRate,
    interviewRate: row.interviewRate,
  };
}
