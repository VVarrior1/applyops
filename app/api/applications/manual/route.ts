import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/src/auth/require";
import { getDb } from "@/src/db/client";
import { createManualApplication } from "@/src/funnel/manual-application";

const bodySchema = z.object({
  url: z.string().trim().url(),
  company: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1).optional(),
  location: z.string().trim().min(1).optional(),
  // ISO date or full ISO datetime; defaults to now. Validated below (a
  // bare "2026-08-28" is a valid Date but not a valid z.string().datetime()).
  appliedAt: z.string().trim().min(1).optional(),
  notes: z.string().trim().max(2000).optional(),
  status: z.enum(["applied", "responded", "interviewing", "offer", "rejected"]).optional(),
});

function parseAppliedAt(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * `POST /api/applications/manual` — the "Add application" dialog's submit
 * (`components/applications/AddApplicationDialog.tsx`): tracks an
 * application the user made outside the app (spec: "let a user track
 * applications they made OUTSIDE the app"). Shares its write path with
 * `applyops outcome add` via `createManualApplication`
 * (`src/funnel/manual-application.ts`), which is idempotent on
 * (user_id, job_id) — a repeat submission for a URL already tracked
 * returns the existing application with `existing: true` and HTTP 200
 * instead of erroring or duplicating it.
 */
export async function POST(request: Request) {
  const user = await requireUser();

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "A valid job URL is required." }, { status: 400 });
  }
  const body = parsed.data;

  const appliedAt = parseAppliedAt(body.appliedAt);
  if (body.appliedAt && !appliedAt) {
    return NextResponse.json({ error: `"${body.appliedAt}" is not a valid date.` }, { status: 400 });
  }

  const result = await createManualApplication(getDb(), user.id, {
    url: body.url,
    company: body.company,
    title: body.title,
    location: body.location,
    appliedAt,
    notes: body.notes,
    status: body.status,
  });

  return NextResponse.json(result, { status: result.existing ? 200 : 201 });
}
