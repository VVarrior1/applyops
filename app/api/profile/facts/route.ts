import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/src/auth/require";
import { getDb } from "@/src/db/client";
import { deleteFact, getConfirmedFacts, upsertFacts } from "@/src/profile/facts";
import { FACT_CATEGORIES } from "@/src/pipeline/schemas";

const factInputSchema = z.object({
  // Must match the exact `F-###` shape `formatFactLabel`/`maxFactLabelNumber`
  // produce and every pipeline prompt cites — an arbitrary string here (e.g.
  // "hello") would insert a row `maxFactLabelNumber` silently ignores when
  // numbering later facts, breaking the citation contract with no error.
  label: z.string().trim().regex(/^F-\d{3,}$/).optional(),
  category: z.enum(FACT_CATEGORIES),
  text: z.string().trim().min(1).max(2000),
  source: z.enum(["resume_upload", "manual"]).optional(),
});

const postBodySchema = z.union([
  // `upsertFacts` inserts row-by-row, so this bounds one request to a
  // reasonable number of round trips rather than an unbounded batch.
  z.object({ facts: z.array(factInputSchema).min(1).max(200) }),
  factInputSchema,
]);

const deleteBodySchema = z.object({ label: z.string().trim().min(1) });

/** `GET /api/profile/facts` — every confirmed fact for the signed-in user. */
export async function GET() {
  const user = await requireUser();
  const facts = await getConfirmedFacts(getDb(), user.id);
  return NextResponse.json({ facts });
}

/**
 * `POST /api/profile/facts` — plan Task 6 Step 3: saves reviewed facts with
 * `confirmed=true`. Accepts either `{facts: [...]}` (the onboarding review
 * step, confirming a whole batch at once) or a single fact object (the
 * Settings facts editor adding or editing one at a time). A fact carrying a
 * `label` is edited in place; one without gets a freshly assigned label.
 */
export async function POST(request: Request) {
  const user = await requireUser();

  const parsed = postBodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid fact payload." }, { status: 400 });
  }
  const facts = "facts" in parsed.data ? parsed.data.facts : [parsed.data];

  const saved = await upsertFacts(getDb(), user.id, facts);
  return NextResponse.json({ facts: saved }, { status: 201 });
}

/** `DELETE /api/profile/facts` — removes one fact by label. */
export async function DELETE(request: Request) {
  const user = await requireUser();

  const parsed = deleteBodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "A fact label is required." }, { status: 400 });
  }

  const removed = await deleteFact(getDb(), user.id, parsed.data.label);
  if (!removed) {
    return NextResponse.json({ error: "That fact doesn't exist." }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
