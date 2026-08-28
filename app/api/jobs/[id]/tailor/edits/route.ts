import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "@/src/auth/require";
import { getDb } from "@/src/db/client";
import { generations } from "@/src/db/schema";
import {
  applyTailorEdits,
  countTailorBullets,
  tailorBulletPaths,
  type TailorUserEdits,
} from "@/src/pipeline/tailor-edits";
import { TailorOutput } from "@/src/pipeline/schemas";

// A real resume bullet is a line or two; a real tailor output is a handful
// of sections with a handful of bullets each. These are generous upper
// bounds, not tuned limits — they exist so a client can't write unbounded
// junk into the jsonb column, not to constrain a legitimate edit.
const MAX_BULLET_TEXT_LENGTH = 2000;
const MAX_EDIT_ENTRIES = 200;

const bodySchema = z.object({
  generationId: z.string().uuid(),
  userEdits: z.object({
    editedText: z
      .record(z.string(), z.string().max(MAX_BULLET_TEXT_LENGTH))
      .refine((obj) => Object.keys(obj).length <= MAX_EDIT_ENTRIES, {
        message: `Too many edited bullets (max ${MAX_EDIT_ENTRIES}).`,
      })
      .optional(),
    excludedPaths: z.array(z.string()).max(MAX_EDIT_ENTRIES).optional(),
  }),
});

/**
 * `PATCH /api/jobs/[id]/tailor/edits` — persists the Tailor tab's inline
 * edits (retyped bullet text, unchecked bullets) as the `tailor_edit`
 * overlay on the generation they belong to (`generations.user_edits`), so
 * they survive a tab switch, a refresh, and coming back to this job later.
 * Called from `TailorTab` on bullet blur/toggle, not on every keystroke.
 *
 * Overwrites the whole overlay each call — the client always sends its full
 * current diff against the original output, not an incremental patch, so
 * there is nothing to merge server-side.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  const { id: jobId } = await params;
  const db = getDb();

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid edit payload." }, { status: 400 });
  }
  const { generationId, userEdits } = parsed.data;

  const [gen] = await db
    .select({
      id: generations.id,
      userId: generations.userId,
      step: generations.step,
      jobId: generations.jobId,
      output: generations.output,
    })
    .from(generations)
    .where(eq(generations.id, generationId))
    .limit(1);
  if (!gen || gen.userId !== user.id || gen.step !== "tailor" || gen.jobId !== jobId) {
    return NextResponse.json(
      { error: "That tailoring run doesn't belong to this job." },
      { status: 400 },
    );
  }

  const output = TailorOutput.safeParse(gen.output);
  if (!output.success) {
    return NextResponse.json({ error: "That generation's output is malformed." }, { status: 500 });
  }

  // The only paths that can legitimately mean anything: a real (container,
  // bullet) pair in *this* generation's actual output — under `sections`,
  // `experience` or `projects` (`tailorBulletPaths`). A key/path outside
  // that set (stale, tampered, or referring to a bullet that never existed)
  // is dropped rather than stored — it would otherwise land in the jsonb
  // column unchanged and just sit there silently ignored by
  // `applyTailorEdits`.
  const validPaths = new Set(tailorBulletPaths(output.data));
  const sanitizedUserEdits: TailorUserEdits = {
    editedText: Object.fromEntries(
      Object.entries(userEdits.editedText ?? {}).filter(([path]) => validPaths.has(path)),
    ),
    excludedPaths: (userEdits.excludedPaths ?? []).filter((path) => validPaths.has(path)),
  };

  // Refuse an overlay that would leave nothing to tailor at all — the same
  // floor `stripUnsupportedBullets` implicitly enforces for hallucination
  // exclusions (an empty resume was never a state the pipeline could
  // reach); here it's a user-editable state, so it needs an explicit check.
  // Counted across the whole output, not just `sections`: since prompt
  // 1.2.0 a perfectly good tailor output has an empty `sections` and every
  // bullet under `experience`/`projects`, and checking `sections` alone
  // would reject that user's very first edit.
  const effective = applyTailorEdits(output.data, sanitizedUserEdits);
  if (countTailorBullets(effective) === 0) {
    return NextResponse.json(
      { error: "That would exclude every bullet — leave at least one." },
      { status: 400 },
    );
  }

  await db
    .update(generations)
    .set({ userEdits: sanitizedUserEdits })
    .where(eq(generations.id, generationId));

  return NextResponse.json({ ok: true });
}
