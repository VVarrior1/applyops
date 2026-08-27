import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/src/auth/require";
import { getDb } from "@/src/db/client";
import { logOutcome } from "@/src/funnel/outcomes";

const OUTCOME_TYPES = [
  "applied",
  "viewed",
  "response",
  "oa",
  "phone_screen",
  "interview",
  "offer",
  "rejected",
  "ghosted",
  "withdrawn",
] as const;

const bodySchema = z.object({
  type: z.enum(OUTCOME_TYPES),
  occurredAt: z.string().trim().datetime().optional(),
  notes: z.string().trim().max(2000).optional(),
});

/**
 * `POST /api/applications/:id/outcome` — plan Task 10 Step 2: the
 * `/applications` outcome buttons (Response · OA · Phone screen ·
 * Interview · Offer · Rejected · Ghosted · Withdrawn) each POST here. Logs
 * one `outcome_events` row and returns the recomputed `applications.status`.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid outcome event." }, { status: 400 });
  }

  const result = await logOutcome(getDb(), user.id, {
    applicationId: id,
    type: parsed.data.type,
    occurredAt: parsed.data.occurredAt ? new Date(parsed.data.occurredAt) : undefined,
    notes: parsed.data.notes,
  });

  if (!result) {
    return NextResponse.json({ error: "Application not found." }, { status: 404 });
  }

  return NextResponse.json(result, { status: 201 });
}
