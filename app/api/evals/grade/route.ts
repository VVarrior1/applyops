/**
 * The grading UI's one endpoint (spec §7) — owner-only.
 *
 *   GET  ?itemId=…            → that item, or the next ungraded one, + progress
 *   POST {action:"generate"}  → generate & cache the sample this item is graded against
 *   POST {action:"save"}      → write `human_grades`, hand back the next item
 *
 * `GET` never generates: producing a sample costs money and mutates the item,
 * so it takes an explicit POST. That keeps a page refresh (or a prefetch) from
 * quietly spending the owner's daily budget.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq, lte, sql } from "drizzle-orm";
import { requireOwner } from "@/src/auth/require";
import { getDb, type Db } from "@/src/db/client";
import { evalItems, type Step } from "@/src/db/schema";
import {
  ensureSampleGeneration,
  gradingProgress,
  loadCachedSample,
  loadGoldenItem,
  nextUngradedItem,
  saveHumanGrades,
  type GoldenItem,
} from "@/src/eval/golden";
import { checkCitations } from "@/src/pipeline/hallucination";
import { factLabels } from "@/src/pipeline/steps";
import type { TailorOutput } from "@/src/pipeline/schemas";

const STEP: Step = "tailor";

const rubricScore = z.number().int().min(1).max(5);
const gradesSchema = z.object({
  grounding: rubricScore,
  coverage: rubricScore,
  specificity: rubricScore,
  stuffing_penalty: rubricScore,
});

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("generate"), itemId: z.string().uuid() }),
  z.object({
    action: z.literal("save"),
    itemId: z.string().uuid(),
    grades: gradesSchema,
    notes: z.string().max(4000).nullable().optional(),
  }),
]);

export interface GradeItemPayload {
  itemId: string;
  position: number;
  title: string;
  company: string;
  location: string | null;
  remote: boolean | null;
  description: string;
  facts: GoldenItem["facts"];
  humanGrades: GoldenItem["humanGrades"];
  notes: string | null;
  sample: {
    generationId: string;
    modelId: string;
    createdAt: string;
    output: TailorOutput;
    /** Mechanical citation check — the grounding axis's ground truth. */
    unsupportedPaths: string[];
    totalClaims: number;
  } | null;
}

/** 1-based position of an item in the set's stable (id-ordered) sequence. */
async function positionOf(db: Db, item: GoldenItem): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(evalItems)
    .where(and(eq(evalItems.step, item.step), lte(evalItems.id, item.itemId)));
  return Number(row?.count ?? 1);
}

async function toPayload(
  db: Db,
  item: GoldenItem,
  sample: Awaited<ReturnType<typeof ensureSampleGeneration>> | null,
): Promise<GradeItemPayload> {
  return {
    itemId: item.itemId,
    position: await positionOf(db, item),
    title: item.title,
    company: item.company,
    location: item.location,
    remote: item.remote,
    description: item.description,
    facts: item.facts,
    humanGrades: item.humanGrades,
    notes: item.notes,
    sample: sample
      ? (() => {
          const report = checkCitations(sample.output, factLabels(item.facts));
          return {
            generationId: sample.generationId,
            modelId: sample.modelId,
            createdAt: sample.createdAt,
            output: sample.output,
            unsupportedPaths: report.unsupported.map((claim) => claim.path),
            totalClaims: report.totalClaims,
          };
        })()
      : null,
  };
}

export async function GET(request: Request) {
  await requireOwner();
  const db = getDb();

  const url = new URL(request.url);
  const itemId = url.searchParams.get("itemId");
  const after = url.searchParams.get("after") ?? undefined;

  const item = itemId
    ? await loadGoldenItem(db, itemId)
    : await nextUngradedItem(db, STEP, after);
  const progress = await gradingProgress(db, STEP);

  if (!item) {
    return NextResponse.json({ progress, item: null });
  }

  return NextResponse.json({
    progress,
    item: await toPayload(db, item, await loadCachedSample(db, item)),
  });
}

export async function POST(request: Request) {
  const owner = await requireOwner();
  const db = getDb();

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
      { status: 400 },
    );
  }

  const item = await loadGoldenItem(db, parsed.data.itemId);
  if (!item) {
    return NextResponse.json({ error: "No such eval item" }, { status: 404 });
  }

  if (parsed.data.action === "generate") {
    try {
      // Owner's own budget — a web request never bypasses it (src/llm/budget.ts).
      const sample = await ensureSampleGeneration(db, item, { userId: owner.id });
      return NextResponse.json({
        progress: await gradingProgress(db, STEP),
        item: await toPayload(db, item, sample),
      });
    } catch (error) {
      return NextResponse.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Could not generate a sample for this item.",
        },
        { status: 502 },
      );
    }
  }

  await saveHumanGrades(db, {
    itemId: parsed.data.itemId,
    grades: parsed.data.grades,
    grader: owner.email,
    notes: parsed.data.notes ?? null,
  });

  const next = await nextUngradedItem(db, STEP);
  return NextResponse.json({
    progress: await gradingProgress(db, STEP),
    item: next ? await toPayload(db, next, await loadCachedSample(db, next)) : null,
  });
}
